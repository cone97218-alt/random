/**
 * panel.js - Main panel controller for the random macro extension
 *
 * Manages panel lifecycle: create, show, hide, view switching, theme application.
 */

import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { applyTheme, injectThemeRgbVariables } from '../utils/theme.js';
import { getSettings } from '../core/storage.js';
import { renderManageView } from './view-manage.js';
import { renderGenerateView } from './view-generate.js';
import { renderSettingsView } from './settings.js';

const PANEL_ID = 'random-popup-overlay';

let _overlayEl = null;
let _activeView = 'manage';
let _lastThemeHash = null;
let _settingsOpen = false;

// ── DOM Creation ──────────────────────────────────────────────────────────────

async function createPanelDOM() {
    if (document.getElementById(PANEL_ID)) {
        return document.getElementById(PANEL_ID);
    }
    
    const html = await renderExtensionTemplateAsync('third-party/random', 'templates/panel');
    const temp = document.createElement('div');
    temp.innerHTML = html.trim();
    const overlay = temp.firstElementChild;
    document.body.appendChild(overlay);
    _overlayEl = overlay;
    
    // Bind header events
    overlay.querySelector('#random-close-btn').addEventListener('click', hidePanel);
    overlay.querySelector('#random-settings-btn').addEventListener('click', toggleSettings);
    
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
    
    // Render views
    await renderManageView(overlay.querySelector('#random-view-manage'));
    await renderGenerateView(overlay.querySelector('#random-view-generate'));
    await renderSettingsView(overlay.querySelector('#random-view-settings'));
    
    return overlay;
}

// ── View Switching ────────────────────────────────────────────────────────────

function switchView(viewId) {
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

    // Auto sync selectors when entering generate view
    if (viewId === 'generate') {
        import('./view-generate.js').then(m => m.refreshGenerateViewSelectors?.());
    } else if (viewId === 'manage') {
        import('./view-manage.js').then(m => m.refreshGroupList?.());
    }
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

// ── Show / Hide ───────────────────────────────────────────────────────────────

/**
 * Show the random macro panel.
 * @param {'manage'|'generate'|'settings'|null} [targetView]
 */
export async function showPanel(targetView = null) {
    // Update theme if changed
    const themeHash = document.documentElement.getAttribute('data-theme') || document.body.className;
    if (_lastThemeHash !== themeHash) {
        injectThemeRgbVariables();
        _lastThemeHash = themeHash;
    }
    
    const overlay = await createPanelDOM();
    
    // Apply panel size and position from settings
    const s = getSettings();
    const panel = s.panel || {};
    const content = overlay.querySelector('#random-popup-content');
    
    if (content) {
        applyPanelLayout(content, panel);
        applyTheme(panel.theme || 'follow', content);
    }
    
    // Show
    overlay.style.display = 'block';
    setTimeout(() => overlay.classList.add('show'), 10);
    
    // Restore last view or switch to specified view
    if (targetView && ['manage', 'generate', 'settings'].includes(targetView)) {
        switchView(targetView);
    } else {
        switchView(_settingsOpen ? 'settings' : _activeView);
    }
}

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
 * Hide the panel with a fade-out transition.
 */
export function hidePanel() {
    if (!_overlayEl) return;
    _overlayEl.classList.remove('show');
    setTimeout(() => {
        if (!_overlayEl?.classList.contains('show')) {
            _overlayEl.style.display = 'none';
        }
    }, 300);
}

/**
 * Refresh theme on the open panel (called when settings change).
 */
export function refreshTheme() {
    if (!_overlayEl) return;
    const content = _overlayEl.querySelector('#random-popup-content');
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
    const content = _overlayEl.querySelector('#random-popup-content');
    if (!content) return;
    const s = getSettings();
    applyPanelLayout(content, s.panel || {});
}
