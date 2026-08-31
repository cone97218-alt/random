/**
 * dom.js - DOM utility functions for the random macro extension
 */

/**
 * Generate a random UUID-like string for new entity IDs.
 * @returns {string}
 */
export function generateId() {
    return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * Create an element with properties in one call.
 * @param {string} tag
 * @param {Object} [props]
 * @param {string[]} [classes]
 * @param {(HTMLElement|string)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, classes = [], children = []) {
    const element = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
        if (k === 'style' && typeof v === 'object') {
            Object.assign(element.style, v);
        } else {
            element[k] = v;
        }
    }
    classes.forEach(cls => { if (cls) element.classList.add(cls); });
    children.forEach(child => {
        if (typeof child === 'string') {
            element.appendChild(document.createTextNode(child));
        } else if (child instanceof HTMLElement) {
            element.appendChild(child);
        }
    });
    return element;
}

/**
 * Show a short toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'} [type='info']
 * @param {number} [duration=2500]
 */
export function showToast(message, type = 'info', duration = 2500) {
    const toast = document.createElement('div');
    toast.className = `random-toast random-toast--${type}`;
    toast.textContent = message;
    
    // Stack toasts vertically
    const existing = document.querySelectorAll('.random-toast');
    const offset = existing.length * 52;
    toast.style.bottom = `${20 + offset}px`;
    
    document.body.appendChild(toast);
    
    requestAnimationFrame(() => toast.classList.add('show'));
    
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

/**
 * Confirm dialog using the browser's native confirm (simple, no dependencies).
 * @param {string} message
 * @returns {boolean}
 */
export function confirmDialog(message) {
    return window.confirm(message);
}

/**
 * Debounce a function call.
 * @param {Function} fn
 * @param {number} ms
 * @returns {Function}
 */
export function debounce(fn, ms) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
    };
}

/**
 * Escape HTML special characters.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
