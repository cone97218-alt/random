/**
 * hooks.js - SillyTavern event hook registrations
 *
 * Binds ST lifecycle events to extension logic:
 *   - GENERATION_STARTED → Main injection trigger for ALL backends (OpenAI/ChatCompletion & TextCompletion)
 *   - GENERATE_BEFORE_COMBINE_PROMPTS → Backup injection hook for TextCompletion
 *   - MESSAGE_RECEIVED → Increment round counter
 *   - CHAT_CHANGED → Refresh and sync prompt injections
 */

import { injectRandomMacros, onRoundComplete, clearAllInjections } from './injection.js';

let _hooksBound = false;

/**
 * Register all SillyTavern event hooks.
 * @param {EventEmitter} eventSource
 * @param {Object} event_types
 */
export function registerHooks(eventSource, event_types) {
    if (_hooksBound || !eventSource || !event_types) return;
    _hooksBound = true;
    
    // 1. Primary injection hook: Fires on ALL APIs (OpenAI, Claude, TextGen, Kobold, etc.) before context combination
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            try {
                console.log('[Random Hooks] GENERATION_STARTED triggered: injecting random macros...');
                injectRandomMacros();
            } catch (e) {
                console.error('[Random Hooks] Error in GENERATION_STARTED:', e);
            }
        });
    }
    
    // 2. Backup hook for text-completion backends
    if (event_types.GENERATE_BEFORE_COMBINE_PROMPTS) {
        eventSource.on(event_types.GENERATE_BEFORE_COMBINE_PROMPTS, () => {
            try {
                injectRandomMacros();
            } catch (e) {
                console.error('[Random Hooks] Error in GENERATE_BEFORE_COMBINE_PROMPTS:', e);
            }
        });
    }
    
    // 3. Track rounds when message arrives
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            try {
                onRoundComplete();
            } catch (e) {
                console.error('[Random Hooks] Error in MESSAGE_RECEIVED:', e);
            }
        });
    }

    // 4. Chat changed: clear / re-sync injections
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            try {
                clearAllInjections();
            } catch (e) {
                console.error('[Random Hooks] Error on CHAT_CHANGED:', e);
            }
        });
    }
    
    console.log('[Random Hooks] All SillyTavern hooks successfully registered.');
}

