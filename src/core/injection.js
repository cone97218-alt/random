/**
 * injection.js - Prompt injection layer for the random macro extension
 *
 * Injects resolved macro content into SillyTavern's context for each enabled group,
 * respecting lifecycle rules (everyXRounds, keepYRounds) and depth/role specifications.
 *
 * ── Lifecycle model ─────────────────────────────────────────────────────────────
 * State: groupState.roundInCycle  (0-indexed position within the X-round cycle)
 *
 * With everyXRounds=5, keepYRounds=2:
 *   Cycle pos 0 → inject (new Roll)
 *   Cycle pos 1 → inject (keep / reuse)
 *   Cycle pos 2 → skip
 *   Cycle pos 3 → skip
 *   Cycle pos 4 → skip
 *   pos advances each time MESSAGE_RECEIVED fires, wraps at everyXRounds
 *
 * With keepYRounds only (no everyXRounds):
 *   Same pattern but cycle length = keepYRounds (always injects, re-rolls every Y rounds)
 *
 * With neither: inject every round, re-roll every round.
 * ────────────────────────────────────────────────────────────────────────────────
 */

import { getContext } from '../../../../../extensions.js';
import { setExtensionPrompt } from '../../../../../../script.js';
import { getActiveGroups, getAllGroups, getGroupChatState, getChatState, saveChatState, getSettings } from './storage.js';
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
 * Reads groupState.roundInCycle (set by onRoundComplete, not modified here).
 *
 * @param {Object} groupState - Runtime state for this group
 * @param {{ everyXRounds: number|null, keepYRounds: number|null }} lifecycle
 * @returns {{ shouldInject: boolean, shouldReroll: boolean }}
 */
function checkLifecycle(groupState, lifecycle) {
    const { everyXRounds, keepYRounds } = lifecycle;
    const pos = groupState.roundInCycle ?? 0;

    const hasX = everyXRounds !== null && everyXRounds > 0;
    const hasY = keepYRounds !== null && keepYRounds > 0;

    if (hasX && everyXRounds > 1) {
        // Periodic injection: inject for keepY rounds at the start of each X-round cycle
        const injectWindow = hasY ? Math.min(keepYRounds, everyXRounds) : 1;
        if (pos >= injectWindow) {
            return { shouldInject: false, shouldReroll: false };
        }
        // pos 0 = first round of window → re-roll; pos 1..Y-1 = keep
        return { shouldInject: true, shouldReroll: pos === 0 };
    }

    if (hasY && keepYRounds > 1) {
        // No period, but keep Y rounds: inject every round, re-roll every Y rounds
        return { shouldInject: true, shouldReroll: pos === 0 };
    }

    // No lifecycle constraints: inject every round, always re-roll
    return { shouldInject: true, shouldReroll: true };
}

// ── Active Prompt Key Registry (O(1) tracking) ────────────────────────────────
// Tracks currently active injected keys by group: groupId -> promptKey
const _injectedGroupKeys = new Map();

/**
 * Clear injection prompt(s) for a specific group from SillyTavern context.
 * @param {string} groupId
 */
export function clearGroupInjection(groupId) {
    if (!groupId) return;
    const setPrompt = getSetExtensionPromptFn();
    const prevKey = _injectedGroupKeys.get(groupId);
    if (prevKey) {
        if (setPrompt) {
            try { setPrompt(prevKey, '', -1, 0); } catch {}
        }
        _injectedGroupKeys.delete(groupId);
    }
}

/**
 * Check if a group currently has an active injection in SillyTavern prompt.
 * @param {string} groupId
 * @returns {boolean}
 */
export function isGroupInjected(groupId) {
    return _injectedGroupKeys.has(groupId);
}

/**
 * Force a group to inject on the very next generation by resetting its cycle position to 0.
 * Optionally re-rolls content immediately.
 * @param {string} groupId
 */
export function forceNextInjection(groupId) {
    const groupState = getGroupChatState(groupId);
    groupState.roundInCycle = 0;
    saveChatState();
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
    const activeGroupIds = new Set(activeGroups.map(g => g.id));

    // O(k) cleanup: only check groups previously registered by this extension
    for (const [gid, key] of _injectedGroupKeys.entries()) {
        if (!activeGroupIds.has(gid)) {
            try { setPrompt(key, '', -1, 0); } catch {}
            _injectedGroupKeys.delete(gid);
        }
    }

    if (activeGroups.length === 0) {
        return;
    }

    const chatState = getChatState();
    if (!chatState.exclusivePools) {
        chatState.exclusivePools = {};
    }

    // Partition groups into independent groups and exclusive pools
    const independentGroups = [];
    const poolMap = new Map(); // poolName -> Array of MacroGroup

    for (const group of activeGroups) {
        const poolName = (group.exclusivePool || '').trim();
        if (poolName) {
            if (!poolMap.has(poolName)) poolMap.set(poolName, []);
            poolMap.get(poolName).push(group);
        } else {
            independentGroups.push(group);
        }
    }

    let injectedCount = 0;

    // 1. Inject independent groups
    for (const group of independentGroups) {
        try {
            const success = injectGroup(group, setPrompt);
            if (success) injectedCount++;
        } catch (e) {
            console.error(`[Random Injection] Failed to inject group "${group.name}":`, e);
        }
    }

    // 2. Handle exclusive pools (pick exactly 1 group per pool per round/cycle)
    for (const [poolName, poolGroups] of poolMap.entries()) {
        const enabledGroups = poolGroups.filter(g => g.enabled !== false);
        if (enabledGroups.length === 0) {
            for (const g of poolGroups) {
                clearGroupInjection(g.id);
            }
            continue;
        }

        const poolState = chatState.exclusivePools[poolName] || {};
        let activeGroupId = poolState.activeGroupId;
        let chosenGroup = enabledGroups.find(g => g.id === activeGroupId);

        // Check if the currently chosen group is still valid and in keep window
        let shouldPickNew = false;
        if (!chosenGroup) {
            shouldPickNew = true;
        } else {
            const gState = getGroupChatState(chosenGroup.id);
            const pos = gState.roundInCycle ?? 0;
            // If pos === 0, it's a new cycle / re-roll point
            if (pos === 0) {
                shouldPickNew = true;
            }
        }

        if (shouldPickNew) {
            chosenGroup = enabledGroups[Math.floor(Math.random() * enabledGroups.length)];
            poolState.activeGroupId = chosenGroup.id;
            chatState.exclusivePools[poolName] = poolState;
        }

        // Inject the chosen group
        try {
            const success = injectGroup(chosenGroup, setPrompt);
            if (success) injectedCount++;
        } catch (e) {
            console.error(`[Random Injection] Failed to inject pool group "${chosenGroup.name}":`, e);
        }

        // Mute / clear other groups in the same pool
        for (const g of poolGroups) {
            if (g.id !== chosenGroup.id) {
                clearGroupInjection(g.id);
                const otherState = getGroupChatState(g.id);
                otherState.lastInjected = {
                    injected: false,
                    text: '',
                    skipped: true,
                    reason: `互斥池「${poolName}」未抽中 (本轮生效: ${chosenGroup.name})`,
                    round: getChatState().totalRounds || 0,
                    timestamp: Date.now(),
                };
            }
        }
    }

    // Persist updated chat state
    saveChatState();
    console.log(`[Random Injection] Finished: ${injectedCount}/${activeGroups.length} groups processed into context.`);
}

/**
 * Handle injection for a single group.
 * @param {Object} group
 * @param {Function} setPrompt
 * @returns {boolean} Whether content was injected
 */
function injectGroup(group, setPrompt) {
    if (!group || group.enabled === false) {
        clearGroupInjection(group?.id);
        return false;
    }

    const groupState = getGroupChatState(group.id);
    const lifecycle = getEffectiveLifecycle(group);
    const { shouldInject, shouldReroll } = checkLifecycle(groupState, lifecycle);

    const order = Number.isFinite(Number(group.injectionOrder))
        ? Math.max(0, Math.floor(Number(group.injectionOrder)))
        : 0;
    const orderStr = String(order).padStart(5, '0');
    const promptKey = `random_group_${orderStr}_${group.id}`;

    // Clean up if order or key changed for this group
    const prevKey = _injectedGroupKeys.get(group.id);
    if (prevKey && prevKey !== promptKey) {
        try { setPrompt(prevKey, '', -1, 0); } catch {}
    }

    if (!shouldInject) {
        // Clear any previous injection for this group
        clearGroupInjection(group.id);
        groupState.lastInjected = {
            injected: false,
            text: '',
            skipped: true,
            reason: '周期冷却跳过',
            round: getChatState().totalRounds || 0,
            timestamp: Date.now(),
        };
        console.debug(`[Random Injection] Group "${group.name}": skipped by lifecycle rule (pos=${groupState.roundInCycle ?? 0})`);
        return false;
    }

    // Resolve the template (re-roll or reuse)
    const { resolved, newValues } = resolveGroupTemplate(group, groupState, shouldReroll);

    if (shouldReroll) {
        groupState.currentValues = newValues;
    }

    if (!resolved || !resolved.trim()) {
        clearGroupInjection(group.id);
        groupState.lastInjected = {
            injected: false,
            text: '',
            skipped: true,
            reason: '模板解析为空',
            round: getChatState().totalRounds || 0,
            timestamp: Date.now(),
        };
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
        _injectedGroupKeys.set(group.id, promptKey);
        groupState.lastInjected = {
            injected: true,
            text: resolved.trim(),
            role: roleNum,
            depth,
            order,
            round: getChatState().totalRounds || 0,
            timestamp: Date.now(),
        };
        console.log(`[Random Injection] ✅ Injected group "${group.name}" (depth=${depth}, order=${order}, role=${roleNum}, pos=${position}, cyclePos=${groupState.roundInCycle ?? 0}):\n"${resolved.trim()}"`);
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
    if (setPrompt) {
        for (const key of _injectedGroupKeys.values()) {
            try { setPrompt(key, '', -1, 0); } catch {}
        }
    }
    _injectedGroupKeys.clear();
}

/**
 * Called on MESSAGE_RECEIVED (AI reply received). Advances cycle position for each
 * active group according to their lifecycle settings, and increments totalRounds.
 */
export function onRoundComplete() {
    const chatState = getChatState();
    chatState.totalRounds = (chatState.totalRounds || 0) + 1;

    // Advance roundInCycle for every enabled group based on their lifecycle
    const allGroups = getAllGroups();
    for (const group of allGroups) {
        if (!group.enabled) continue;
        try {
            const groupState = getGroupChatState(group.id);
            const lifecycle = getEffectiveLifecycle(group);
            const { everyXRounds, keepYRounds } = lifecycle;

            const hasX = everyXRounds !== null && everyXRounds > 0;
            const hasY = keepYRounds !== null && keepYRounds > 0;

            let cycleLen = 1;
            if (hasX && everyXRounds > 1) {
                cycleLen = everyXRounds;
            } else if (hasY && keepYRounds > 1) {
                cycleLen = keepYRounds;
            }

            const cur = groupState.roundInCycle ?? 0;
            groupState.roundInCycle = cycleLen > 1 ? (cur + 1) % cycleLen : 0;
            console.log(`[Random Lifecycle] Group "${group.name}" advanced: roundInCycle ${cur} -> ${groupState.roundInCycle} (cycleLen=${cycleLen})`);
        } catch (e) {
            console.warn(`[Random Injection] onRoundComplete: error advancing group "${group.id}":`, e);
        }
    }

    saveChatState();
}
