/**
 * macro-engine.js - Random macro resolution engine
 *
 * Handles:
 *   - Weighted random selection with trigger probability
 *   - Nested macro resolution (recursive, with cycle detection)
 *   - Pin/unpin support (pinned macros skip re-roll)
 *   - Result caching per chat round
 */

import { getMacroById } from './storage.js';
import { MAX_NESTING_DEPTH } from './constants.js';

// ── Weighted random ───────────────────────────────────────────────────────────

/**
 * Select one option from a weighted list.
 * @param {Array<{text: string, weight: number}>} options
 * @returns {string|null}
 */
function weightedRandom(options) {
    if (!options || options.length === 0) return null;
    
    const totalWeight = options.reduce((sum, o) => sum + (Number(o.weight) || 1), 0);
    if (totalWeight <= 0) return options[0]?.text || null;
    
    let rand = Math.random() * totalWeight;
    for (const option of options) {
        rand -= (Number(option.weight) || 1);
        if (rand <= 0) return option.text;
    }
    return options[options.length - 1]?.text || null;
}

// ── Core resolution ───────────────────────────────────────────────────────────

/**
 * Resolve a single macro by ID, selecting a random option.
 * Returns empty string if the macro doesn't trigger (probability check).
 *
 * @param {string} macroId
 * @param {Map<string, string>} cache - Already-resolved macro values for this session
 * @param {string[]} callStack - For cycle detection
 * @returns {string}
 */
function resolveMacro(macroId, cache, callStack) {
    // Use cached value if available
    if (cache.has(macroId)) {
        return cache.get(macroId);
    }
    
    // Cycle detection
    if (callStack.includes(macroId)) {
        console.warn(`[Random Engine] Cycle detected: ${callStack.join(' → ')} → ${macroId}`);
        return `[循环引用: ${macroId}]`;
    }
    
    // Nesting depth guard
    if (callStack.length >= MAX_NESTING_DEPTH) {
        console.warn(`[Random Engine] Max nesting depth (${MAX_NESTING_DEPTH}) reached at macro "${macroId}"`);
        return `[嵌套过深: ${macroId}]`;
    }
    
    const macro = getMacroById(macroId);
    if (!macro) {
        console.warn(`[Random Engine] Macro not found: "${macroId}"`);
        return `[未找到宏: ${macroId}]`;
    }
    
    // Trigger probability check (0-100)
    const prob = Number(macro.triggerProbability);
    if (!isNaN(prob) && prob < 100) {
        if (Math.random() * 100 > prob) {
            cache.set(macroId, '');
            return '';
        }
    }
    
    // Select a weighted option
    const selected = weightedRandom(macro.options || []);
    if (selected === null) {
        cache.set(macroId, '');
        return '';
    }
    
    // Recursively resolve any nested macros in the selected text
    const newStack = [...callStack, macroId];
    const resolved = resolveTemplate(selected, cache, newStack);
    
    cache.set(macroId, resolved);
    return resolved;
}

/**
 * Resolve all {{random_xxx}} placeholders in a template string.
 *
 * @param {string} template
 * @param {Map<string, string>} cache
 * @param {string[]} callStack
 * @returns {string}
 */
function resolveTemplate(template, cache, callStack = []) {
    if (!template || typeof template !== 'string') return template || '';
    
    // Replace all {{random_xxx}} occurrences
    return template.replace(/\{\{random_([^}]+)\}\}/g, (match, macroId) => {
        return resolveMacro(macroId.trim(), cache, callStack);
    });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a group's injection template, respecting pinned macros.
 *
 * @param {Object} group - MacroGroup object
 * @param {Object} groupChatState - Runtime state for this group from chatMetadata
 * @param {boolean} forceReroll - If true, ignore existing currentValues and re-roll everything
 * @returns {{ resolved: string, newValues: Object }}
 */
export function resolveGroupTemplate(group, groupChatState, forceReroll = false) {
    const pinnedMacros = new Set(groupChatState.pinnedMacros || []);
    const existingValues = groupChatState.currentValues || {};
    
    // Build a cache pre-seeded with pinned and existing values
    const cache = new Map();
    
    if (!forceReroll) {
        // Seed cache with existing resolved values (keeps them stable)
        for (const [macroId, value] of Object.entries(existingValues)) {
            cache.set(macroId, value);
        }
    } else {
        // Only keep pinned values when force-rolling
        for (const macroId of pinnedMacros) {
            if (existingValues[macroId] !== undefined) {
                cache.set(macroId, existingValues[macroId]);
            }
        }
    }
    
    // Resolve the template
    const resolved = resolveTemplate(group.template || '', cache);
    
    // Collect all new values from cache
    const newValues = {};
    for (const [macroId, value] of cache.entries()) {
        newValues[macroId] = value;
    }
    
    return { resolved, newValues };
}

/**
 * Roll (or re-roll) specific macros in a group, leaving others untouched.
 *
 * @param {string[]} macroIds - Which macros to re-roll
 * @param {Object} groupChatState
 * @returns {Object} Updated currentValues
 */
export function rollMacros(macroIds, groupChatState) {
    const cache = new Map(Object.entries(groupChatState.currentValues || {}));
    const pinnedMacros = new Set(groupChatState.pinnedMacros || []);
    
    for (const macroId of macroIds) {
        if (pinnedMacros.has(macroId)) continue; // skip pinned
        cache.delete(macroId); // force re-resolve
        resolveMacro(macroId, cache, []);
    }
    
    const newValues = {};
    for (const [k, v] of cache.entries()) newValues[k] = v;
    return newValues;
}

/**
 * Resolve a template string with all currently cached macro values from a group state.
 * Used for preview display in the UI.
 *
 * @param {string} template
 * @param {Object} currentValues - Map of macroId → resolved string
 * @returns {string}
 */
export function previewTemplate(template, currentValues) {
    const cache = new Map(Object.entries(currentValues || {}));
    return resolveTemplate(template, cache);
}
