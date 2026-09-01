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
let _generationActive = false;
let _completeTimer = null;

/**
 * Trigger round completion exactly once per generation cycle.
 */
function handleRoundCompletion() {
    if (!_generationActive) return;
    _generationActive = false;
    clearTimeout(_completeTimer);
    try {
        console.log('[Random Hooks] Generation complete: advancing lifecycle rounds...');
        onRoundComplete();
        import('../ui/view-manage.js').then(m => m.refreshGroupList?.()).catch(() => {});
    } catch (e) {
        console.error('[Random Hooks] Error in round completion:', e);
    }
}

/**
 * Register all SillyTavern event hooks.
 * @param {EventEmitter} eventSource
 * @param {Object} event_types
 */
export function registerHooks(eventSource, event_types) {
    if (_hooksBound || !eventSource || !event_types) return;
    _hooksBound = true;
    
    // 1. Primary injection hook: Fires on ALL APIs before context combination
    const handleStart = () => {
        try {
            console.log('[Random Hooks] GENERATION_STARTED triggered: injecting random macros...');
            _generationActive = true;
            injectRandomMacros();
            import('../ui/view-manage.js').then(m => m.refreshGroupList?.()).catch(() => {});
        } catch (e) {
            console.error('[Random Hooks] Error in GENERATION_STARTED:', e);
        }
    };

    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, handleStart);
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
    
    // 3. Generation completion hooks (covers streaming, non-streaming, swipes, commands)
    const onCompleteEvent = () => {
        if (!_generationActive) return;
        // Debounce slightly in case multiple completion events fire in the same frame
        clearTimeout(_completeTimer);
        _completeTimer = setTimeout(handleRoundCompletion, 20);
    };

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, onCompleteEvent);
    }
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onCompleteEvent);
    }
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCompleteEvent);
    }

    // 4. Chat changed: clear / re-sync injections
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            try {
                _generationActive = false;
                clearTimeout(_completeTimer);
                clearAllInjections();
                import('../ui/view-manage.js').then(m => m.refreshGroupList?.()).catch(() => {});
            } catch (e) {
                console.error('[Random Hooks] Error on CHAT_CHANGED:', e);
            }
        });
    }
    
    console.log('[Random Hooks] All SillyTavern hooks successfully registered.');
}

