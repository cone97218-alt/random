/**
 * view-manage.js - Macro management view controller
 *
 * Renders and manages:
 *   - Group list with roll/pin/enable/edit/delete controls
 *   - Group edit modal (name, scope, role, depth, lifecycle, template)
 *   - Macro edit modal (id, probability, options with weight+tag)
 */

import { renderExtensionTemplateAsync, getContext } from '../../../../../extensions.js';
import {
    getAllGroups, getGroupById, saveGroup, deleteGroup,
    getAllMacros, getMacroById, saveMacro, deleteMacro,
    getGroupChatState, saveChatState, getSettings,
} from '../core/storage.js';
import { resolveGroupTemplate, rollMacros, previewTemplate } from '../core/macro-engine.js';
import { generateId, showToast, confirmDialog, escapeHtml } from '../utils/dom.js';

let _container = null;
let _editingGroupId = null;   // null = new group
let _editingMacroId = null;   // null = new macro
let _groupMacros   = [];      // macros being edited in the group modal
let _macroOptions  = [];      // options being edited in the macro modal
let _rendered = false;

// ── Entry Point ───────────────────────────────────────────────────────────────

export async function renderManageView(container) {
    if (_rendered) {
        refreshGroupList();
        return;
    }
    _rendered = true;
    _container = container;
    
    const html = await renderExtensionTemplateAsync('third-party/random', 'templates/view-manage');
    container.innerHTML = html;
    
    _bindToolbar(container);
    _bindGroupModal(container);
    _bindMacroModal(container);
    refreshGroupList();
}

// ── Group List ────────────────────────────────────────────────────────────────

export function refreshGroupList() {
    if (!_container) return;
    const listEl = _container.querySelector('#random-group-list');
    const emptyEl = _container.querySelector('#random-groups-empty');
    if (!listEl) return;
    
    const groups = getAllGroups();
    
    // Remove old cards (keep empty hint)
    listEl.querySelectorAll('.random-group-card').forEach(el => el.remove());
    
    if (groups.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    
    groups.forEach(group => {
        const card = _buildGroupCard(group);
        listEl.appendChild(card);
    });
}

function _buildGroupCard(group) {
    const groupState = getGroupChatState(group.id);
    const pinnedMacros = new Set(groupState.pinnedMacros || []);
    
    // Resolve current preview
    const preview = group.template
        ? previewTemplate(group.template, groupState.currentValues || {})
        : '（无模板）';
    
    const card = document.createElement('div');
    card.className = `random-group-card${group.enabled ? '' : ' random-group-card--disabled'}`;
    card.dataset.groupId = group.id;
    
    card.innerHTML = `
        <div class="random-group-card-header">
            <div class="random-group-card-title-row">
                <label class="random-toggle random-toggle--sm">
                    <input type="checkbox" class="random-gc-enable" ${group.enabled ? 'checked' : ''} />
                    <span class="random-toggle-slider"></span>
                </label>
                <span class="random-group-card-name">${escapeHtml(group.name || '未命名组')}</span>
                <span class="random-group-card-scope">${group.scope === 'global' ? '全局' : '角色卡'}</span>
            </div>
            <div class="random-group-card-actions">
                <button class="random-icon-btn random-gc-scan" title="重新扫描模板宏并自动绑定">
                    <i class="fa-solid fa-magnifying-glass"></i>
                </button>
                <button class="random-icon-btn random-gc-reroll" title="重新Roll此组所有宏">
                    <i class="fa-solid fa-rotate"></i>
                </button>
                <button class="random-icon-btn random-gc-edit" title="编辑">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="random-icon-btn random-gc-delete random-icon-btn--danger" title="删除">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
        <div class="random-group-card-preview">${escapeHtml(preview)}</div>
        <div class="random-group-card-macros" id="random-gc-macros-${group.id}">
            ${_buildMacroChips(group, groupState, pinnedMacros)}
        </div>
        <div class="random-group-card-meta">
            <span><i class="fa-solid fa-arrow-down-1-9"></i> 深度 ${group.injectionDepth ?? 4}</span>
            <span><i class="fa-solid fa-user-tag"></i> ${_roleLabel(group.injectionRole)}</span>
            ${_lifecycleMeta(group)}
        </div>
    `;
    
    // Enable toggle
    card.querySelector('.random-gc-enable').addEventListener('change', e => {
        group.enabled = e.target.checked;
        saveGroup(group);
        card.classList.toggle('random-group-card--disabled', !group.enabled);
    });
    
    // Scan and auto bind macros from template
    card.querySelector('.random-gc-scan')?.addEventListener('click', () => {
        const tpl = group.template || '';
        const matches = [...tpl.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
        const uniqueIds = [...new Set(matches.filter(id => id.length > 0))];

        if (uniqueIds.length === 0) {
            showToast(`宏组「${group.name}」的模板中未发现 {{random_宏ID}}`, 'info');
            return;
        }

        let updated = false;
        if (!group.macros) group.macros = [];
        uniqueIds.forEach(id => {
            if (!group.macros.includes(id)) {
                group.macros.push(id);
                updated = true;
            }
            if (!getMacroById(id)) {
                saveMacro({ id, triggerProbability: 100, options: [] });
            }
        });

        if (updated) saveGroup(group);
        refreshGroupList();
        showToast(`已重新扫描并为「${group.name}」同步绑定 ${uniqueIds.length} 个宏`, 'success');
    });

    // Re-roll button
    card.querySelector('.random-gc-reroll').addEventListener('click', () => {
        const state = getGroupChatState(group.id);
        const { newValues } = resolveGroupTemplate(group, state, true);
        state.currentValues = newValues;
        saveChatState();
        refreshGroupList();
        showToast(`已重新Roll: ${group.name}`, 'success');
    });
    
    // Edit button
    card.querySelector('.random-gc-edit').addEventListener('click', () => {
        openGroupModal(group.id);
    });
    
    // Delete button
    card.querySelector('.random-gc-delete').addEventListener('click', () => {
        if (!confirmDialog(`确认删除宏配置组「${group.name}」？`)) return;
        deleteGroup(group.id);
        refreshGroupList();
        showToast(`已删除: ${group.name}`, 'info');
    });
    
    // Pin buttons on macro chips
    card.querySelectorAll('.random-macro-chip-pin').forEach(pinBtn => {
        pinBtn.addEventListener('click', () => {
            const macroId = pinBtn.dataset.macroId;
            const state = getGroupChatState(group.id);
            const pins = state.pinnedMacros || [];
            const idx = pins.indexOf(macroId);
            if (idx === -1) {
                pins.push(macroId);
            } else {
                pins.splice(idx, 1);
            }
            state.pinnedMacros = pins;
            saveChatState();
            refreshGroupList();
        });
    });
    
    // Individual macro re-roll on chip
    card.querySelectorAll('.random-macro-chip-reroll').forEach(rollBtn => {
        rollBtn.addEventListener('click', () => {
            const macroId = rollBtn.dataset.macroId;
            const state = getGroupChatState(group.id);
            const newValues = rollMacros([macroId], state);
            state.currentValues = newValues;
            saveChatState();
            refreshGroupList();
        });
    });
    
    return card;
}

function _buildMacroChips(group, groupState, pinnedMacros) {
    const macroIds = group.macros || [];
    if (macroIds.length === 0) return '<span class="random-group-card-no-macros">无宏</span>';
    
    return macroIds.map(macroId => {
        const currentVal = groupState.currentValues?.[macroId] ?? '—';
        const isPinned = pinnedMacros.has(macroId);
        return `
            <div class="random-macro-chip${isPinned ? ' random-macro-chip--pinned' : ''}">
                <span class="random-macro-chip-id">{{random_${escapeHtml(macroId)}}}</span>
                <span class="random-macro-chip-val">${escapeHtml(String(currentVal))}</span>
                <button class="random-macro-chip-reroll random-icon-btn--xs" data-macro-id="${escapeHtml(macroId)}" title="单独Roll此宏">
                    <i class="fa-solid fa-rotate"></i>
                </button>
                <button class="random-macro-chip-pin random-icon-btn--xs${isPinned ? ' active' : ''}" data-macro-id="${escapeHtml(macroId)}" title="${isPinned ? '解除固定' : '固定此宏'}">
                    <i class="fa-solid fa-thumbtack"></i>
                </button>
            </div>
        `;
    }).join('');
}

function _roleLabel(role) {
    const labels = { 0: 'System', 1: 'User', 2: 'Assistant' };
    return labels[Number(role)] || 'System';
}

function _lifecycleMeta(group) {
    const lc = group.lifecycle?.useGlobal !== false
        ? (getSettings().globalLifecycle || {})
        : (group.lifecycle || {});
    const parts = [];
    if (lc.everyXRounds) parts.push(`每${lc.everyXRounds}轮`);
    if (lc.keepYRounds)  parts.push(`保持${lc.keepYRounds}轮`);
    return parts.length
        ? `<span><i class="fa-solid fa-clock-rotate-left"></i> ${parts.join(' / ')}</span>`
        : '';
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function _bindToolbar(container) {
    container.querySelector('#random-add-group-btn')?.addEventListener('click', () => {
        openGroupModal(null);
    });
    
    container.querySelector('#random-reroll-all-btn')?.addEventListener('click', () => {
        const groups = getAllGroups().filter(g => g.enabled);
        if (groups.length === 0) { showToast('没有启用的宏组', 'info'); return; }
        groups.forEach(group => {
            const state = getGroupChatState(group.id);
            const { newValues } = resolveGroupTemplate(group, state, true);
            state.currentValues = newValues;
        });
        saveChatState();
        refreshGroupList();
        showToast('所有启用的宏组已重新Roll', 'success');
    });
}

// ── Group Modal ───────────────────────────────────────────────────────────────

function openGroupModal(groupId) {
    _editingGroupId = groupId;
    const modal = _container.querySelector('#random-group-modal');
    if (!modal) return;
    
    const isNew = !groupId;
    _container.querySelector('#random-group-modal-title').textContent = isNew ? '新建宏配置组' : '编辑宏配置组';
    
    const group = isNew ? _defaultGroup() : (getGroupById(groupId) || _defaultGroup());
    _groupMacros = (group.macros || []).map(id => getMacroById(id)).filter(Boolean);
    
    // Fill fields
    _setVal(modal, '#random-gm-name',        group.name || '');
    _setVal(modal, '#random-gm-scope',       group.scope === `character:${getContext().characterId}` ? 'character' : 'global');
    _setCheck(modal, '#random-gm-enabled',   group.enabled !== false);
    _setVal(modal, '#random-gm-role',        String(group.injectionRole ?? 0));
    _setVal(modal, '#random-gm-depth',       group.injectionDepth ?? 4);
    _setVal(modal, '#random-gm-template',    group.template || '');
    
    const useGlobal = group.lifecycle?.useGlobal !== false;
    _setCheck(modal, '#random-gm-lifecycle-global', useGlobal);
    modal.querySelector('#random-gm-lifecycle-custom').style.display = useGlobal ? 'none' : '';
    
    const lc = group.lifecycle || {};
    _setVal(modal, '#random-gm-every-x', lc.everyXRounds ?? '');
    _setVal(modal, '#random-gm-keep-y',  lc.keepYRounds  ?? '');
    
    _renderGroupMacroList(modal);
    modal.style.display = 'flex';
}

function _defaultGroup() {
    return {
        id: generateId(),
        name: '',
        scope: 'global',
        enabled: true,
        injectionDepth: 4,
        injectionRole: 0,
        template: '',
        macros: [],
        lifecycle: { useGlobal: true, everyXRounds: null, keepYRounds: null },
    };
}

function _bindGroupModal(container) {
    const modal = container.querySelector('#random-group-modal');
    if (!modal) return;
    
    modal.querySelector('#random-group-modal-close')?.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.querySelector('#random-group-modal-cancel')?.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    // Lifecycle global toggle
    modal.querySelector('#random-gm-lifecycle-global')?.addEventListener('change', e => {
        modal.querySelector('#random-gm-lifecycle-custom').style.display = e.target.checked ? 'none' : '';
    });
    
    // Add macro button
    modal.querySelector('#random-gm-add-macro-btn')?.addEventListener('click', () => {
        openMacroModal(null, true);
    });

    // Scan template for {{random_xxx}}
    modal.querySelector('#random-gm-scan-btn')?.addEventListener('click', () => {
        const tpl = modal.querySelector('#random-gm-template')?.value || '';
        const matches = [...tpl.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
        const uniqueIds = [...new Set(matches.filter(id => id.length > 0))];

        if (uniqueIds.length === 0) {
            showToast('未在模板中检测到 {{random_宏ID}}', 'info');
            return;
        }

        let addedCount = 0;
        uniqueIds.forEach(id => {
            const exists = _groupMacros.some(m => m.id === id);
            if (!exists) {
                const globalMacro = getMacroById(id);
                if (globalMacro) {
                    _groupMacros.push({ ...globalMacro });
                } else {
                    _groupMacros.push({ id, triggerProbability: 100, options: [] });
                }
                addedCount++;
            }
        });

        _renderGroupMacroList(modal);
        showToast(addedCount > 0 ? `已自动补齐 ${addedCount} 个宏` : '所有模板中的宏已在列表中', 'success');
    });
    
    // Save group
    modal.querySelector('#random-group-modal-save')?.addEventListener('click', () => {
        _saveGroupFromModal(modal);
    });
}

function _renderGroupMacroList(modal) {
    const listEl = modal.querySelector('#random-gm-macro-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    if (_groupMacros.length === 0) {
        listEl.innerHTML = '<div class="random-empty-hint--sm">还没有宏，点击「添加宏」或「扫描模板宏」</div>';
        return;
    }
    
    _groupMacros.forEach((macro, idx) => {
        const item = document.createElement('div');
        item.className = 'random-gm-macro-item';
        item.innerHTML = `
            <span class="random-gm-macro-id">{{random_${escapeHtml(macro.id)}}}</span>
            <span class="random-gm-macro-info">${macro.options?.length || 0} 个选项 / 触发率 ${macro.triggerProbability ?? 100}%</span>
            <div class="random-gm-macro-actions">
                <button class="random-icon-btn--xs random-gm-macro-edit" title="编辑此宏">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="random-icon-btn--xs random-gm-macro-remove random-icon-btn--danger" title="从组中移除">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>
        `;
        item.querySelector('.random-gm-macro-edit').addEventListener('click', () => {
            openMacroModal(macro.id, false);
        });
        item.querySelector('.random-gm-macro-remove').addEventListener('click', () => {
            _groupMacros.splice(idx, 1);
            _renderGroupMacroList(modal);
        });
        listEl.appendChild(item);
    });
}

function _saveGroupFromModal(modal) {
    const name = modal.querySelector('#random-gm-name')?.value.trim();
    if (!name) { showToast('请填写组名称', 'error'); return; }
    
    const isNew = !_editingGroupId;
    const existing = isNew ? _defaultGroup() : (getGroupById(_editingGroupId) || _defaultGroup());
    
    const scopeVal = modal.querySelector('#random-gm-scope')?.value;
    const charId   = getContext().characterId;
    const scope    = scopeVal === 'character' && charId !== undefined
        ? `character:${charId}`
        : 'global';
    
    const useGlobal = modal.querySelector('#random-gm-lifecycle-global')?.checked !== false;
    const everyXRaw = modal.querySelector('#random-gm-every-x')?.value.trim();
    const keepYRaw  = modal.querySelector('#random-gm-keep-y')?.value.trim();
    const templateText = modal.querySelector('#random-gm-template')?.value || '';

    // Auto scan and ensure all macros in template exist
    const templateMacros = [...templateText.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
    templateMacros.forEach(id => {
        if (id && !_groupMacros.some(m => m.id === id)) {
            const existingGlobal = getMacroById(id);
            _groupMacros.push(existingGlobal ? { ...existingGlobal } : { id, triggerProbability: 100, options: [] });
        }
    });
    
    const group = {
        ...existing,
        name,
        scope,
        enabled:        modal.querySelector('#random-gm-enabled')?.checked !== false,
        injectionRole:  Number(modal.querySelector('#random-gm-role')?.value ?? 0),
        injectionDepth: Number(modal.querySelector('#random-gm-depth')?.value ?? 4),
        template:       templateText,
        macros:         _groupMacros.map(m => m.id),
        lifecycle: {
            useGlobal,
            everyXRounds: useGlobal || everyXRaw === '' ? null : Number(everyXRaw),
            keepYRounds:  useGlobal || keepYRaw  === '' ? null : Number(keepYRaw),
        },
    };
    
    // Save all macros in this group
    _groupMacros.forEach(m => saveMacro(m));
    saveGroup(group);
    
    modal.style.display = 'none';
    refreshGroupList();
    import('./view-generate.js').then(m => m.refreshGenerateViewSelectors?.());
    showToast(isNew ? '宏配置组已创建' : '宏配置组已更新', 'success');
}

// ── Macro Modal ───────────────────────────────────────────────────────────────

/**
 * Open the macro editor modal.
 * @param {string|null} macroId - null for new macro
 * @param {boolean} addToGroup - if true, add to _groupMacros on save
 */
function openMacroModal(macroId, addToGroup) {
    _editingMacroId = macroId;
    const modal = _container.querySelector('#random-macro-modal');
    if (!modal) return;
    
    const isNew = !macroId;
    _container.querySelector('#random-macro-modal-title').textContent = isNew ? '新建宏' : '编辑宏';
    
    const macro = isNew
        ? { id: '', triggerProbability: 100, options: [] }
        : (getMacroById(macroId) || _groupMacros.find(m => m.id === macroId) || { id: macroId, triggerProbability: 100, options: [] });
    
    _macroOptions = (macro.options || []).map(o => ({ ...o }));
    
    _setVal(modal, '#random-mm-id',   macro.id || '');
    _setVal(modal, '#random-mm-prob', macro.triggerProbability ?? 100);
    
    modal.querySelector('#random-mm-id').readOnly = !isNew && !!macroId;
    
    _renderOptionList(modal);
    modal.style.display = 'flex';
    
    // Store addToGroup flag
    modal.dataset.addToGroup = addToGroup ? '1' : '0';
}

function _bindMacroModal(container) {
    const modal = container.querySelector('#random-macro-modal');
    if (!modal) return;
    
    modal.querySelector('#random-macro-modal-close')?.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    modal.querySelector('#random-macro-modal-cancel')?.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    modal.querySelector('#random-mm-add-option-btn')?.addEventListener('click', () => {
        _macroOptions.push({ text: '', weight: 1, tag: '' });
        _renderOptionList(modal);
    });
    
    modal.querySelector('#random-macro-modal-save')?.addEventListener('click', () => {
        _saveMacroFromModal(modal);
    });
}

function _renderOptionList(modal) {
    const listEl = modal.querySelector('#random-mm-option-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    if (_macroOptions.length === 0) {
        listEl.innerHTML = '<div class="random-empty-hint--sm">还没有选项，点击「添加选项」</div>';
        return;
    }
    
    _macroOptions.forEach((opt, idx) => {
        const row = document.createElement('div');
        row.className = 'random-option-row';
        row.innerHTML = `
            <input type="text"   class="random-input random-opt-text"   value="${escapeHtml(opt.text || '')}"  placeholder="选项内容（支持嵌套 {{random_xxx}}）" />
            <input type="number" class="random-input random-opt-weight random-input--narrow" value="${opt.weight ?? 1}" min="0" step="1" title="权重" />
            <input type="text"   class="random-input random-opt-tag random-input--narrow"    value="${escapeHtml(opt.tag || '')}" placeholder="标签(可选)" />
            <button class="random-icon-btn--xs random-opt-delete random-icon-btn--danger" title="删除">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        
        row.querySelector('.random-opt-text').addEventListener('input', e => {
            _macroOptions[idx].text = e.target.value;
        });
        row.querySelector('.random-opt-weight').addEventListener('input', e => {
            _macroOptions[idx].weight = Number(e.target.value) || 1;
        });
        row.querySelector('.random-opt-tag').addEventListener('input', e => {
            _macroOptions[idx].tag = e.target.value;
        });
        row.querySelector('.random-opt-delete').addEventListener('click', () => {
            _macroOptions.splice(idx, 1);
            _renderOptionList(modal);
        });
        
        listEl.appendChild(row);
    });
}

function _saveMacroFromModal(modal) {
    const idInput = modal.querySelector('#random-mm-id');
    const id = idInput?.value.trim();
    if (!id) { showToast('请填写宏 ID', 'error'); return; }
    if (!/^[\u4e00-\u9fffa-zA-Z0-9_-]+$/.test(id)) {
        showToast('宏 ID 只能包含汉字、字母、数字、_ 或 -', 'error');
        return;
    }
    
    const macro = {
        id,
        triggerProbability: Number(modal.querySelector('#random-mm-prob')?.value ?? 100),
        options: _macroOptions.map(o => ({ ...o })),
    };
    
    const addToGroup = modal.dataset.addToGroup === '1';
    
    if (addToGroup) {
        // Add/update in the in-memory group macros list
        const existingIdx = _groupMacros.findIndex(m => m.id === id);
        if (existingIdx !== -1) {
            _groupMacros[existingIdx] = macro;
        } else {
            _groupMacros.push(macro);
        }
        // Update UI in group modal
        const groupModal = _container.querySelector('#random-group-modal');
        if (groupModal) _renderGroupMacroList(groupModal);
    } else {
        // Update existing macro in place
        const existingIdx = _groupMacros.findIndex(m => m.id === _editingMacroId);
        if (existingIdx !== -1) _groupMacros[existingIdx] = macro;
        saveMacro(macro);
        const groupModal = _container.querySelector('#random-group-modal');
        if (groupModal) _renderGroupMacroList(groupModal);
    }
    
    modal.style.display = 'none';
    showToast(addToGroup ? '宏已添加到组' : '宏已更新', 'success');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _setVal(container, selector, value) {
    const el = container.querySelector(selector);
    if (el) el.value = value !== undefined && value !== null ? String(value) : '';
}

function _setCheck(container, selector, checked) {
    const el = container.querySelector(selector);
    if (el) el.checked = !!checked;
}
