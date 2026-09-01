/**
 * theme.js - SillyTavern theme adaptation utility
 *
 * Reads computed CSS variable colors from the DOM and injects RGB-channel
 * versions so that CSS can use rgba(var(--XXX-rgb), alpha) patterns.
 * Also provides Morandi theme preset variable sets.
 */

// ST theme variables to extract RGB from
const ST_VARIABLES = [
    '--SmartThemeBodyColor',
    '--SmartThemeEmColor',
    '--SmartThemeUnderlineColor',
    '--SmartThemeQuoteColor',
    '--SmartThemeShadowColor',
    '--SmartThemeChatTintColor',
    '--SmartThemeBlurTintColor',
    '--SmartThemeBorderColor',
    '--SmartThemeUserMesBlurTintColor',
    '--SmartThemeBotMesBlurTintColor',
];

let _themeWatcherInitialized = false;

/**
 * Extract RGB components from a CSS variable's computed color.
 * @param {string} variableName - e.g. '--SmartThemeBlurTintColor'
 * @returns {string|null} - e.g. '30, 30, 30' or null
 */
export function getThemeRgb(variableName) {
    const tempDiv = document.createElement('div');
    tempDiv.style.color = `var(${variableName})`;
    tempDiv.style.display = 'none';
    document.body.appendChild(tempDiv);
    const computedColor = window.getComputedStyle(tempDiv).color;
    document.body.removeChild(tempDiv);
    
    const match = computedColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
        return `${match[1]}, ${match[2]}, ${match[3]}`;
    }
    return null;
}

/**
 * Inject RGB versions of all ST theme variables onto :root.
 * e.g. --SmartThemeBlurTintColor-rgb: 30, 30, 30
 */
export function injectThemeRgbVariables() {
    const root = document.documentElement;
    ST_VARIABLES.forEach(varName => {
        const rgb = getThemeRgb(varName);
        if (rgb) {
            root.style.setProperty(`${varName}-rgb`, rgb);
        }
    });

    const quoteRgb = getThemeRgb('--SmartThemeQuoteColor') || getThemeRgb('--SmartThemeEmColor');
    if (quoteRgb) {
        root.style.setProperty('--random-accent-rgb', quoteRgb);
    }
}

// ── Morandi theme presets ─────────────────────────────────────────────────────

const MORANDI_BEIGE = {
    '--random-bg':          'rgba(245, 238, 228, 1)',
    '--random-bg-panel':    'rgba(238, 230, 218, 1)',
    '--random-text':        'rgba(80, 70, 60, 1)',
    '--random-text-muted':  'rgba(140, 125, 108, 1)',
    '--random-border':      'rgba(200, 188, 170, 1)',
    '--random-accent':      'rgba(176, 152, 125, 1)',
    '--random-accent-hover':'rgba(155, 130, 102, 1)',
    '--random-danger':      'rgba(185, 110, 100, 1)',
    '--random-quote-color': 'rgba(185, 110, 100, 1)',
    '--random-success':     'rgba(120, 155, 120, 1)',
    '--random-tag-bg':      'rgba(220, 208, 192, 1)',
    '--random-input-bg':    'rgba(250, 245, 238, 1)',
    '--random-accent-rgb':  '176, 152, 125',
};

const MORANDI_GRAY = {
    '--random-bg':          'rgba(230, 232, 235, 1)',
    '--random-bg-panel':    'rgba(220, 222, 226, 1)',
    '--random-text':        'rgba(60, 65, 75, 1)',
    '--random-text-muted':  'rgba(120, 128, 140, 1)',
    '--random-border':      'rgba(185, 190, 200, 1)',
    '--random-accent':      'rgba(130, 145, 165, 1)',
    '--random-accent-hover':'rgba(108, 125, 148, 1)',
    '--random-danger':      'rgba(165, 105, 115, 1)',
    '--random-quote-color': 'rgba(165, 105, 115, 1)',
    '--random-success':     'rgba(110, 145, 130, 1)',
    '--random-tag-bg':      'rgba(205, 210, 218, 1)',
    '--random-input-bg':    'rgba(240, 242, 245, 1)',
    '--random-accent-rgb':  '130, 145, 165',
};

/**
 * Apply a Morandi preset theme by injecting CSS custom properties onto root and panel.
 * @param {'morandi-beige'|'morandi-gray'} theme
 * @param {HTMLElement} [panelEl]
 */
export function applyMorandiTheme(theme, panelEl) {
    const vars = theme === 'morandi-beige' ? MORANDI_BEIGE : MORANDI_GRAY;
    const root = document.documentElement;
    for (const [key, val] of Object.entries(vars)) {
        root.style.setProperty(key, val);
        if (panelEl) panelEl.style.setProperty(key, val);
    }
}

/**
 * Apply the 'follow' theme: map ST CSS variables to --random-* variables dynamically.
 * Background colors extract RGB and apply 100% opacity (alpha = 1).
 * @param {HTMLElement} [panelEl]
 */
export function applyFollowTheme(panelEl) {
    injectThemeRgbVariables();
    const root = document.documentElement;
    
    const followVars = {
        '--random-bg':           'rgba(var(--SmartThemeBlurTintColor-rgb, 30, 30, 30), 1)',
        '--random-bg-panel':     'rgba(var(--SmartThemeChatTintColor-rgb, 25, 25, 25), 1)',
        '--random-text':         'var(--SmartThemeBodyColor)',
        '--random-text-muted':   'var(--SmartThemeEmColor, var(--SmartThemeUnderlineColor))',
        '--random-border':       'rgba(var(--SmartThemeBorderColor-rgb, 80, 80, 80), 1)',
        '--random-accent':       'var(--SmartThemeQuoteColor)',
        '--random-accent-hover': 'var(--SmartThemeUnderlineColor)',
        '--random-danger':       'var(--SmartThemeQuoteColor)',
        '--random-quote-color':  'var(--SmartThemeQuoteColor)',
        '--random-success':      'var(--SmartThemeQuoteColor)',
        '--random-tag-bg':       'rgba(var(--SmartThemeChatTintColor-rgb, 25, 25, 25), 1)',
        '--random-input-bg':     'rgba(var(--SmartThemeBlurTintColor-rgb, 30, 30, 30), 1)',
    };

    for (const [key, val] of Object.entries(followVars)) {
        root.style.setProperty(key, val);
        if (panelEl) panelEl.style.setProperty(key, val);
    }
}

/**
 * Apply the selected theme to the panel element and root DOM.
 * @param {'follow'|'morandi-beige'|'morandi-gray'} theme
 * @param {HTMLElement} [panelEl]
 */
export function applyTheme(theme, panelEl) {
    injectThemeRgbVariables();
    
    if (theme === 'follow') {
        applyFollowTheme(panelEl);
    } else {
        applyMorandiTheme(theme, panelEl);
    }

    // Auto-listen to ST theme switching
    if (!_themeWatcherInitialized && typeof MutationObserver !== 'undefined') {
        _themeWatcherInitialized = true;
        const observer = new MutationObserver(() => {
            const currentTheme = panelEl?.dataset?.theme || theme || 'follow';
            if (currentTheme === 'follow') {
                applyFollowTheme(panelEl);
            }
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] });
    }
}
