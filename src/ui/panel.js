/**
 * panel.js - High Performance GPU-Accelerated Panel Controller
 *
 * Architecture:
 *   1. Singleton Resident DOM: Pre-initialized at startup, kept resident in DOM without teardown.
 *   2. GPU Independent Layer: Hardware accelerated via translate3d / will-change, zero Reflow.
 *   3. Visual-First + requestAnimationFrame: Class toggling runs at 0ms delay, heavy data loads deferred to rAF.
 *   4. Micro-throttle: Prevents rapid-click animation jitter.
 */

import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { applyTheme, injectThemeRgbVariables } from '../utils/theme.js';
import { getSettings } from '../core/storage.js';
import { renderManageView } from './view-manage.js';
import { renderGenerateView } from './view-generate.js';
import { renderSettingsView } from './settings.js';

const PANEL_ID = 'random-popup-overlay';

let _overlayEl = null;
let _contentEl = null;
let _domPromise = null;
let _activeView = 'manage';
let _lastThemeHash = null;
let _settingsOpen = false;
let _lastToggleTime = 0;
let _escBound = false;

// ── 1. Singleton Resident DOM Initialization ─────────────────────────────────

/**
 * Initialize the panel DOM (singleton, pre-warmed on extension startup).
 * @returns {Promise<HTMLElement>}
 */
export async function initPanel() {
    if (_overlayEl && document.body.contains(_overlayEl)) {
        return _overlayEl;
    }

    const existingInDom = document.getElementById(PANEL_ID);
    if (existingInDom) {
        _overlayEl = existingInDom;
        _contentEl = existingInDom.querySelector('#random-popup-content');
        return _overlayEl;
    }

    if (_domPromise) return _domPromise;

    _domPromise = (async () => {
        const html = await renderExtensionTemplateAsync('third-party/random', 'templates/panel');
        const temp = document.createElement('div');
        temp.innerHTML = html.trim();
        const overlay = temp.firstElementChild;
        document.body.appendChild(overlay);

        _overlayEl = overlay;
        _contentEl = overlay.querySelector('#random-popup-content');

        // Apply initial layout and theme to GPU layer immediately
        const s = getSettings();
        const panel = s.panel || {};
        if (_contentEl) {
            applyPanelLayout(_contentEl, panel);
            applyTheme(panel.theme || 'follow', _contentEl);
        }

        // Bind header close & settings
        overlay.querySelector('#random-close-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            hidePanel();
        });
        overlay.querySelector('#random-settings-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleSettings();
        });

        // Tab buttons
        overlay.querySelectorAll('.random-tab-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (_settingsOpen) return;
                switchView(btn.dataset.view);
            });
        });

        // Close on backdrop click
        overlay.addEventListener('click', e => {
            if (e.target === overlay) hidePanel();
        });

        // Global ESC key to close panel if open
        if (!_escBound) {
            window.addEventListener('keydown', e => {
                if (e.key === 'Escape' && isPanelOpen()) {
                    hidePanel();
                }
            });
            _escBound = true;
        }

        // Pre-render sub-views in background (manage, generate, settings)
        await Promise.allSettled([
            renderManageView(overlay.querySelector('#random-view-manage')),
            renderGenerateView(overlay.querySelector('#random-view-generate')),
            renderSettingsView(overlay.querySelector('#random-view-settings')),
        ]);

        return overlay;
    })();

    return _domPromise;
}

// ── 2. View Switching ────────────────────────────────────────────────────────

export function switchView(viewId) {
    _activeView = viewId;
    _settingsOpen = false;

    ['manage', 'generate', 'settings'].forEach(id => {
        const el = document.getElementById(`random-view-${id}`);
        if (el) el.style.display = id === viewId ? '' : 'none';
    });

    // Update tab button states
    document.querySelectorAll('.random-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewId);
    });

    // Show/hide settings btn appearance
    const settingsBtn = document.getElementById('random-settings-btn');
    if (settingsBtn) {
        settingsBtn.classList.toggle('active', viewId === 'settings');
    }

    // Auto sync selectors/lists on view enter via rAF
    requestAnimationFrame(() => {
        if (viewId === 'generate') {
            import('./view-generate.js').then(m => m.refreshGenerateViewSelectors?.());
        } else if (viewId === 'manage') {
            import('./view-manage.js').then(m => m.refreshGroupList?.());
        }
    });
}

function toggleSettings() {
    if (_settingsOpen) {
        switchView(_activeView === 'settings' ? 'manage' : _activeView);
        _settingsOpen = false;
    } else {
        _activeView = document.querySelector('.random-tab-btn.active')?.dataset.view || 'manage';
        switchView('settings');
        _settingsOpen = true;
    }
}

// ── 3. High Performance 60FPS Toggle / Show / Hide ───────────────────────────

/**
 * Check if the panel is currently open.
 * @returns {boolean}
 */
export function isPanelOpen() {
    return Boolean(_overlayEl?.classList.contains('show'));
}

/**
 * Ultra-fast toggle for the random macro panel.
 * @param {boolean} [forceState] - true to open, false to close, undefined to toggle
 * @param {'manage'|'generate'|'settings'|null} [targetView]
 */
export async function togglePanel(forceState, targetView = null) {
    // 180ms micro-throttle to prevent rapid animation tearing
    const now = Date.now();
    if (now - _lastToggleTime < 180) return;
    _lastToggleTime = now;

    // Ensure DOM exists
    if (!_overlayEl) {
        await initPanel();
    }
    if (!_overlayEl) return;

    const isOpen = typeof forceState === 'boolean' ? forceState : !_overlayEl.classList.contains('show');

    if (isOpen) {
        // [Visual First] 1. Instant GPU animation trigger (0 delay, 60fps)
        _overlayEl.classList.add('show');

        // Switch view state immediately
        if (targetView && ['manage', 'generate', 'settings'].includes(targetView)) {
            switchView(targetView);
        } else {
            switchView(_settingsOpen ? 'settings' : _activeView);
        }

        // [Async Data & Layout] 2. Defer heavy style calculation & data update to next animation frame
        requestAnimationFrame(() => {
            const themeHash = document.documentElement.getAttribute('data-theme') || document.body.className;
            if (_lastThemeHash !== themeHash) {
                injectThemeRgbVariables();
                _lastThemeHash = themeHash;
            }

            const s = getSettings();
            const panel = s.panel || {};
            const content = _contentEl || _overlayEl.querySelector('#random-popup-content');
            if (content) {
                applyPanelLayout(content, panel);
                applyTheme(panel.theme || 'follow', content);
            }
        });
    } else {
        // Instant GPU slide-out / fade-out
        _overlayEl.classList.remove('show');
    }
}

/**
 * Show the panel (supports targetView).
 * @param {'manage'|'generate'|'settings'|null} [targetView]
 */
export async function showPanel(targetView = null) {
    return togglePanel(true, targetView);
}

/**
 * Hide the panel.
 */
export function hidePanel() {
    return togglePanel(false);
}

// ── 4. Layout & Theme Helpers ────────────────────────────────────────────────

/**
 * Apply panel position and size from settings to the content element.
 * @param {HTMLElement} content
 * @param {Object} panel
 */
function applyPanelLayout(content, panel) {
    const position = panel.position || 'normal';
    const width    = panel.width !== undefined && panel.width !== '' ? String(panel.width) : '80';
    const height   = panel.height !== undefined && panel.height !== '' ? String(panel.height) : '70';

    const widthVal  = width.endsWith('%') || width.endsWith('px') || width.endsWith('vw') ? width : `${width}%`;
    const heightVal = height.endsWith('%') || height.endsWith('px') || height.endsWith('vh') ? height : `${height}%`;

    // Remove all position classes
    content.classList.remove('position-normal', 'position-left', 'position-right', 'position-top', 'position-bottom');
    content.classList.add(`position-${position}`);

    // Apply dimensions via CSS custom properties
    content.style.removeProperty('--random-popup-width');
    content.style.removeProperty('--random-popup-height');

    if (position === 'normal') {
        content.style.setProperty('--random-popup-width', widthVal);
        content.style.setProperty('--random-popup-height', heightVal);
    } else if (position === 'left' || position === 'right') {
        content.style.setProperty('--random-popup-width', widthVal);
    } else {
        content.style.setProperty('--random-popup-height', heightVal);
    }
}

/**
 * Refresh theme on the open panel (called when settings change).
 */
export function refreshTheme() {
    if (!_overlayEl) return;
    const content = _contentEl || _overlayEl.querySelector('#random-popup-content');
    if (!content) return;
    const s = getSettings();
    injectThemeRgbVariables();
    applyTheme(s.panel?.theme || 'follow', content);
}

/**
 * Refresh panel layout on the open panel (called when position/size settings change).
 */
export function refreshLayout() {
    if (!_overlayEl) return;
    const content = _contentEl || _overlayEl.querySelector('#random-popup-content');
    if (!content) return;
    const s = getSettings();
    applyPanelLayout(content, s.panel || {});
}

