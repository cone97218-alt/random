/**
 * injection.js - Prompt injection layer for the random macro extension
 *
 * Injects resolved macro content into SillyTavern's context for each enabled group,
 * respecting lifecycle rules (everyXRounds, keepYRounds) and depth/role specifications.
 */

import { getContext } from '../../../../../extensions.js';
import { setExtensionPrompt } from '../../../../../../script.js';
import { getActiveGroups, getGroupChatState, getChatState, saveChatState, getSettings } from './storage.js';
import { resolveGroupTemplate } from './macro-engine.js';
import { ROLE } from './constants.js';

/**
 * Retrieve the setExtensionPrompt function from context or module import.
 */
function getSetExtensionPromptFn() {
    const ctx = getContext();
    if (typeof ctx?.setExtensionPrompt === 'function') return ctx.setExtensionPrompt;
    if (typeof setExtensionPrompt === 'function') return setExtensionPrompt;
    return null;
}

// ── Lifecycle helpers ─────────────────────────────────────────────────────────

/**
 * Determine the effective lifecycle config for a group, merging global defaults.
 * @param {Object} group
 * @returns {{ everyXRounds: number|null, keepYRounds: number|null }}
 */
function getEffectiveLifecycle(group) {
    const globalLifecycle = getSettings().globalLifecycle || {};
    const lc = group.lifecycle || {};
    
    if (lc.useGlobal !== false) {
        return {
            everyXRounds: globalLifecycle.everyXRounds ?? null,
            keepYRounds: globalLifecycle.keepYRounds ?? null,
        };
    }
    return {
        everyXRounds: lc.everyXRounds ?? null,
        keepYRounds: lc.keepYRounds ?? null,
    };
}

/**
 * Determine if we should inject this group on the current round, and whether to re-roll.
 *
 * @param {Object} groupState - Runtime state for this group
 * @param {{ everyXRounds: number|null, keepYRounds: number|null }} lifecycle
 * @returns {{ shouldInject: boolean, shouldReroll: boolean }}
 */
function checkLifecycle(groupState, lifecycle) {
    const { everyXRounds, keepYRounds } = lifecycle;
    
    // ── Check injection frequency (everyXRounds) ──────────────────────────────
    if (everyXRounds !== null && everyXRounds > 0) {
        groupState.roundsSinceLastInjection = (groupState.roundsSinceLastInjection || 0) + 1;
        if (groupState.roundsSinceLastInjection < everyXRounds) {
            return { shouldInject: false, shouldReroll: false };
        }
        // Reset counter when we do inject
        groupState.roundsSinceLastInjection = 0;
    }
    
    // ── Check keep duration (keepYRounds) ─────────────────────────────────────
    let shouldReroll = true;
    if (keepYRounds !== null && keepYRounds > 0) {
        const counter = groupState.injectionCounter || 0;
        if (counter < keepYRounds) {
            // Still within keep window: reuse existing values
            shouldReroll = false;
            groupState.injectionCounter = counter + 1;
        } else {
            // Exceeded keep window: re-roll and reset counter
            shouldReroll = true;
            groupState.injectionCounter = 0;
        }
    } else {
        // No keepYRounds: always re-roll
        shouldReroll = true;
        groupState.injectionCounter = 0;
    }
    
    return { shouldInject: true, shouldReroll };
}

// ── Main injection handler ────────────────────────────────────────────────────

/**
 * Called on GENERATION_STARTED / GENERATE_BEFORE_COMBINE_PROMPTS.
 * For each active enabled group, compute the injection text and register it
 * with SillyTavern's setExtensionPrompt.
 */
export function injectRandomMacros() {
    const setPrompt = getSetExtensionPromptFn();
    if (!setPrompt) {
        console.error('[Random Injection] setExtensionPrompt function is not available in SillyTavern context!');
        return;
    }

    const activeGroups = getActiveGroups();
    
    if (activeGroups.length === 0) {
        return;
    }
    
    let injectedCount = 0;
    for (const group of activeGroups) {
        try {
            const success = injectGroup(group, setPrompt);
            if (success) injectedCount++;
        } catch (e) {
            console.error(`[Random Injection] Failed to inject group "${group.name}":`, e);
        }
    }
    
    // Persist updated chat state
    saveChatState();
    console.log(`[Random Injection] Finished: ${injectedCount}/${activeGroups.length} groups injected into context.`);
}

/**
 * Handle injection for a single group.
 * @param {Object} group
 * @param {Function} setPrompt
 * @returns {boolean} Whether content was injected
 */
function injectGroup(group, setPrompt) {
    const groupState = getGroupChatState(group.id);
    const lifecycle = getEffectiveLifecycle(group);
    const { shouldInject, shouldReroll } = checkLifecycle(groupState, lifecycle);
    
    const promptKey = `random_group_${group.id}`;

    if (!shouldInject) {
        // Clear any previous injection for this group
        setPrompt(promptKey, '', -1, 0);
        console.debug(`[Random Injection] Group "${group.name}": skipped by lifecycle rule`);
        return false;
    }
    
    // Resolve the template (re-roll or reuse)
    const { resolved, newValues } = resolveGroupTemplate(group, groupState, shouldReroll);
    
    if (shouldReroll) {
        groupState.currentValues = newValues;
    }
    
    if (!resolved || !resolved.trim()) {
        setPrompt(promptKey, '', -1, 0);
        console.debug(`[Random Injection] Group "${group.name}": resolved text is empty`);
        return false;
    }
    
    // Map role string/number to ST's numeric role: 0 = system, 1 = user, 2 = assistant
    const roleNum = mapRole(group.injectionRole);
    
    // In SillyTavern:
    // extension_prompt_types: NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2
    // For in-chat depth injection, position MUST be 1 (IN_CHAT).
    const position = group.injectionPosition !== undefined && group.injectionPosition !== null
        ? Number(group.injectionPosition)
        : 1; // Default to IN_CHAT (1) for depth prompt injection

    const depth = Number.isFinite(Number(group.injectionDepth))
        ? Math.max(0, Math.floor(Number(group.injectionDepth)))
        : 4;
    
    try {
        setPrompt(
            promptKey,
            resolved.trim(),
            position,
            depth,
            false,   // scan
            roleNum
        );
        console.log(`[Random Injection] ✅ Injected group "${group.name}" (depth=${depth}, role=${roleNum}, pos=${position}):\n"${resolved.trim()}"`);
        return true;
    } catch (e) {
        console.warn('[Random Injection] setExtensionPrompt failed:', e);
        return false;
    }
}

/**
 * Map a role value (0/1/2 or string) to the ST numeric role param.
 * @param {number|string} role
 * @returns {number}
 */
function mapRole(role) {
    if (typeof role === 'number') {
        if ([0, 1, 2].includes(role)) return role;
    }
    const str = String(role || '').toLowerCase().trim();
    if (str === 'user' || str === '1') return ROLE.USER;
    if (str === 'assistant' || str === 'bot' || str === 'char' || str === '2') return ROLE.ASSISTANT;
    return ROLE.SYSTEM; // 0
}

/**
 * Clear all random macro injections (e.g., when extension is disabled or chat switched).
 */
export function clearAllInjections() {
    const setPrompt = getSetExtensionPromptFn();
    if (!setPrompt) return;
    const groups = getActiveGroups();
    for (const group of groups) {
        try {
            setPrompt(`random_group_${group.id}`, '', -1, 0);
        } catch {}
    }
}

/**
 * Handle a new round (AI message received). Increments the total round counter
 * in chatMetadata so lifecycle rules can be evaluated correctly.
 */
export function onRoundComplete() {
    const chatState = getChatState();
    chatState.totalRounds = (chatState.totalRounds || 0) + 1;
    saveChatState();
}

