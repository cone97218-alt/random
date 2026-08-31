/**
 * settings.js - Settings view controller (refactored)
 *
 * Handles:
 *   - Collapsible sections
 *   - Prompt component list (render / toggle / edit / reorder / add custom / delete)
 *   - Save + Reset to default
 */

import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { getSettings, saveSettings } from '../core/storage.js';
import { DEFAULT_PROMPT_COMPONENTS } from '../core/constants.js';
import { showToast, generateId, escapeHtml } from '../utils/dom.js';
import { refreshTheme, refreshLayout } from './panel.js';
import { convertStRandomMacros, importConvertedGroup } from '../core/st-converter.js';
import { refreshGroupList } from './view-manage.js';

let _rendered = false;
let _container = null;

// ── Entry ─────────────────────────────────────────────────────────────────────

export async function renderSettingsView(container) {
    if (_rendered) {
        _loadValues(container);
        return;
    }
    _rendered = true;
    _container = container;

    const html = await renderExtensionTemplateAsync('third-party/random', 'templates/settings');
    container.innerHTML = html;

    _bindEvents(container);
    _bindConverter(container);
    _loadValues(container);
    _renderComponentList(container);
}

// ── Load values ───────────────────────────────────────────────────────────────

function _loadValues(container) {
    const s = getSettings();
    const panel = s.panel || {};
    const lc    = s.globalLifecycle || {};
    const misc  = s.misc || {};

    _val(container, '#random-setting-theme',    panel.theme    || 'follow');
    _val(container, '#random-setting-position', panel.position || 'normal');
    _val(container, '#random-setting-width',    panel.width    ?? 80);
    _val(container, '#random-setting-height',   panel.height   ?? 70);
    _val(container, '#random-setting-every-x',  lc.everyXRounds !== null && lc.everyXRounds !== undefined ? lc.everyXRounds : '');
    _val(container, '#random-setting-keep-y',   lc.keepYRounds  !== null && lc.keepYRounds  !== undefined ? lc.keepYRounds  : '');

    // Misc settings
    const avoidRepCheck = container.querySelector('#random-setting-avoid-repetition');
    if (avoidRepCheck) avoidRepCheck.checked = misc.avoidRepetition !== false;
    _val(container, '#random-setting-converter-start-index', misc.converterStartIndex ?? 1);

    // Collapsible sections (default collapsed, persisted in settings & localStorage)
    let openSections = s.settingsOpenSections;
    if (!openSections) {
        try {
            const stored = localStorage.getItem('random_settings_open_sections');
            if (stored) openSections = JSON.parse(stored);
        } catch (_) {}
    }
    const openSet = new Set(Array.isArray(openSections) ? openSections : []);
    container.querySelectorAll('.random-settings-details').forEach(d => {
        const section = d.dataset.section;
        d.open = section ? openSet.has(section) : false;
    });
}

// ── Bind events ───────────────────────────────────────────────────────────────

function _bindEvents(container) {
    // Collapsible sections toggle persistence
    container.querySelectorAll('.random-settings-details').forEach(details => {
        details.addEventListener('toggle', () => {
            const s = getSettings();
            const openSections = [...container.querySelectorAll('.random-settings-details')]
                .filter(d => d.open && d.dataset.section)
                .map(d => d.dataset.section);
            s.settingsOpenSections = openSections;
            saveSettings();
            try {
                localStorage.setItem('random_settings_open_sections', JSON.stringify(openSections));
            } catch (_) {}
        });
    });

    container.querySelector('#random-settings-save-btn').addEventListener('click', () => {
        _save(container);
    });

    container.querySelector('#random-settings-reset-btn')?.addEventListener('click', () => {
        if (!confirm('确认重置所有提示词组件为默认值？此操作不可撤销。')) return;
        const s = getSettings();
        s.aiPromptComponents = DEFAULT_PROMPT_COMPONENTS.map(c => ({ ...c }));
        saveSettings();
        _renderComponentList(container);
        showToast('已重置为默认提示词', 'success');
    });

    container.querySelector('#random-add-prompt-component-btn')?.addEventListener('click', () => {
        _addCustomComponent(container);
    });

    // Live preview
    container.querySelector('#random-setting-theme')?.addEventListener('change', () => {
        _save(container, true);
        refreshTheme();
    });
    ['#random-setting-position', '#random-setting-width', '#random-setting-height'].forEach(sel => {
        container.querySelector(sel)?.addEventListener('change', () => {
            _save(container, true);
            refreshLayout();
        });
    });
}

// ── Save ──────────────────────────────────────────────────────────────────────

function _save(container, silent = false) {
    const s = getSettings();
    if (!s.panel) s.panel = {};
    if (!s.globalLifecycle) s.globalLifecycle = {};
    if (!s.misc) s.misc = {};

    s.panel.theme    = container.querySelector('#random-setting-theme')?.value    || 'follow';
    s.panel.position = container.querySelector('#random-setting-position')?.value || 'normal';
    s.panel.width    = Number(container.querySelector('#random-setting-width')?.value)  || 80;
    s.panel.height   = Number(container.querySelector('#random-setting-height')?.value) || 70;

    const everyX = container.querySelector('#random-setting-every-x')?.value.trim();
    const keepY  = container.querySelector('#random-setting-keep-y')?.value.trim();
    s.globalLifecycle.everyXRounds = everyX !== '' ? Number(everyX) : null;
    s.globalLifecycle.keepYRounds  = keepY  !== '' ? Number(keepY)  : null;

    // Misc settings
    s.misc.avoidRepetition = container.querySelector('#random-setting-avoid-repetition')?.checked !== false;
    const startIndex = Number(container.querySelector('#random-setting-converter-start-index')?.value);
    s.misc.converterStartIndex = Number.isFinite(startIndex) && startIndex >= 1 ? startIndex : 1;

    // Collect component list state
    _collectComponentList(container);

    saveSettings();
    if (!silent) showToast('设置已保存', 'success');
}

// ── Prompt Component List ─────────────────────────────────────────────────────

const ROLE_LABELS = { system: 'S', user: 'U', assistant: 'A' };
const ROLES = ['system', 'user', 'assistant'];

function _renderComponentList(container) {
    const listEl = container.querySelector('#random-prompt-component-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    const s = getSettings();
    const components = (s.aiPromptComponents || DEFAULT_PROMPT_COMPONENTS)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    components.forEach((comp, idx) => {
        listEl.appendChild(_buildComponentRow(comp, idx, container));
    });

    _initDragSort(listEl, container);
}

function _buildComponentRow(comp, idx, container) {
    const row = document.createElement('div');
    row.className = 'random-pc-row';
    row.dataset.compId = comp.id;

    // Role badge
    const roleCycle = ROLES.indexOf(comp.role || 'system');
    const roleEl = document.createElement('button');
    roleEl.className = 'random-pc-role-btn';
    roleEl.title = 'role: ' + (comp.role || 'system');
    roleEl.textContent = ROLE_LABELS[comp.role || 'system'] || 'S';
    roleEl.dataset.roleIdx = roleCycle;
    if (!comp.builtinKey || comp.editable) {
        roleEl.addEventListener('click', () => {
            const cur = Number(roleEl.dataset.roleIdx);
            const next = (cur + 1) % ROLES.length;
            roleEl.dataset.roleIdx = next;
            roleEl.textContent = ROLE_LABELS[ROLES[next]];
            roleEl.title = 'role: ' + ROLES[next];
            _saveComponentField(container, comp.id, 'role', ROLES[next]);
        });
    } else {
        // Builtin non-editable: role is still togglable
        roleEl.addEventListener('click', () => {
            const cur = Number(roleEl.dataset.roleIdx);
            const next = (cur + 1) % ROLES.length;
            roleEl.dataset.roleIdx = next;
            roleEl.textContent = ROLE_LABELS[ROLES[next]];
            roleEl.title = 'role: ' + ROLES[next];
            _saveComponentField(container, comp.id, 'role', ROLES[next]);
        });
    }

    // Toggle (enable/disable)
    const toggle = document.createElement('label');
    toggle.className = 'random-pc-toggle';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = comp.enabled !== false;
    chk.addEventListener('change', () => {
        _saveComponentField(container, comp.id, 'enabled', chk.checked);
    });
    const slider = document.createElement('span');
    slider.className = 'random-pc-slider';
    toggle.appendChild(chk);
    toggle.appendChild(slider);

    // Label
    const label = document.createElement('span');
    label.className = 'random-pc-label';
    label.textContent = comp.label || comp.id;

    // Edit expand (for editable items: main_prompt, custom)
    const actions = document.createElement('div');
    actions.className = 'random-pc-actions';

    if (comp.editable || !comp.builtinKey) {
        const editBtn = document.createElement('button');
        editBtn.className = 'random-icon-btn--xs';
        editBtn.title = '编辑内容';
        editBtn.innerHTML = '<i class="fa-solid fa-pen"></i>';
        editBtn.addEventListener('click', () => {
            const existing = row.querySelector('.random-pc-editor');
            if (existing) { existing.remove(); return; }
            _appendEditor(row, comp, container);
        });
        actions.appendChild(editBtn);
    }

    // Chat history extra config
    if (comp.builtinKey === 'chat_history') {
        const cfgBtn = document.createElement('button');
        cfgBtn.className = 'random-icon-btn--xs';
        cfgBtn.title = '配置聊天历史截取';
        cfgBtn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        cfgBtn.addEventListener('click', () => {
            const existing = row.querySelector('.random-pc-editor');
            if (existing) { existing.remove(); return; }
            _appendChatHistoryEditor(row, comp, container);
        });
        actions.appendChild(cfgBtn);
    }

    // Delete (custom only)
    if (!comp.builtinKey) {
        const delBtn = document.createElement('button');
        delBtn.className = 'random-icon-btn--xs random-icon-btn--danger';
        delBtn.title = '删除';
        delBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
        delBtn.addEventListener('click', () => {
            const s = getSettings();
            s.aiPromptComponents = (s.aiPromptComponents || []).filter(c => c.id !== comp.id);
            saveSettings();
            _renderComponentList(container);
        });
        actions.appendChild(delBtn);
    }

    // Drag handle
    const handle = document.createElement('span');
    handle.className = 'random-pc-handle';
    handle.innerHTML = '<i class="fa-solid fa-grip-vertical"></i>';
    handle.setAttribute('draggable', 'false');

    row.appendChild(handle);
    row.appendChild(roleEl);
    row.appendChild(toggle);
    row.appendChild(label);
    row.appendChild(actions);

    if (!chk.checked) row.classList.add('random-pc-row--disabled');
    chk.addEventListener('change', () => row.classList.toggle('random-pc-row--disabled', !chk.checked));

    return row;
}

function _appendEditor(row, comp, container) {
    const editor = document.createElement('div');
    editor.className = 'random-pc-editor';
    const ta = document.createElement('textarea');
    ta.className = 'random-textarea random-pc-editor-textarea';
    ta.rows = 5;
    ta.value = comp.content || '';
    ta.placeholder = '输入提示词内容...';
    ta.addEventListener('input', () => {
        _saveComponentField(container, comp.id, 'content', ta.value);
    });
    editor.appendChild(ta);
    row.appendChild(editor);
    ta.focus();
}

function _appendChatHistoryEditor(row, comp, container) {
    const editor = document.createElement('div');
    editor.className = 'random-pc-editor';

    const xRow = document.createElement('div');
    xRow.className = 'random-settings-row';
    xRow.innerHTML = '<label class="random-settings-label">截取最近 X 轮</label>';
    const xInput = document.createElement('input');
    xInput.type = 'number';
    xInput.className = 'random-input random-input--narrow';
    xInput.min = 1; xInput.step = 1;
    xInput.value = comp.chatHistoryX ?? 10;
    xInput.addEventListener('input', () => _saveComponentField(container, comp.id, 'chatHistoryX', Number(xInput.value) || 10));
    const xCtrl = document.createElement('div');
    xCtrl.className = 'random-settings-control';
    xCtrl.appendChild(xInput);
    xRow.appendChild(xCtrl);

    const regexRow = document.createElement('div');
    regexRow.className = 'random-settings-row';
    regexRow.innerHTML = '<label class="random-settings-label">正则过滤</label>';
    const regexInput = document.createElement('input');
    regexInput.type = 'text';
    regexInput.className = 'random-input';
    regexInput.placeholder = '正则表达式（留空则不过滤）';
    regexInput.value = comp.regex || '';
    regexInput.addEventListener('input', () => _saveComponentField(container, comp.id, 'regex', regexInput.value));
    const regexCtrl = document.createElement('div');
    regexCtrl.className = 'random-settings-control';
    regexCtrl.appendChild(regexInput);
    regexRow.appendChild(regexCtrl);

    const replaceRow = document.createElement('div');
    replaceRow.className = 'random-settings-row';
    replaceRow.innerHTML = '<label class="random-settings-label">替换为</label>';
    const replaceInput = document.createElement('input');
    replaceInput.type = 'text';
    replaceInput.className = 'random-input';
    replaceInput.placeholder = '替换文本（留空=删除匹配内容）';
    replaceInput.value = comp.regexReplace || '';
    replaceInput.addEventListener('input', () => _saveComponentField(container, comp.id, 'regexReplace', replaceInput.value));
    const replaceCtrl = document.createElement('div');
    replaceCtrl.className = 'random-settings-control';
    replaceCtrl.appendChild(replaceInput);
    replaceRow.appendChild(replaceCtrl);

    editor.appendChild(xRow);
    editor.appendChild(regexRow);
    editor.appendChild(replaceRow);
    row.appendChild(editor);
}

function _saveComponentField(container, compId, field, value) {
    const s = getSettings();
    if (!s.aiPromptComponents) s.aiPromptComponents = DEFAULT_PROMPT_COMPONENTS.map(c => ({ ...c }));
    const comp = s.aiPromptComponents.find(c => c.id === compId);
    if (!comp) return;
    comp[field] = value;
    saveSettings();
}

function _collectComponentList(container) {
    const listEl = container.querySelector('#random-prompt-component-list');
    if (!listEl) return;
    const s = getSettings();
    if (!s.aiPromptComponents) return;

    const rows = listEl.querySelectorAll('.random-pc-row');
    rows.forEach((row, idx) => {
        const compId = row.dataset.compId;
        const comp = s.aiPromptComponents.find(c => c.id === compId);
        if (!comp) return;
        comp.order = idx;
    });
}

function _addCustomComponent(container) {
    const s = getSettings();
    if (!s.aiPromptComponents) s.aiPromptComponents = DEFAULT_PROMPT_COMPONENTS.map(c => ({ ...c }));
    const newComp = {
        id: 'custom_' + generateId(),
        label: '自定义条目',
        builtinKey: null,
        role: 'system',
        order: s.aiPromptComponents.length,
        enabled: true,
        editable: true,
        content: '',
    };
    s.aiPromptComponents.push(newComp);
    saveSettings();
    _renderComponentList(container);
    // Auto open editor for new item
    const listEl = container.querySelector('#random-prompt-component-list');
    const lastRow = listEl?.lastElementChild;
    if (lastRow) {
        const editBtn = lastRow.querySelector('.random-icon-btn--xs');
        editBtn?.click();
        lastRow.scrollIntoView({ behavior: 'smooth' });
    }
}

// ── Drag-sort ─────────────────────────────────────────────────────────────────

function _initDragSort(listEl, container) {
    let dragSrc = null;

    listEl.querySelectorAll('.random-pc-row').forEach(row => {
        const handle = row.querySelector('.random-pc-handle');
        handle.setAttribute('draggable', 'true');

        handle.addEventListener('dragstart', e => {
            dragSrc = row;
            e.dataTransfer.effectAllowed = 'move';
            row.classList.add('random-pc-dragging');
        });
        handle.addEventListener('dragend', () => {
            row.classList.remove('random-pc-dragging');
            listEl.querySelectorAll('.random-pc-row').forEach(r => r.classList.remove('random-pc-over'));
            _collectAndSaveOrder(listEl, container);
        });

        row.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dragSrc && dragSrc !== row) {
                listEl.querySelectorAll('.random-pc-row').forEach(r => r.classList.remove('random-pc-over'));
                row.classList.add('random-pc-over');
            }
        });
        row.addEventListener('drop', e => {
            e.preventDefault();
            if (dragSrc && dragSrc !== row) {
                const rows = [...listEl.querySelectorAll('.random-pc-row')];
                const srcIdx = rows.indexOf(dragSrc);
                const tgtIdx = rows.indexOf(row);
                if (srcIdx < tgtIdx) {
                    row.after(dragSrc);
                } else {
                    row.before(dragSrc);
                }
            }
        });
    });
}

function _collectAndSaveOrder(listEl, container) {
    const s = getSettings();
    if (!s.aiPromptComponents) return;
    const rows = listEl.querySelectorAll('.random-pc-row');
    rows.forEach((row, idx) => {
        const comp = s.aiPromptComponents.find(c => c.id === row.dataset.compId);
        if (comp) comp.order = idx;
    });
    saveSettings();
}

// ── ST Macro Converter ────────────────────────────────────────────────────────

let _lastParsedData = null;

function _bindConverter(container) {
    const inputEl   = container.querySelector('#random-st-convert-input');
    const nameEl    = container.querySelector('#random-st-convert-group-name');
    const rootIdEl  = container.querySelector('#random-st-convert-root-id');
    const depthEl   = container.querySelector('#random-st-convert-depth');
    const roleEl    = container.querySelector('#random-st-convert-role');
    const prevBtn   = container.querySelector('#random-st-convert-preview-btn');
    const importBtn = container.querySelector('#random-st-convert-import-btn');
    const cardEl    = container.querySelector('#random-st-convert-preview-card');
    const tplEl     = container.querySelector('#random-st-convert-template-preview');
    const listEl    = container.querySelector('#random-st-convert-macros-list');
    const badgeEl   = container.querySelector('#random-st-convert-count-badge');

    if (!prevBtn || !importBtn) return;

    prevBtn.addEventListener('click', () => {
        const text = inputEl?.value?.trim();
        if (!text) {
            showToast('请先输入包含 {{random::...}} 的文本', 'info');
            return;
        }

        const customRootId = rootIdEl?.value?.trim() || container.querySelector('#random-setting-converter-start-index')?.value?.trim() || null;
        const result = convertStRandomMacros(text, nameEl?.value?.trim(), customRootId);
        if (!result.macros.length) {
            showToast('未检测到有效的 {{random::...}} 语法结构', 'info');
            return;
        }

        _lastParsedData = result;
        _renderConverterPreview(result, cardEl, tplEl, listEl, badgeEl, nameEl);
        showToast(`成功解析出 ${result.macros.length} 个嵌套宏`, 'success');
    });

    importBtn.addEventListener('click', () => {
        const text = inputEl?.value?.trim();
        if (!text) {
            showToast('请先输入包含 {{random::...}} 的文本', 'info');
            return;
        }

        const customRootId = rootIdEl?.value?.trim() || container.querySelector('#random-setting-converter-start-index')?.value?.trim() || null;
        let parsed = _lastParsedData;
        if (!parsed || parsed.template === '') {
            parsed = convertStRandomMacros(text, nameEl?.value?.trim(), customRootId);
        }

        if (!parsed.macros.length) {
            showToast('未检测到有效的 {{random::...}} 语法结构', 'info');
            return;
        }

        const groupName = nameEl?.value?.trim() || parsed.groupName || '酒馆宏转换组';
        const depth = Number(depthEl?.value) ?? 4;
        const role = Number(roleEl?.value) ?? 0;

        const { macroCount } = importConvertedGroup({
            groupName,
            template: parsed.template,
            macros: parsed.macros,
            injectionDepth: depth,
            injectionRole: role,
        });

        // Refresh group list in manage view
        refreshGroupList?.();

        showToast(`🎉 成功导入宏组【${groupName}】及 ${macroCount} 个关联宏！`, 'success');

        // Clear preview & input
        if (inputEl) inputEl.value = '';
        if (nameEl) nameEl.value = '';
        if (rootIdEl) rootIdEl.value = '';
        if (cardEl) cardEl.style.display = 'none';
        _lastParsedData = null;
    });
}

function _renderConverterPreview(data, cardEl, tplEl, listEl, badgeEl, nameEl) {
    if (!cardEl) return;
    cardEl.style.display = 'flex';

    const maxDepth = data.maxDepth || (data.macros.length > 0 ? 1 : 0);
    if (badgeEl) badgeEl.textContent = `共 ${data.macros.length} 个宏 · 嵌套深度 ${maxDepth} 层`;
    if (tplEl) tplEl.textContent = data.template;
    if (nameEl && !nameEl.value) nameEl.value = data.groupName;

    if (listEl) {
        listEl.className = 'random-converter-tree-list';
        listEl.innerHTML = '';

        data.macros.forEach((m) => {
            const item = document.createElement('div');
            const isRoot = (m.level || 1) === 1;
            item.className = `random-converter-macro-item ${isRoot ? 'random-converter-macro-item--level-1' : 'random-converter-macro-item--level-nested'}`;
            
            // Visual indentation based on nesting depth
            const indentPx = Math.max(0, ((m.level || 1) - 1) * 20);
            item.style.marginLeft = `${indentPx}px`;

            // Level badge
            const levelBadge = isRoot
                ? `<span class="random-converter-level-badge random-converter-level-badge--root"><i class="fa-solid fa-seedling"></i> Level 1 根宏</span>`
                : `<span class="random-converter-level-badge random-converter-level-badge--child"><i class="fa-solid fa-turn-down"></i> Level ${m.level || 2} 子宏</span>`;

            // Parent & Children relationship chips
            const relChips = [];
            if (m.parentId) {
                relChips.push(`<span class="random-converter-rel-chip"><i class="fa-solid fa-arrow-up"></i> 父宏: 宏 ${escapeHtml(m.parentId)}</span>`);
            }
            if (m.childrenIds && m.childrenIds.length > 0) {
                const childTags = m.childrenIds.map(c => `宏 ${escapeHtml(c)}`).join(', ');
                relChips.push(`<span class="random-converter-rel-chip"><i class="fa-solid fa-link"></i> 包含子宏: ${childTags}</span>`);
            }
            const relHtml = relChips.length > 0
                ? `<div class="random-converter-rel-row">${relChips.join(' ')}</div>`
                : '';

            // Options list with highlighted macro tags
            const optRowsHtml = (m.options || []).map((o, idx) => {
                const highlighted = escapeHtml(o.text || '')
                    .replace(/\{\{random_([^}]+)\}\}/g, '<span class="random-macro-chip-id">&#123;&#123;random_$1&#125;&#125;</span>');
                return `<div class="random-converter-opt-row">• 选项 ${idx + 1}: ${highlighted}</div>`;
            }).join('');

            item.innerHTML = `
                <div class="random-converter-macro-title">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span><i class="fa-solid fa-cube"></i> <strong>宏 ${escapeHtml(m.id)}</strong></span>
                        ${levelBadge}
                    </div>
                    <span style="font-size:0.82em; font-weight:normal; color:var(--random-text-muted);">
                        ${m.options.length} 个候选项
                    </span>
                </div>
                ${relHtml}
                <div class="random-converter-macro-opts">
                    ${optRowsHtml}
                </div>
            `;
            listEl.appendChild(item);
        });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _val(container, selector, value) {
    const el = container.querySelector(selector);
    if (!el) return;
    if (el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = value !== undefined && value !== null ? value : '';
    }
}

