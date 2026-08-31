/**
 * prompt-builder.js
 *
 * Robust context reader and pipeline builder for SillyTavern AI generation.
 * Deep integration with ST's official getCharacterCardFields() and world-info.js engine.
 */

import { getContext } from '../../../../../extensions.js';
import { substituteParams, getCharacterCardFields } from '../../../../../../script.js';
import { getSettings } from './storage.js';
import { DEFAULT_PROMPT_COMPONENTS } from './constants.js';

// ── Context readers ───────────────────────────────────────────────────────────

let _cachedWI = { before: '', after: '', depth: '', ts: 0 };

async function _evaluateWorldInfo(userPrompt) {
    const now = Date.now();
    // Cache for 1 second to avoid redundant scans
    if (now - _cachedWI.ts < 1000) {
        return _cachedWI;
    }

    try {
        const ctx = getContext();
        const rawChat = ctx.chat || [];
        const maxContext = Number(ctx.maxContext) || 4096;

        let getWorldInfoPrompt = null;
        let formatWorldInfo = null;

        // Correct relative path: 5 levels up to /scripts/
        try {
            const wiModule = await import('../../../../../world-info.js');
            getWorldInfoPrompt = wiModule.getWorldInfoPrompt;
        } catch (e) {
            console.warn('[Random Prompt] Import world-info.js error:', e);
        }

        try {
            const oaiModule = await import('../../../../../openai.js');
            formatWorldInfo = oaiModule.formatWorldInfo;
        } catch (e) {
            console.warn('[Random Prompt] Import openai.js error:', e);
        }

        if (typeof getWorldInfoPrompt === 'function') {
            const cardFields = typeof getCharacterCardFields === 'function' ? getCharacterCardFields() : {};

            // 1. Build chat string array in reverse order (most recent first)
            const chatForWI = [];

            // Include user current input at depth 0 so triggers in input match
            if (userPrompt && userPrompt.trim()) {
                const uName = ctx.name1 || 'User';
                chatForWI.push(`${uName}: ${userPrompt.trim()}`);
            }

            // Include chat history messages (excluding system messages)
            for (let i = rawChat.length - 1; i >= 0; i--) {
                const msg = rawChat[i];
                if (!msg || msg.is_system) continue;
                const text = msg.name ? `${msg.name}: ${msg.mes || ''}` : (msg.mes || '');
                chatForWI.push(text);
            }

            // 2. Global scan data
            const globalScanData = {
                personaDescription: cardFields.persona || '',
                characterDescription: cardFields.description || '',
                characterPersonality: cardFields.personality || '',
                characterDepthPrompt: cardFields.charDepthPrompt || '',
                scenario: cardFields.scenario || '',
                creatorNotes: cardFields.creatorNotes || '',
                trigger: 'normal',
            };

            console.debug('[Random Prompt] Triggering getWorldInfoPrompt scan with messages count:', chatForWI.length);
            const wiResult = await getWorldInfoPrompt(chatForWI, maxContext, false, globalScanData);

            let beforeRaw = wiResult?.worldInfoBefore || '';
            let afterRaw = wiResult?.worldInfoAfter || '';
            let depthRaw = '';

            // Handle entries configured at Depth
            if (Array.isArray(wiResult?.worldInfoDepth) && wiResult.worldInfoDepth.length > 0) {
                depthRaw = wiResult.worldInfoDepth
                    .map(d => Array.isArray(d.entries) ? d.entries.join('\n') : '')
                    .filter(Boolean)
                    .join('\n');
            }

            // Handle Authors Note entries
            if (Array.isArray(wiResult?.anBefore) && wiResult.anBefore.length > 0) {
                const anJoined = wiResult.anBefore.join('\n');
                if (anJoined) beforeRaw = beforeRaw ? `${beforeRaw}\n${anJoined}` : anJoined;
            }
            if (Array.isArray(wiResult?.anAfter) && wiResult.anAfter.length > 0) {
                const anJoined = wiResult.anAfter.join('\n');
                if (anJoined) afterRaw = afterRaw ? `${afterRaw}\n${anJoined}` : anJoined;
            }

            // Fallback
            if (!beforeRaw && !afterRaw && !depthRaw && wiResult?.worldInfoString) {
                beforeRaw = wiResult.worldInfoString;
            }

            const beforeFormatted = formatWorldInfo ? formatWorldInfo(beforeRaw) : beforeRaw;
            const afterFormatted = formatWorldInfo ? formatWorldInfo(afterRaw) : afterRaw;
            const depthFormatted = formatWorldInfo ? formatWorldInfo(depthRaw) : depthRaw;

            console.debug('[Random Prompt] WorldInfo scan resolved:', { before: beforeFormatted, after: afterFormatted, depth: depthFormatted });

            _cachedWI = {
                before: beforeFormatted || '',
                after:  afterFormatted || '',
                depth:  depthFormatted || '',
                ts: now,
            };
            return _cachedWI;
        }
    } catch (e) {
        console.warn('[Random Prompt] WorldInfo evaluation error:', e);
    }
    return { before: '', after: '', depth: '', ts: now };
}

function _readMainChatHistory(x, regexStr, regexReplace = '') {
    try {
        const ctx = getContext();
        const chat = ctx.chat;
        if (!Array.isArray(chat) || chat.length === 0) return [];

        const count = (x > 0) ? x : 10;
        const slice = chat.slice(-count);

        let regex = null;
        if (regexStr) {
            try { regex = new RegExp(regexStr, 'gm'); } catch (_) {}
        }

        return slice.map(msg => {
            let content = (msg.mes || '').replace(/\r/gm, '');
            if (regex) content = content.replace(regex, regexReplace);
            if (msg.name) content = `${msg.name}: ${content}`;
            return { role: msg.is_user ? 'user' : 'assistant', content };
        });
    } catch (_) { return []; }
}

// ── Main builder ──────────────────────────────────────────────────────────────

/**
 * Build the full messages[] array for one AI generation request.
 *
 * @param {string} userPrompt            - Current user input text
 * @param {Array}  extChatHistory        - Extension chat history turns
 * @returns {Promise<{ role: string, content: string }[]>}
 */
export async function buildMessages(userPrompt, extChatHistory = []) {
    const s = getSettings();
    const components = (s.aiPromptComponents || DEFAULT_PROMPT_COMPONENTS)
        .filter(c => c.enabled !== false)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Retrieve official SillyTavern character card & persona fields in one canonical call
    let cardFields = {};
    try {
        if (typeof getCharacterCardFields === 'function') {
            cardFields = getCharacterCardFields();
        }
    } catch (e) {
        console.warn('[Random Prompt] getCharacterCardFields error:', e);
    }

    // Pre-evaluate World Info if any WI component is enabled
    const hasWI = components.some(c =>
        c.builtinKey === 'world_info_before' ||
        c.builtinKey === 'world_info_after' ||
        c.builtinKey === 'world_info_depth'
    );
    let wiData = { before: '', after: '', depth: '' };
    if (hasWI) {
        wiData = await _evaluateWorldInfo(userPrompt);
    }

    const messages = [];

    for (const comp of components) {
        // 1. ST main chat history
        if (comp.builtinKey === 'chat_history') {
            const histMsgs = _readMainChatHistory(
                comp.chatHistoryX ?? 10,
                comp.regex || null,
                comp.regexReplace || '',
            );
            messages.push(...histMsgs);
            continue;
        }

        // 2. World Info at Depth
        if (comp.builtinKey === 'world_info_depth') {
            if (wiData.depth && wiData.depth.trim()) {
                messages.push({ role: comp.role || 'system', content: wiData.depth.trim() });
            }
            continue;
        }

        // 3. Extension's own multi-turn history
        if (comp.builtinKey === 'ext_chat_history') {
            for (const turn of extChatHistory) {
                if (!turn.prompt) continue;
                messages.push({ role: 'user', content: turn.prompt });
                const reply = turn.swipes?.[turn.activeIndex];
                if (reply) messages.push({ role: 'assistant', content: reply });
            }
            continue;
        }

        // 4. Current user input
        if (comp.builtinKey === 'ext_user_input') {
            if (userPrompt) messages.push({ role: 'user', content: userPrompt });
            continue;
        }

        // 5. World Info Before / After
        if (comp.builtinKey === 'world_info_before') {
            if (wiData.before && wiData.before.trim()) {
                messages.push({ role: comp.role || 'system', content: wiData.before.trim() });
            }
            continue;
        }
        if (comp.builtinKey === 'world_info_after') {
            if (wiData.after && wiData.after.trim()) {
                messages.push({ role: comp.role || 'system', content: wiData.after.trim() });
            }
            continue;
        }

        // 6. Card & Persona fields and Custom / Modular Functional Text
        let content = '';
        switch (comp.builtinKey) {
            case 'persona':
                content = cardFields.persona || '';
                break;
            case 'char_desc':
                content = cardFields.description || '';
                break;
            case 'char_personality':
                content = cardFields.personality || '';
                break;
            case 'scenario':
                content = cardFields.scenario || '';
                break;
            default:
                content = substituteParams(comp.content || '');
                break;
        }

        if (content && content.trim()) {
            messages.push({ role: comp.role || 'system', content: content.trim() });
        }
    }

    return messages;
}
