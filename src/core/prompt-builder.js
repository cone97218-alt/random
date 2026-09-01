/**
 * prompt-builder.js
 *
 * Robust context reader and pipeline builder for SillyTavern AI generation.
 * Deep integration with ST's official getCharacterCardFields() and world-info.js engine.
 */

import { getContext } from '../../../../../extensions.js';
import { substituteParams, getCharacterCardFields } from '../../../../../../script.js';
import { getSettings, getAllGroups, getMacroById } from './storage.js';
import { DEFAULT_PROMPT_COMPONENTS, ROLE_LABELS } from './constants.js';

// ── Context readers ───────────────────────────────────────────────────────────

let _cachedWI = { before: '', after: '', depth: '', ts: 0 };

/**
 * Format one or multiple existing macro groups into structured reference data for AI prompt.
 * @param {string|string[]} groupIds
 * @returns {string}
 */
export function formatExistingGroupForPrompt(groupIds) {
    if (!groupIds) return '';
    const idArray = Array.isArray(groupIds) ? groupIds : [groupIds];
    const validIds = idArray.filter(Boolean);
    if (validIds.length === 0) return '';

    const allGroups = getAllGroups();
    const targetGroups = validIds.map(id => allGroups.find(g => g.id === id)).filter(Boolean);
    if (targetGroups.length === 0) return '';

    const lines = [];
    if (targetGroups.length === 1) {
        lines.push(`【用户注入的待参考/整理已有宏配置组】`);
    } else {
        lines.push(`【用户注入的待参考/合并/整理的已有宏配置组（共 ${targetGroups.length} 个）】`);
    }

    targetGroups.forEach((group, gIdx) => {
        if (targetGroups.length > 1) {
            lines.push(`\n=== 宏组 #${gIdx + 1}：【${group.name || '未命名组'}】 ===`);
        } else {
            lines.push(`- 宏组名称: ${group.name || '未命名组'}`);
        }
        if (group.category) lines.push(`- 宏组分类: ${group.category}`);
        const roleLabel = ROLE_LABELS[group.injectionRole ?? 0] || 'System';
        lines.push(`- 注入身份与深度: ${roleLabel} / 深度 ${group.injectionDepth ?? 4}`);
        lines.push(`- 注入提示词模板:`);
        lines.push(group.template ? group.template : '(空模板)');
        lines.push(`- 包含的宏定义及全部候选项明细:`);

        const macroIds = group.macros || [];
        if (macroIds.length === 0) {
            lines.push(`  (该组暂无关联宏定义)`);
        } else {
            macroIds.forEach(mId => {
                const macro = getMacroById(mId);
                if (!macro) {
                    lines.push(`  * 宏 {{random_${mId}}}: (未找到定义)`);
                    return;
                }
                lines.push(`  * 宏 {{random_${macro.id}}} (触发概率: ${macro.triggerProbability ?? 100}%):`);
                const options = macro.options || [];
                if (options.length === 0) {
                    lines.push(`    - (暂无候选项)`);
                } else {
                    options.forEach((opt, idx) => {
                        const tagStr = opt.tag ? ` [标签: ${opt.tag}]` : '';
                        const weightStr = (opt.weight && opt.weight !== 1) ? ` [权重: ${opt.weight}]` : '';
                        lines.push(`    - 选项 ${idx + 1}: ${opt.text || ''}${weightStr}${tagStr}`);
                    });
                }
            });
        }
    });

    return lines.join('\n');
}

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

async function _buildMessagesFromPreset(userPrompt, extChatHistory, injectedRefText, options) {
    const messages = [];

    try {
        const ctx = getContext();
        const { prepareOpenAIMessages, setOpenAIMessages, setOpenAIMessageExamples } = await import('../../../../../openai.js');
        const { characters, this_chid, name2 } = await import('../../../../../script.js');

        const char = (characters && this_chid !== undefined && characters[this_chid]) ? characters[this_chid] : {};
        const charData = char.data || {};
        const rawChat = ctx.chat || [];

        const [presetChat] = await prepareOpenAIMessages({
            name2: name2 || char.name || 'Assistant',
            charDescription: char.description || charData.description || '',
            charPersonality: char.personality || charData.personality || '',
            scenario: char.scenario || charData.scenario || '',
            worldInfoBefore: '',
            worldInfoAfter: '',
            bias: '',
            type: 'normal',
            quietPrompt: '',
            quietImage: '',
            extensionPrompts: {},
            cyclePrompt: '',
            systemPromptOverride: '',
            jailbreakPromptOverride: '',
            messages: typeof setOpenAIMessages === 'function' ? setOpenAIMessages(rawChat) : [],
            messageExamples: typeof setOpenAIMessageExamples === 'function'
                ? setOpenAIMessageExamples(charData.mes_example ? [charData.mes_example] : [])
                : [],
        }, false);

        if (Array.isArray(presetChat) && presetChat.length > 0) {
            presetChat.forEach(msg => {
                let text = '';
                if (typeof msg.content === 'string') {
                    text = msg.content;
                } else if (Array.isArray(msg.content)) {
                    text = msg.content.map(c => c.text || '').join('');
                }
                if (text && text.trim()) {
                    messages.push({ role: msg.role || 'system', content: text.trim() });
                }
            });
        }
    } catch (err) {
        console.warn('[Random Prompt] prepareOpenAIMessages from preset failed, falling back:', err);
    }

    // Append macro system task specification & injected macro group context
    const taskSpec = [
        '【随机宏引擎生成任务】',
        '你是一个SillyTavern随机宏引擎专家助手。请根据上述上下文设定与用户指令生成随机宏或宏配置组：',
        '- 宏标识 id 统一使用直观中文（如 `天气`、`角色动作`），引用格式固定为 `{{random_宏名}}`。',
        '- 宏配置组完整设计：直接输出标准 JSON（含 isFullGroup: true, groupName: "组名", template: "提示词模板", injectionRole: 0, injectionDepth: 4, macros: [ { id, triggerProbability, options: [ { text, weight } ] } ]）。',
        '- 单宏候选项生成：每行输出一个文本候选项。',
    ];

    if (injectedRefText) {
        taskSpec.push('\n' + injectedRefText);
    }

    messages.push({ role: 'system', content: taskSpec.join('\n') });

    // Multi-turn extension chat history
    if (Array.isArray(extChatHistory) && extChatHistory.length > 0) {
        extChatHistory.forEach(turn => {
            if (turn.prompt) messages.push({ role: 'user', content: turn.prompt });
            const aiReply = turn.swipes?.[turn.activeIndex];
            if (aiReply) messages.push({ role: 'assistant', content: aiReply });
        });
    }

    // Current user prompt
    if (userPrompt) {
        messages.push({ role: 'user', content: userPrompt });
    }

    return messages;
}

/**
 * Build the full messages[] array for one AI generation request.
 *
 * @param {string} userPrompt            - Current user input text
 * @param {Array}  extChatHistory        - Extension chat history turns
 * @param {Object} [options]             - Optional generation options (e.g. injectedGroupId)
 * @returns {Promise<{ role: string, content: string }[]>}
 */
export async function buildMessages(userPrompt, extChatHistory = [], options = {}) {
    const s = getSettings();
    const promptMode = s.aiPromptMode || 'components';

    const injectedIds = options.injectedGroupIds || options.injectedGroupId || [];
    const injectedRefText = formatExistingGroupForPrompt(injectedIds);

    if (promptMode === 'preset') {
        return await _buildMessagesFromPreset(userPrompt, extChatHistory, injectedRefText, options);
    }

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

        // 4. Current user input & Injected group context
        if (comp.builtinKey === 'ext_user_input') {
            const injectedIds = options?.injectedGroupIds
                ? (Array.isArray(options.injectedGroupIds) ? options.injectedGroupIds : [options.injectedGroupIds])
                : (options?.injectedGroupId ? [options.injectedGroupId] : []);

            if (injectedIds.length > 0) {
                const groupContext = formatExistingGroupForPrompt(injectedIds);
                if (groupContext) {
                    const isMulti = injectedIds.length > 1;
                    const hintMsg = isMulti
                        ? `【多宏组整合与重构指令提示】\n请以上述注入的 ${injectedIds.length} 个已有宏配置组作为核心参考数据，根据接下来的用户需求执行合并、交叉重组、精简去重、拆分二级嵌套宏或规划统一主注入模板。若用户要求合并或重构宏组，请按照规范输出标准 JSON 格式，以便系统直接解析和一键导入。`
                        : `【整理与重构指令提示】\n请以上述注入的已有宏配置组作为核心参考数据，根据接下来的用户需求执行整理、精简去重、扩充候选项、拆分二级嵌套宏或重构主模板。若用户要求重构宏组，请按照规范输出标准 JSON 格式，以便系统直接解析和一键导入。`;

                    messages.push({
                        role: 'system',
                        content: `${groupContext}\n\n${hintMsg}`,
                    });
                }
            }
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
