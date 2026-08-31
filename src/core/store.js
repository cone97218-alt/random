/**
 * store.js - In-memory state singleton for the random macro extension
 *
 * Holds runtime state that doesn't need to be persisted (UI state, active group, etc.)
 * Persisted data (macro definitions, lifecycle state) lives in storage.js
 */

const _state = {
    /** @type {Map<string, Function[]>} */
    _subscribers: new Map(),
    
    /** Currently selected view: 'manage' | 'generate' */
    activeView: 'manage',
    
    /** Whether the panel is currently open */
    panelOpen: false,
    
    /** ID of the group selected in the Generate view */
    generateTargetGroupId: null,
    
    /** Whether AI generation is in progress */
    generating: false,
    
    /** Last AI generation result (array of strings) */
    lastGenerationResult: [],
};

/**
 * Get a state value by key
 * @param {string} key
 * @returns {*}
 */
export function get(key) {
    return _state[key];
}

/**
 * Set a state value and notify subscribers
 * @param {string} key
 * @param {*} value
 */
export function set(key, value) {
    _state[key] = value;
    const subs = _state._subscribers.get(key) || [];
    subs.forEach(fn => {
        try { fn(value); } catch (e) { console.error('[Random Store] Subscriber error:', e); }
    });
}

/**
 * Subscribe to changes on a specific key
 * @param {string} key
 * @param {Function} callback
 * @returns {Function} Unsubscribe function
 */
export function subscribe(key, callback) {
    if (!_state._subscribers.has(key)) {
        _state._subscribers.set(key, []);
    }
    _state._subscribers.get(key).push(callback);
    return () => {
        const subs = _state._subscribers.get(key) || [];
        const idx = subs.indexOf(callback);
        if (idx !== -1) subs.splice(idx, 1);
    };
}
