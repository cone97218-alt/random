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
};

/**
 * Apply a Morandi preset theme by injecting CSS custom properties onto the panel element.
 * @param {'morandi-beige'|'morandi-gray'} theme
 * @param {HTMLElement} panelEl
 */
export function applyMorandiTheme(theme, panelEl) {
    const vars = theme === 'morandi-beige' ? MORANDI_BEIGE : MORANDI_GRAY;
    for (const [key, val] of Object.entries(vars)) {
        panelEl.style.setProperty(key, val);
    }
}

/**
 * Apply the 'follow' theme: map ST CSS variables to --random-* variables using RGB channels.
 * Background colors use opacity=1 (fully opaque) per spec.
 * @param {HTMLElement} panelEl
 */
export function applyFollowTheme(panelEl) {
    // Read the ST RGB channels injected by injectThemeRgbVariables()
    const root = document.documentElement;
    const style = getComputedStyle(root);
    
    const blurRgb  = style.getPropertyValue('--SmartThemeBlurTintColor-rgb').trim()  || '30, 30, 30';
    const chatRgb  = style.getPropertyValue('--SmartThemeChatTintColor-rgb').trim()  || '25, 25, 25';
    const borderRgb = style.getPropertyValue('--SmartThemeBorderColor-rgb').trim()   || '80, 80, 80';
    const emRgb    = style.getPropertyValue('--SmartThemeEmColor-rgb').trim()        || '200, 180, 150';
    
    panelEl.style.setProperty('--random-bg',          `rgba(${blurRgb}, 1)`);
    panelEl.style.setProperty('--random-bg-panel',    `rgba(${chatRgb}, 1)`);
    panelEl.style.setProperty('--random-text',        `var(--SmartThemeBodyColor)`);
    panelEl.style.setProperty('--random-text-muted',  `var(--SmartThemeEmColor)`);
    panelEl.style.setProperty('--random-border',      `rgba(${borderRgb}, 1)`);
    panelEl.style.setProperty('--random-accent',      `rgba(${emRgb}, 1)`);
    panelEl.style.setProperty('--random-accent-hover',`var(--SmartThemeUnderlineColor)`);
    panelEl.style.setProperty('--random-danger',      `var(--SmartThemeQuoteColor)`);
    panelEl.style.setProperty('--random-quote-color', `var(--SmartThemeQuoteColor)`);
    panelEl.style.setProperty('--random-success',     `rgba(${emRgb}, 0.8)`);
    panelEl.style.setProperty('--random-tag-bg',      `rgba(${borderRgb}, 1)`);
    panelEl.style.setProperty('--random-input-bg',    `rgba(${blurRgb}, 1)`);
}

/**
 * Apply the selected theme to the panel element.
 * @param {'follow'|'morandi-beige'|'morandi-gray'} theme
 * @param {HTMLElement} panelEl
 */
export function applyTheme(theme, panelEl) {
    if (!panelEl) return;
    injectThemeRgbVariables();
    
    if (theme === 'follow') {
        applyFollowTheme(panelEl);
    } else {
        applyMorandiTheme(theme, panelEl);
    }
}
