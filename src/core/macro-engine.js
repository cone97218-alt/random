/**
 * macro-engine.js - Random macro resolution engine
 *
 * Handles:
 *   - Weighted random selection with trigger probability
 *   - Nested macro resolution (recursive, with cycle detection)
 *   - Pin/unpin support (pinned macros skip re-roll)
 *   - Result caching per chat round
 */

import { getMacroById, getSettings } from './storage.js';
import { MAX_NESTING_DEPTH } from './constants.js';

// ── Weighted random ───────────────────────────────────────────────────────────

/**
 * Select one option from a weighted list, with optional exclusion of the previously selected option.
 * @param {Array<{text: string, weight: number}>} options
 * @param {string} [excludeText] - Avoid picking this text if other options are available
 * @returns {string|null}
 */
function weightedRandom(options, excludeText = null) {
    if (!options || options.length === 0) return null;
    
    // Filter out the previously selected option to avoid consecutive repeats
    let pool = options;
    if (excludeText && options.length > 1) {
        const filtered = options.filter(o => o.text !== excludeText);
        if (filtered.length > 0) {
            pool = filtered;
        }
    }

    const totalWeight = pool.reduce((sum, o) => sum + (Number(o.weight) || 1), 0);
    if (totalWeight <= 0) return pool[0]?.text || null;
    
    let rand = Math.random() * totalWeight;
    for (const option of pool) {
        rand -= (Number(option.weight) || 1);
        if (rand <= 0) return option.text;
    }
    return pool[pool.length - 1]?.text || null;
}

// Memory map to track the last chosen option text per macro ID
const _lastChosenOptionMap = new Map();

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
    
    // Select a weighted option (avoiding consecutive duplicate of last roll if enabled)
    const avoidRepetition = getSettings().misc?.avoidRepetition !== false;
    const prevOption = avoidRepetition ? (_lastChosenOptionMap.get(macroId) || null) : null;
    const selected = weightedRandom(macro.options || [], prevOption);
    if (selected === null) {
        cache.set(macroId, '');
        return '';
    }

    // Record last chosen raw option
    _lastChosenOptionMap.set(macroId, selected);
    
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
    
    // Ensure all defined macros in this group have a resolved value
    if (Array.isArray(group.macros)) {
        for (const macroId of group.macros) {
            if (!cache.has(macroId)) {
                resolveMacro(macroId, cache, []);
            }
        }
    }
    
    // Collect all new values from cache
    const newValues = {};
    for (const [macroId, value] of cache.entries()) {
        newValues[macroId] = value;
    }
    
    return { resolved, newValues };
}

/**
 * Roll (or re-roll) specific macros in a group, cascading updates to dependent parent macros.
 *
 * @param {string[]} macroIds - Which macros to re-roll
 * @param {Object} groupChatState
 * @param {Object} [group] - Optional group to cascade parent re-resolutions
 * @returns {Object} Updated currentValues
 */
export function rollMacros(macroIds, groupChatState, group = null) {
    const cache = new Map(Object.entries(groupChatState.currentValues || {}));
    const pinnedMacros = new Set(groupChatState.pinnedMacros || []);
    const rerolledSet = new Set(macroIds.filter(id => !pinnedMacros.has(id)));
    
    for (const macroId of rerolledSet) {
        cache.delete(macroId);
    }

    // Invalidate any parent macros that reference the re-rolled macros
    if (group && Array.isArray(group.macros)) {
        for (const mId of group.macros) {
            if (pinnedMacros.has(mId)) continue;
            const macro = getMacroById(mId);
            if (macro && macro.options) {
                const referencesRerolled = macro.options.some(opt => {
                    const text = typeof opt === 'string' ? opt : (opt.text || '');
                    return [...rerolledSet].some(targetId => text.includes(`{{random_${targetId}}}`));
                });
                if (referencesRerolled) {
                    cache.delete(mId);
                }
            }
        }
    }
    
    // Re-resolve target macros
    for (const macroId of macroIds) {
        if (pinnedMacros.has(macroId)) continue;
        resolveMacro(macroId, cache, []);
    }

    // Re-resolve group template if available
    if (group && group.template) {
        resolveTemplate(group.template, cache);
    }
    
    const newValues = {};
    for (const [k, v] of cache.entries()) newValues[k] = v;
    return newValues;
}

/**
 * Resolve a template string with all currently cached macro values from a group state.
 * Used for preview display in the UI. Strictly deterministic — never rolls new random values.
 *
 * @param {string} template
 * @param {Object} currentValues - Map of macroId → resolved string
 * @returns {string}
 */
export function previewTemplate(template, currentValues) {
    if (!template) return '';
    const values = currentValues || {};
    let text = template;
    let prev;
    let iterations = 0;
    do {
        prev = text;
        text = text.replace(/\{\{random_([^}]+)\}\}/g, (match, macroId) => {
            const id = macroId.trim();
            return values[id] !== undefined ? values[id] : match;
        });
        iterations++;
    } while (text !== prev && iterations < 10);
    return text;
}
