/**
 * storage.js - Persistence layer for the random macro extension
 *
 * Two storage areas:
 *   1. extension_settings['random'] - global macro definitions + panel settings
 *   2. chatMetadata['random']       - per-chat runtime state (current values, counters)
 */

import { getContext, extension_settings } from '../../../../../extensions.js';
import { MODULE_NAME, DEFAULT_LIFECYCLE, DEFAULT_PANEL, DEFAULT_MISC, DEFAULT_PROMPT_COMPONENTS } from './constants.js';

// ── Settings helpers ──────────────────────────────────────────────────────────

/**
 * Get (and lazily initialize) the global extension settings object.
 * @returns {Object}
 */
export function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = createDefaultSettings();
    }
    // Ensure misc settings exist
    if (!extension_settings[MODULE_NAME].misc) {
        extension_settings[MODULE_NAME].misc = { ...DEFAULT_MISC };
    }
    // Ensure aiPromptComponents array exists if loaded from older settings version
    if (!extension_settings[MODULE_NAME].aiPromptComponents || !Array.isArray(extension_settings[MODULE_NAME].aiPromptComponents)) {
        extension_settings[MODULE_NAME].aiPromptComponents = DEFAULT_PROMPT_COMPONENTS.map(c => ({ ...c }));
    }
    return extension_settings[MODULE_NAME];
}

function createDefaultSettings() {
    return {
        version: '1.0.0',
        /** @type {MacroDef[]} */
        macros: [],
        /** @type {MacroGroup[]} */
        groups: [],
        globalLifecycle: { ...DEFAULT_LIFECYCLE },
        panel: { ...DEFAULT_PANEL },
        misc: { ...DEFAULT_MISC },
        // Prompt component pipeline for AI generation (deep clone to avoid mutation)
        aiPromptComponents: DEFAULT_PROMPT_COMPONENTS.map(c => ({ ...c })),
    };
}

/**
 * Save extension settings with debounce.
 */
export function saveSettings() {
    try {
        getContext().saveSettingsDebounced?.();
    } catch (e) {
        console.error('[Random Storage] Failed to save settings:', e);
    }
}

// ── ChatMetadata helpers ──────────────────────────────────────────────────────

/**
 * Get the random runtime state from the current chat's metadata.
 * @returns {Object}
 */
export function getChatState() {
    const ctx = getContext();
    if (!ctx.chatMetadata) return createDefaultChatState();
    if (!ctx.chatMetadata[MODULE_NAME]) {
        ctx.chatMetadata[MODULE_NAME] = createDefaultChatState();
    }
    return ctx.chatMetadata[MODULE_NAME];
}

function createDefaultChatState() {
    return {
        /**
         * Per-group runtime state.
         * Key: group ID
         * Value: { currentValues, injectionCounter, roundsSinceLastInjection, pinnedMacros }
         */
        groups: {},
        /** Total message round count in this chat (incremented on each AI message received) */
        totalRounds: 0,
    };
}

/**
 * Get (or lazily create) runtime state for a specific group.
 * @param {string} groupId
 * @returns {Object}
 */
export function getGroupChatState(groupId) {
    const chatState = getChatState();
    if (!chatState.groups[groupId]) {
        chatState.groups[groupId] = {
            /**
             * The macro values chosen for the most-recent injection.
             * Key: macro ID, Value: resolved string
             */
            currentValues: {},
            /**
             * How many rounds this injection has been kept (reused) without re-rolling.
             * Resets to 0 when a new roll happens.
             */
            injectionCounter: 0,
            /**
             * How many rounds since the last injection event for this group.
             * Used to implement "inject every X rounds".
             */
            roundsSinceLastInjection: 0,
            /**
             * Set of macro IDs that the user has pinned (will not be re-rolled).
             * @type {string[]}
             */
            pinnedMacros: [],
        };
    }
    return chatState.groups[groupId];
}

/**
 * Persist the current chat state back into chatMetadata.
 */
export function saveChatState() {
    try {
        const ctx = getContext();
        if (ctx.chatMetadata && typeof ctx.saveChat === 'function') {
            // ST saves chatMetadata when the chat is saved
            ctx.saveChat?.();
        }
    } catch (e) {
        console.error('[Random Storage] Failed to save chat state:', e);
    }
}

/**
 * Clear the current chat runtime state from chatMetadata.
 */
export function clearChatState() {
    const ctx = getContext();
    if (ctx.chatMetadata) {
        ctx.chatMetadata[MODULE_NAME] = createDefaultChatState();
        saveChatState();
    }
}

// ── CRUD for Macros ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} MacroOption
 * @property {string} text - Option content (may include nested {{random_xxx}})
 * @property {number} weight - Relative weight for selection (default: 1)
 * @property {string} [tag] - Optional category tag
 */

/**
 * @typedef {Object} MacroDef
 * @property {string} id - Macro identifier (used in {{random_id}})
 * @property {number} triggerProbability - 0-100, chance this macro produces output at all
 * @property {MacroOption[]} options
 */

export function getAllMacros() {
    return getSettings().macros || [];
}

export function getMacroById(id) {
    if (!id) return null;
    const target = String(id).trim().toLowerCase();
    return getAllMacros().find(m => String(m.id).trim().toLowerCase() === target) || null;
}

export function saveMacro(macro) {
    const s = getSettings();
    if (!s.macros) s.macros = [];
    const idx = s.macros.findIndex(m => String(m.id).trim().toLowerCase() === String(macro.id).trim().toLowerCase());
    if (idx !== -1) {
        s.macros[idx] = macro;
    } else {
        s.macros.push(macro);
    }
    saveSettings();
}

export function deleteMacro(id) {
    const s = getSettings();
    const target = String(id).trim().toLowerCase();
    s.macros = (s.macros || []).filter(m => String(m.id).trim().toLowerCase() !== target);
    saveSettings();
}

// ── CRUD for Groups ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} LifecycleConfig
 * @property {boolean} useGlobal - If true, fall back to globalLifecycle
 * @property {number|null} everyXRounds
 * @property {number|null} keepYRounds
 */

/**
 * @typedef {Object} MacroGroup
 * @property {string} id
 * @property {string} name
 * @property {string} scope - 'global' | 'character:<charId>'
 * @property {boolean} enabled
 * @property {number} injectionDepth
 * @property {number} [injectionOrder=0] - Sort order for prompt injection (lower numbers injected first)
 * @property {number} injectionRole - 0=system, 1=user, 2=assistant
 * @property {string} template - Injection text with {{random_xxx}} placeholders
 * @property {string[]} macros - Array of macro IDs referenced by this group
 * @property {LifecycleConfig} lifecycle
 */

export function getAllGroups() {
    return getSettings().groups || [];
}

export function getGroupById(id) {
    if (!id) return null;
    const target = String(id).trim().toLowerCase();
    return getAllGroups().find(g => String(g.id).trim().toLowerCase() === target) || null;
}

export function saveGroup(group) {
    const s = getSettings();
    if (!s.groups) s.groups = [];
    const idx = s.groups.findIndex(g => String(g.id).trim().toLowerCase() === String(group.id).trim().toLowerCase());
    if (idx !== -1) {
        s.groups[idx] = group;
    } else {
        s.groups.push(group);
    }
    saveSettings();
}

export function deleteGroup(id) {
    const s = getSettings();
    const target = String(id).trim().toLowerCase();
    s.groups = (s.groups || []).filter(g => String(g.id).trim().toLowerCase() !== target);
    saveSettings();
}

/**
 * Get groups visible in the current context (global + character-scoped for current char).
 * @returns {MacroGroup[]}
 */
export function getActiveGroups() {
    const ctx = getContext();
    const charId = ctx.characterId !== undefined && ctx.characterId !== null ? String(ctx.characterId) : null;
    return getAllGroups().filter(g => {
        if (!g.enabled) return false;
        if (!g.scope || g.scope === 'global') return true;
        if (g.scope === 'character' || g.scope === 'card') return true;
        if (charId !== null && (g.scope === `character:${charId}` || g.scope === charId)) return true;
        return false;
    });
}
