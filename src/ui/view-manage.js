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
import { clearGroupInjection, isGroupInjected, forceNextInjection } from '../core/injection.js';
import { generateId, showToast, confirmDialog, escapeHtml } from '../utils/dom.js';

let _container = null;
let _editingGroupId = null;   // null = new group
let _editingMacroId = null;   // null = new macro
let _groupMacros   = [];      // macros being edited in the group modal
let _macroOptions  = [];      // options being edited in the macro modal
let _showMacroWeights = false; // whether weight column is displayed in macro modal
let _showMacroTags = false;   // whether tag column is displayed in macro modal
let _rendered = false;
let _groupListViewMode = 'flat'; // 'flat' | 'tree'
const _macroModalStack = []; // breadcrumb history stack for drill-down navigation
let _multilineMode = false; // whether multiline text batch mode is active
const _collapsedTreeIds = new Set(); // collapsed macro IDs in tree view
let _lastActiveOptionInput = null; // last focused option input for quick insert
const _collapsedCategoryNames = new Set(); // set of collapsed category names
const _collapsedGroupIds = new Set(); // set of collapsed group IDs
const _expandedGroupMacroPills = new Set(); // set of group IDs where all nested macros are expanded in card view
const _selectedMacroIds  = new Set(); // set of macro IDs selected for batch operations
let _lastCheckedIndex    = -1;        // last clicked macro index for shift-selection (连选)
let _rangeAnchorIndex    = -1;        // start anchor index for range selection mode
let _batchMode           = false;     // whether batch selection mode is active in group modal
let _rangeMode           = false;     // whether physical range selection mode (连选) is active for mobile/desktop

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
    
    // Teleport modal overlays directly to document.body so CSS transforms on parent panel containers don't trap position:fixed!
    ['#random-group-modal', '#random-macro-modal', '#random-inspect-modal'].forEach(sel => {
        const modalEl = container.querySelector(sel);
        if (modalEl) {
            document.body.appendChild(modalEl);
        }
    });

    _bindToolbar(container);
    _bindGroupModal(document.body);
    _bindMacroModal(document.body);
    _bindInspectModal(document.body);
    refreshGroupList();
}

// ── Group List ────────────────────────────────────────────────────────────────

export function refreshGroupList() {
    if (!_container) return;
    const listEl = _container.querySelector('#random-group-list');
    const emptyEl = _container.querySelector('#random-groups-empty');
    if (!listEl) return;
    
    // Save scroll positions to prevent jumping to top on reroll
    const listScrollTop = listEl.scrollTop;
    const bodyEl = _container.closest('.random-body') || _container.parentElement;
    const bodyScrollTop = bodyEl ? bodyEl.scrollTop : 0;
    
    const groups = getAllGroups();
    
    // Remove old category sections & cards (keep empty hint)
    listEl.querySelectorAll('.random-category-section, .random-group-card').forEach(el => el.remove());
    
    if (groups.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const settings = getSettings();
    const enableGrouping = settings?.misc?.enableCategoryGrouping !== false;

    if (!enableGrouping) {
        // Flat list without category folder headers
        groups.forEach(group => {
            listEl.appendChild(_buildGroupCard(group));
        });
        listEl.scrollTop = listScrollTop;
        if (bodyEl) bodyEl.scrollTop = bodyScrollTop;
        return;
    }

    // Group by category
    const categoryMap = new Map();
    groups.forEach(group => {
        const cat = (group.category || '').trim() || '未分类';
        if (!categoryMap.has(cat)) categoryMap.set(cat, []);
        categoryMap.get(cat).push(group);
    });

    // Sort categories: named categories first (alphabetically), '未分类' at the end
    const sortedCategories = Array.from(categoryMap.keys()).sort((a, b) => {
        if (a === '未分类') return 1;
        if (b === '未分类') return -1;
        return a.localeCompare(b, 'zh-CN');
    });

    sortedCategories.forEach(catName => {
        const catGroups = categoryMap.get(catName);
        const isCatCollapsed = _collapsedCategoryNames.has(catName);
        const allEnabled = catGroups.every(g => g.enabled);

        const sectionEl = document.createElement('div');
        sectionEl.className = `random-category-section${isCatCollapsed ? ' random-category-section--collapsed' : ''}`;
        sectionEl.dataset.category = catName;

        sectionEl.innerHTML = `
            <div class="random-category-header">
                <div class="random-category-title-row" style="cursor:pointer;" title="点击折叠/展开分类">
                    <button class="random-icon-btn--xs random-cat-collapse-btn" title="${isCatCollapsed ? '展开分类' : '折叠分类'}">
                        <i class="fa-solid ${isCatCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
                    </button>
                    <i class="fa-solid ${isCatCollapsed ? 'fa-folder' : 'fa-folder-open'}" style="color:var(--random-accent);"></i>
                    <span class="random-category-name">${escapeHtml(catName)}</span>
                    <span class="random-category-count">${catGroups.length}</span>
                </div>
                <div class="random-category-actions">
                    <label class="random-toggle random-toggle--sm" title="一键启用/禁用该分类下的所有宏组">
                        <input type="checkbox" class="random-cat-enable-all" ${allEnabled ? 'checked' : ''} />
                        <span class="random-toggle-slider"></span>
                    </label>
                    <button class="random-icon-btn random-cat-reroll" title="重新Roll「${escapeHtml(catName)}」分类下的所有宏组">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                </div>
            </div>
            <div class="random-category-body" style="${isCatCollapsed ? 'display:none;' : ''}"></div>
        `;

        const bodyEl = sectionEl.querySelector('.random-category-body');
        catGroups.forEach(group => {
            const card = _buildGroupCard(group);
            bodyEl.appendChild(card);
        });

        // Collapse / Expand toggle on arrow button
        sectionEl.querySelector('.random-cat-collapse-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const iconEl = sectionEl.querySelector('.random-cat-collapse-btn i');
            const folderEl = sectionEl.querySelector('.random-category-title-row > .fa-solid');
            const btnEl = sectionEl.querySelector('.random-cat-collapse-btn');
            if (_collapsedCategoryNames.has(catName)) {
                _collapsedCategoryNames.delete(catName);
                if (bodyEl) bodyEl.style.display = '';
                if (iconEl) iconEl.className = 'fa-solid fa-chevron-down';
                if (folderEl) folderEl.className = 'fa-solid fa-folder-open';
                if (btnEl) btnEl.title = '折叠分类';
                sectionEl.classList.remove('random-category-section--collapsed');
            } else {
                _collapsedCategoryNames.add(catName);
                if (bodyEl) bodyEl.style.display = 'none';
                if (iconEl) iconEl.className = 'fa-solid fa-chevron-right';
                if (folderEl) folderEl.className = 'fa-solid fa-folder';
                if (btnEl) btnEl.title = '展开分类';
                sectionEl.classList.add('random-category-section--collapsed');
            }
        });

        // Header click toggles collapse as well
        sectionEl.querySelector('.random-category-title-row')?.addEventListener('click', (e) => {
            if (e.target.closest('.random-cat-collapse-btn')) return;
            sectionEl.querySelector('.random-cat-collapse-btn')?.click();
        });

        // Category Enable / Disable all
        sectionEl.querySelector('.random-cat-enable-all')?.addEventListener('change', (e) => {
            const enabled = e.target.checked;
            catGroups.forEach(group => {
                group.enabled = enabled;
                saveGroup(group);
                if (!enabled) {
                    clearGroupInjection(group.id);
                }
            });
            refreshGroupList();
            showToast(`已${enabled ? '启用' : '禁用'}「${catName}」下的所有宏组`, 'info');
        });

        // Category Re-roll all
        sectionEl.querySelector('.random-cat-reroll')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const enabledGroups = catGroups.filter(g => g.enabled);
            if (enabledGroups.length === 0) {
                showToast(`「${catName}」中没有已启用的宏组`, 'info');
                return;
            }
            enabledGroups.forEach(group => {
                const state = getGroupChatState(group.id);
                const { newValues } = resolveGroupTemplate(group, state, true);
                state.currentValues = newValues;
            });
            saveChatState();
            refreshGroupList();
            showToast(`已重新Roll「${catName}」下的 ${enabledGroups.length} 个宏组`, 'success');
        });

        listEl.appendChild(sectionEl);
    });

    // Restore scroll positions immediately & in next animation frame
    listEl.scrollTop = listScrollTop;
    if (bodyEl) bodyEl.scrollTop = bodyScrollTop;
    requestAnimationFrame(() => {
        if (listEl) listEl.scrollTop = listScrollTop;
        if (bodyEl) bodyEl.scrollTop = bodyScrollTop;
    });
}

function _buildGroupCard(group) {
    const groupState = getGroupChatState(group.id);
    const pinnedMacros = new Set(groupState.pinnedMacros || []);
    const isCollapsed = _collapsedGroupIds.has(group.id);
    
    // Resolve current preview
    const preview = group.template
        ? previewTemplate(group.template, groupState.currentValues || {})
        : '（无模板）';
    
    const card = document.createElement('div');
    card.className = `random-group-card${group.enabled ? '' : ' random-group-card--disabled'}${isCollapsed ? ' random-group-card--collapsed' : ''}`;
    card.dataset.groupId = group.id;
    
    // Determine whether this group has a periodic lifecycle (needed for button visibility)
    const _lc = group.lifecycle?.useGlobal !== false
        ? (getSettings().globalLifecycle || {})
        : (group.lifecycle || {});
    const _hasPeriod = (_lc.everyXRounds && Number(_lc.everyXRounds) > 1) || (_lc.keepYRounds && Number(_lc.keepYRounds) > 1);
    const _gs = groupState;
    const _pos = _gs.roundInCycle ?? 0;
    const _isSkipping = _hasPeriod && !isGroupInjected(group.id);

    card.innerHTML = `
        <div class="random-group-card-header">
            <div class="random-group-card-title-row">
                <button class="random-icon-btn--xs random-gc-collapse-btn" title="${isCollapsed ? '展开宏组' : '折叠宏组'}">
                    <i class="fa-solid ${isCollapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
                </button>
                <label class="random-toggle random-toggle--sm">
                    <input type="checkbox" class="random-gc-enable" ${group.enabled ? 'checked' : ''} />
                    <span class="random-toggle-slider"></span>
                </label>
                <span class="random-group-card-name">${escapeHtml(group.name || '未命名组')}</span>
                ${group.exclusivePool ? `<span class="random-group-card-pool" title="互斥池「${escapeHtml(group.exclusivePool)}」：同池每轮随机选1个生效"><i class="fa-solid fa-shuffle"></i> ${escapeHtml(group.exclusivePool)}</span>` : ''}
                ${group.category ? `<span class="random-group-card-category"><i class="fa-solid fa-folder"></i> ${escapeHtml(group.category)}</span>` : ''}
                <span class="random-group-card-scope">${group.scope === 'global' ? '全局' : '角色卡'}</span>
            </div>
            <div class="random-group-card-actions">
                <button class="random-icon-btn random-gc-scan" title="重新扫描模板宏并自动绑定">
                    <i class="fa-solid fa-satellite-dish"></i>
                </button>
                <button class="random-icon-btn random-gc-reroll" title="重新Roll此组所有宏">
                    <i class="fa-solid fa-rotate"></i>
                </button>
                ${_hasPeriod ? `<button class="random-icon-btn random-gc-force-inject" title="下轮立即注入（重置周期）"><i class="fa-solid fa-forward-step"></i></button>` : ''}
                <button class="random-icon-btn random-gc-edit" title="编辑">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="random-icon-btn random-gc-delete random-icon-btn--danger" title="删除">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        </div>
        <div class="random-group-card-preview">${escapeHtml(preview)}</div>
        <div class="random-group-card-body" style="${isCollapsed ? 'display:none;' : ''}">
            <div class="random-group-card-macros" id="random-gc-macros-${group.id}">
                ${_buildMacroChips(group, groupState, pinnedMacros)}
            </div>
            <div class="random-group-card-meta">
                <span><i class="fa-solid fa-arrow-down-1-9"></i> 深度 ${group.injectionDepth ?? 4}</span>
                <span><i class="fa-solid fa-arrow-down-short-wide"></i> 顺序 ${group.injectionOrder ?? 0}</span>
                <span><i class="fa-solid fa-user-tag"></i> ${_roleLabel(group.injectionRole)}</span>
                ${_lifecycleMeta(group)}
            </div>
        </div>
    `;


    // Collapse / Expand toggle
    card.querySelector('.random-gc-collapse-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const bodyEl = card.querySelector('.random-group-card-body');
        const iconEl = card.querySelector('.random-gc-collapse-btn i');
        const btnEl  = card.querySelector('.random-gc-collapse-btn');
        if (_collapsedGroupIds.has(group.id)) {
            _collapsedGroupIds.delete(group.id);
            if (bodyEl) bodyEl.style.display = '';
            if (iconEl) iconEl.className = 'fa-solid fa-chevron-down';
            if (btnEl)  btnEl.title = '折叠宏组';
            card.classList.remove('random-group-card--collapsed');
        } else {
            _collapsedGroupIds.add(group.id);
            if (bodyEl) bodyEl.style.display = 'none';
            if (iconEl) iconEl.className = 'fa-solid fa-chevron-right';
            if (btnEl)  btnEl.title = '展开宏组';
            card.classList.add('random-group-card--collapsed');
        }
    });
    
    // Enable toggle
    card.querySelector('.random-gc-enable').addEventListener('change', e => {
        group.enabled = e.target.checked;
        saveGroup(group);
        if (!group.enabled) {
            clearGroupInjection(group.id);
        }
        card.classList.toggle('random-group-card--disabled', !group.enabled);
    });
    
    // Scan and auto bind macros from template (recursively including nested macros)
    card.querySelector('.random-gc-scan')?.addEventListener('click', () => {
        const uniqueIds = _collectAllReferencedMacroIds(group.template, (group.macros || []).map(id => getMacroById(id)).filter(Boolean));

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
        showToast(`已递归扫描并为「${group.name}」同步绑定 ${uniqueIds.length} 个层级宏`, 'success');
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

    // Force-inject button (periodic only): resets cycle to 0 so next generation injects
    card.querySelector('.random-gc-force-inject')?.addEventListener('click', () => {
        forceNextInjection(group.id);
        refreshGroupList();
        showToast(`${group.name}：下轮将立即注入`, 'success');
    });

    // Edit button
    card.querySelector('.random-gc-edit').addEventListener('click', () => {
        openGroupModal(group.id);
    });

    // Delete button
    card.querySelector('.random-gc-delete').addEventListener('click', () => {
        if (!confirmDialog(`确认删除宏配置组「${group.name}」？`)) return;
        clearGroupInjection(group.id);
        deleteGroup(group.id);
        refreshGroupList();
        showToast(`已删除: ${group.name}`, 'info');
    });

    _bindMacroChipEvents(card, group);

    return card;
}


function _updateCardMacroChipsInPlace(card, group) {
    const groupState = getGroupChatState(group.id);
    const pinnedMacros = new Set(groupState.pinnedMacros || []);
    const macrosContainer = card.querySelector(`#random-gc-macros-${group.id}`);
    if (!macrosContainer) return;
    macrosContainer.innerHTML = _buildMacroChips(group, groupState, pinnedMacros);
    _bindMacroChipEvents(card, group);
}

function _bindMacroChipEvents(card, group) {
    // Expand / Collapse sub-macros in card (pure UI toggle, in-place, zero re-rolls)
    card.querySelector('.random-macro-expand-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _expandedGroupMacroPills.add(group.id);
        _updateCardMacroChipsInPlace(card, group);
    });
    card.querySelector('.random-macro-collapse-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        _expandedGroupMacroPills.delete(group.id);
        _updateCardMacroChipsInPlace(card, group);
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
            _updateCardMacroChipsInPlace(card, group);
        });
    });
    
    // Individual macro re-roll on chip (with cascading parent update)
    card.querySelectorAll('.random-macro-chip-reroll').forEach(rollBtn => {
        rollBtn.addEventListener('click', () => {
            const macroId = rollBtn.dataset.macroId;
            const state = getGroupChatState(group.id);
            const newValues = rollMacros([macroId], state, group);
            state.currentValues = newValues;
            saveChatState();
            refreshGroupList();
        });
    });
}

function _buildMacroChips(group, groupState, pinnedMacros) {
    const macroIds = group.macros || [];
    if (macroIds.length === 0) return '<span class="random-group-card-no-macros">无宏</span>';
    
    // Extract root macros referenced in template
    const templateMatches = [...(group.template || '').matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim()).filter(Boolean);
    const templateRootIds = [...new Set(templateMatches)].filter(id => macroIds.includes(id));
    
    const isExpanded = _expandedGroupMacroPills.has(group.id);
    const hasSubMacros = templateRootIds.length > 0 && macroIds.length > templateRootIds.length;
    
    // Determine which macros to display
    let displayIds;
    if (isExpanded) {
        displayIds = macroIds;
    } else if (hasSubMacros) {
        displayIds = templateRootIds;
    } else if (macroIds.length > 8) {
        displayIds = macroIds.slice(0, 6);
    } else {
        displayIds = macroIds;
    }

    const hiddenCount = macroIds.length - displayIds.length;

    const chipsHtml = displayIds.map(macroId => {
        const currentVal = groupState.currentValues?.[macroId] ?? '—';
        const isPinned = pinnedMacros.has(macroId);
        const isRoot = templateRootIds.includes(macroId);
        
        // Count downstream children if any
        const macroObj = getMacroById(macroId);
        let childCount = 0;
        if (macroObj && Array.isArray(macroObj.options)) {
            const childSet = new Set();
            macroObj.options.forEach(opt => {
                const text = typeof opt === 'string' ? opt : (opt?.text || '');
                const m = [...text.matchAll(/\{\{random_([^}]+)\}\}/g)].map(x => x[1].trim());
                m.forEach(cId => { if (cId && cId !== macroId) childSet.add(cId); });
            });
            childCount = childSet.size;
        }

        const childBadge = childCount > 0 ? `<span class="random-macro-chip-subcount" title="包含 ${childCount} 个直接下级子宏">↓${childCount}</span>` : '';
        const rootBadge = (hasSubMacros && isExpanded && isRoot) ? `<span class="random-macro-chip-rootbadge" title="模板直接调用">主</span>` : '';

        return `
            <div class="random-macro-chip${isPinned ? ' random-macro-chip--pinned' : ''}${isRoot ? ' random-macro-chip--root' : ''}" data-macro-id="${escapeHtml(macroId)}">
                ${rootBadge}
                <span class="random-macro-chip-id">{{random_${escapeHtml(macroId)}}}</span>
                ${childBadge}
                <span class="random-macro-chip-val" title="${escapeHtml(String(currentVal))}">${escapeHtml(String(currentVal))}</span>
                <button class="random-macro-chip-reroll random-icon-btn--xs" data-macro-id="${escapeHtml(macroId)}" title="单独Roll此宏">
                    <i class="fa-solid fa-rotate"></i>
                </button>
                <button class="random-macro-chip-pin random-icon-btn--xs${isPinned ? ' active' : ''}" data-macro-id="${escapeHtml(macroId)}" title="${isPinned ? '解除固定' : '固定此宏'}">
                    <i class="fa-solid fa-thumbtack"></i>
                </button>
            </div>
        `;
    }).join('');

    let toggleBtnHtml = '';
    if (!isExpanded && hiddenCount > 0) {
        toggleBtnHtml = `
            <button class="random-macro-expand-btn" data-group-id="${group.id}" title="展开全部宏 (+${hiddenCount} 个子宏)">
                <i class="fa-solid fa-layer-group"></i> <span>+${hiddenCount}</span>
            </button>
        `;
    } else if (isExpanded && (hasSubMacros || macroIds.length > 8)) {
        toggleBtnHtml = `
            <button class="random-macro-collapse-btn" data-group-id="${group.id}" title="收起子宏，仅看模板主宏">
                <i class="fa-solid fa-compress"></i>
            </button>
        `;
    }

    return chipsHtml + toggleBtnHtml;
}

function _roleLabel(role) {
    const labels = { 0: 'System', 1: 'User', 2: 'Assistant' };
    return labels[Number(role)] || 'System';
}

function _lifecycleMeta(group) {
    if (group.enabled === false) return '';
    const lc = group.lifecycle?.useGlobal !== false
        ? (getSettings().globalLifecycle || {})
        : (group.lifecycle || {});
    const groupState = getGroupChatState(group.id);
    const pos = groupState.roundInCycle ?? 0;
    const everyX = lc.everyXRounds ? Number(lc.everyXRounds) : null;
    const keepY  = lc.keepYRounds  ? Number(lc.keepYRounds)  : null;

    const hasX = everyX !== null && everyX > 1;
    const hasY = keepY  !== null && keepY  > 1;

    let statusBadge = '';
    const parts = [];

    if (hasX) {
        // Periodic lifecycle: inject for keepY rounds at cycle start, skip the rest
        const injectWindow = hasY ? Math.min(keepY, everyX) : 1;
        const skipLen = everyX - injectWindow;

        if (pos < injectWindow) {
            // Within injection window
            if (pos === 0) {
                statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>本轮已注入 (新Roll)</span>`;
            } else {
                statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>本轮已注入 (保持第${pos + 1}/${injectWindow}轮)</span>`;
            }
            parts.push(`每${everyX}轮`);
            if (hasY) parts.push(`保持${keepY}轮 (${pos + 1}/${injectWindow})`);
        } else {
            // Within skip window
            const skipRemaining = everyX - pos;
            statusBadge = `<span class="random-status-badge random-status-badge--skipped"><span class="random-status-dot"></span>本轮未注入 (距下次${skipRemaining}轮)</span>`;
            parts.push(`每${everyX}轮`);
            if (hasY) parts.push(`保持${keepY}轮`);
        }
    } else if (hasY) {
        // No period but keep Y rounds: always inject, re-roll every Y rounds
        if (pos === 0) {
            statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>本轮已注入 (新Roll)</span>`;
        } else {
            statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>本轮已注入 (保持第${pos + 1}/${keepY}轮)</span>`;
        }
        parts.push(`保持${keepY}轮 (${pos + 1}/${keepY})`);
    } else {
        // No lifecycle constraint — show injected status only
        if (isGroupInjected(group.id)) {
            statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>本轮已注入</span>`;
        }
        if (everyX === 1) parts.push('每1轮');
    }

    const lifecycleText = parts.length
        ? `<span><i class="fa-solid fa-clock-rotate-left"></i> ${parts.join(' / ')}</span>`
        : '';

    return `${statusBadge}${lifecycleText}`;
}

// ── Toolbar ───────────────────────────────────────────────────────────────────

function _bindToolbar(container) {
    container.querySelector('#random-add-group-btn')?.addEventListener('click', () => {
        openGroupModal(null);
    });

    container.querySelector('#random-inspect-btn')?.addEventListener('click', () => {
        openInspectModal();
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

// ── Injection Inspector Modal ─────────────────────────────────────────────────

export async function openInspectModal() {
    if (!_container) {
        const { showPanel } = await import('./panel.js');
        await showPanel('manage');
    }
    const modal = document.getElementById('random-inspect-modal');
    if (!modal) return;
    _renderInspectContent(modal);
    modal.style.display = 'flex';
}

export function closeInspectModal() {
    const modal = document.getElementById('random-inspect-modal');
    if (modal) modal.style.display = 'none';
}

/**
 * Return programmatic snapshot of last injected items and next upcoming previews.
 * Suitable for consumption by external extensions or plugins.
 * @returns {{ totalRounds: number, activeGroupCount: number, lastInjected: Array, nextUpcoming: Array }}
 */
export function getInspectData() {
    const allGroups = getAllGroups();
    const activeGroups = allGroups.filter(g => g.enabled).sort((a, b) => (Number(a.injectionOrder) || 0) - (Number(b.injectionOrder) || 0));

    const lastInjected = [];
    activeGroups.forEach(group => {
        const state = getGroupChatState(group.id);
        const last = state.lastInjected;
        if (last) {
            lastInjected.push({
                groupId: group.id,
                groupName: group.name,
                injected: Boolean(last.injected),
                text: last.text || '',
                role: last.role ?? group.injectionRole ?? 0,
                roleLabel: _roleLabel(last.role ?? group.injectionRole ?? 0),
                depth: last.depth ?? group.injectionDepth ?? 4,
                order: last.order ?? group.injectionOrder ?? 0,
                skipped: Boolean(last.skipped),
                reason: last.reason || '',
                round: last.round ?? 0,
                timestamp: last.timestamp || 0,
            });
        }
    });

    const nextUpcoming = [];
    activeGroups.forEach(group => {
        const state = getGroupChatState(group.id);
        const lc = group.lifecycle?.useGlobal !== false
            ? (getSettings().globalLifecycle || {})
            : (group.lifecycle || {});
        const pos = state.roundInCycle ?? 0;
        const everyX = lc.everyXRounds ? Number(lc.everyXRounds) : null;
        const keepY  = lc.keepYRounds  ? Number(lc.keepYRounds)  : null;

        const hasX = everyX !== null && everyX > 1;
        const hasY = keepY  !== null && keepY  > 1;

        let willInject = true;
        let willReroll = true;
        let status = 'every_round';
        let statusText = '每次注入';
        let skipRemaining = 0;

        if (hasX) {
            const injectWindow = hasY ? Math.min(keepY, everyX) : 1;
            if (pos < injectWindow) {
                willInject = true;
                willReroll = (pos === 0);
                status = willReroll ? 'reroll' : 'keep';
                statusText = willReroll ? '下轮新Roll' : `保持中 (${pos + 1}/${injectWindow})`;
            } else {
                willInject = false;
                skipRemaining = everyX - pos;
                status = 'skipped';
                statusText = `下轮跳过 (距下次${skipRemaining}轮)`;
            }
        } else if (hasY) {
            willInject = true;
            willReroll = (pos === 0);
            status = willReroll ? 'reroll' : 'keep';
            statusText = willReroll ? '下轮新Roll' : `保持中 (${pos + 1}/${keepY})`;
        }

        const previewText = group.template
            ? previewTemplate(group.template, state.currentValues || {})
            : '';

        nextUpcoming.push({
            groupId: group.id,
            groupName: group.name,
            willInject,
            willReroll,
            status,
            statusText,
            skipRemaining,
            previewText: willInject ? previewText : '',
            role: group.injectionRole ?? 0,
            roleLabel: _roleLabel(group.injectionRole ?? 0),
            depth: group.injectionDepth ?? 4,
            order: group.injectionOrder ?? 0,
            cyclePos: pos,
        });
    });

    return {
        totalRounds: getChatState().totalRounds || 0,
        activeGroupCount: activeGroups.length,
        lastInjected,
        nextUpcoming,
    };
}

let _inspectActiveTab = 'next'; // 'next' | 'last'

function _bindInspectModal(container) {
    const modal = container.querySelector('#random-inspect-modal');
    if (!modal) return;

    modal.querySelector('#random-inspect-modal-close')?.addEventListener('click', closeInspectModal);
    modal.querySelector('#random-inspect-modal-confirm')?.addEventListener('click', closeInspectModal);

    const tabNext = modal.querySelector('#random-inspect-tab-next');
    const tabLast = modal.querySelector('#random-inspect-tab-last');
    const paneNext = modal.querySelector('#random-inspect-pane-next');
    const paneLast = modal.querySelector('#random-inspect-pane-last');

    const switchTab = (tab) => {
        _inspectActiveTab = tab;
        if (tab === 'next') {
            tabNext?.classList.add('random-inspect-tab-btn--active');
            tabLast?.classList.remove('random-inspect-tab-btn--active');
            if (paneNext) paneNext.style.display = '';
            if (paneLast) paneLast.style.display = 'none';
        } else {
            tabLast?.classList.add('random-inspect-tab-btn--active');
            tabNext?.classList.remove('random-inspect-tab-btn--active');
            if (paneLast) paneLast.style.display = '';
            if (paneNext) paneNext.style.display = 'none';
        }
    };

    tabNext?.addEventListener('click', () => switchTab('next'));
    tabLast?.addEventListener('click', () => switchTab('last'));

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeInspectModal();
    });
}

function _renderInspectContent(modal) {
    const lastListEl = modal.querySelector('#random-inspect-last-list');
    const nextListEl = modal.querySelector('#random-inspect-next-list');
    const lastBadgeEl = modal.querySelector('#random-inspect-last-badge');
    const nextBadgeEl = modal.querySelector('#random-inspect-next-badge');

    if (!lastListEl || !nextListEl) return;

    const allGroups = getAllGroups();
    const activeGroups = allGroups.filter(g => g.enabled).sort((a, b) => (Number(a.injectionOrder) || 0) - (Number(b.injectionOrder) || 0));

    // ── 1. 上一轮实际生效注入 ──
    const lastItems = [];
    activeGroups.forEach(group => {
        const state = getGroupChatState(group.id);
        const last = state.lastInjected;
        if (!last) return;

        if (last.injected && last.text) {
            lastItems.push(`
                <div class="random-inspect-item">
                    <div class="random-inspect-item-header">
                        <span class="random-inspect-item-title">
                            <i class="fa-solid fa-layer-group" style="color:var(--random-accent);"></i>
                            ${escapeHtml(group.name)}
                        </span>
                        <div class="random-inspect-item-meta">
                            ${group.exclusivePool ? `<span class="random-inspect-meta-pill" style="color:var(--random-accent);"><i class="fa-solid fa-shuffle"></i> 互斥池: ${escapeHtml(group.exclusivePool)}</span>` : ''}
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-user-tag"></i> ${_roleLabel(last.role ?? group.injectionRole)}</span>
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-arrow-down-1-9"></i> 深度 ${last.depth ?? group.injectionDepth ?? 4}</span>
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-arrow-down-short-wide"></i> 顺序 ${last.order ?? group.injectionOrder ?? 0}</span>
                            <span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>已生效</span>
                        </div>
                    </div>
                    <div class="random-inspect-item-content">
                        ${escapeHtml(last.text)}
                        <button class="random-icon-btn--xs random-inspect-copy-btn" data-text="${escapeHtml(last.text)}" title="复制此提示词">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                </div>
            `);
        } else if (last.skipped) {
            lastItems.push(`
                <div class="random-inspect-item">
                    <div class="random-inspect-item-header">
                        <span class="random-inspect-item-title">
                            <i class="fa-solid fa-layer-group" style="color:var(--random-text-muted);"></i>
                            ${escapeHtml(group.name)}
                        </span>
                        <div class="random-inspect-item-meta">
                            ${group.exclusivePool ? `<span class="random-inspect-meta-pill"><i class="fa-solid fa-shuffle"></i> 互斥池: ${escapeHtml(group.exclusivePool)}</span>` : ''}
                            <span class="random-status-badge random-status-badge--skipped"><span class="random-status-dot"></span>${escapeHtml(last.reason || '冷却跳过')}</span>
                        </div>
                    </div>
                    <div class="random-inspect-item-skipped">
                        <i class="fa-solid fa-ban"></i> ${escapeHtml(last.reason || '上一轮处于周期冷却跳过阶段，未向 AI 上下文注入内容')}
                    </div>
                </div>
            `);
        }
    });

    if (lastBadgeEl) {
        lastBadgeEl.textContent = lastItems.length ? `共 ${lastItems.length} 项记录` : '暂无记录';
    }
    lastListEl.innerHTML = lastItems.length
        ? lastItems.join('')
        : `<div class="random-inspect-empty"><i class="fa-solid fa-hourglass-start"></i> 当前会话尚未开始对话或尚未触发过注入</div>`;

    // ── 2. 下一轮即将注入预演 ──
    const nextItems = [];
    activeGroups.forEach(group => {
        const state = getGroupChatState(group.id);
        const lc = group.lifecycle?.useGlobal !== false
            ? (getSettings().globalLifecycle || {})
            : (group.lifecycle || {});
        const pos = state.roundInCycle ?? 0;
        const everyX = lc.everyXRounds ? Number(lc.everyXRounds) : null;
        const keepY  = lc.keepYRounds  ? Number(lc.keepYRounds)  : null;

        const hasX = everyX !== null && everyX > 1;
        const hasY = keepY  !== null && keepY  > 1;

        let willInject = true;
        let willReroll = true;
        let statusBadge = '';
        let statusDesc = '';

        if (hasX) {
            const injectWindow = hasY ? Math.min(keepY, everyX) : 1;
            if (pos < injectWindow) {
                willInject = true;
                willReroll = (pos === 0);
                if (pos === 0) {
                    statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>下轮新Roll</span>`;
                    statusDesc = '满足周期，下轮生成时将重新抽取随机宏填入';
                } else {
                    statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>保持中 (${pos + 1}/${injectWindow})</span>`;
                    statusDesc = `保持期第 ${pos + 1}/${injectWindow} 轮，将沿用当前抽取结果注入`;
                }
            } else {
                willInject = false;
                const skipRemaining = everyX - pos;
                statusBadge = `<span class="random-status-badge random-status-badge--skipped"><span class="random-status-dot"></span>下轮跳过 (距下次${skipRemaining}轮)</span>`;
                statusDesc = `处于周期冷却跳过阶段，距下次注入还剩 ${skipRemaining} 轮`;
            }
        } else if (hasY) {
            willInject = true;
            willReroll = (pos === 0);
            if (pos === 0) {
                statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>下轮新Roll</span>`;
                statusDesc = '保持期已满，下轮生成时将重新抽取随机宏填入';
            } else {
                statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>保持中 (${pos + 1}/${keepY})</span>`;
                statusDesc = `保持期第 ${pos + 1}/${keepY} 轮，将沿用当前抽取结果注入`;
            }
        } else {
            willInject = true;
            willReroll = true;
            statusBadge = `<span class="random-status-badge random-status-badge--injected"><span class="random-status-dot"></span>每次注入</span>`;
            statusDesc = '下轮生成时将重新抽取随机宏填入';
        }

        const preview = group.template
            ? previewTemplate(group.template, state.currentValues || {})
            : '（无模板）';

        if (willInject) {
            nextItems.push(`
                <div class="random-inspect-item">
                    <div class="random-inspect-item-header">
                        <span class="random-inspect-item-title">
                            <i class="fa-solid fa-layer-group" style="color:var(--random-accent);"></i>
                            ${escapeHtml(group.name)}
                        </span>
                        <div class="random-inspect-item-meta">
                            ${group.exclusivePool ? `<span class="random-inspect-meta-pill" style="color:var(--random-accent);"><i class="fa-solid fa-shuffle"></i> 互斥池: ${escapeHtml(group.exclusivePool)}</span>` : ''}
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-user-tag"></i> ${_roleLabel(group.injectionRole)}</span>
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-arrow-down-1-9"></i> 深度 ${group.injectionDepth ?? 4}</span>
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-arrow-down-short-wide"></i> 顺序 ${group.injectionOrder ?? 0}</span>
                            ${statusBadge}
                        </div>
                    </div>
                    <div class="random-inspect-item-content">
                        ${escapeHtml(preview)}
                        <button class="random-icon-btn--xs random-inspect-copy-btn" data-text="${escapeHtml(preview)}" title="复制预演提示词">
                            <i class="fa-solid fa-copy"></i>
                        </button>
                    </div>
                </div>
            `);
        } else {
            nextItems.push(`
                <div class="random-inspect-item">
                    <div class="random-inspect-item-header">
                        <span class="random-inspect-item-title">
                            <i class="fa-solid fa-layer-group" style="color:var(--random-text-muted);"></i>
                            ${escapeHtml(group.name)}
                        </span>
                        <div class="random-inspect-item-meta">
                            ${group.exclusivePool ? `<span class="random-inspect-meta-pill" style="color:var(--random-accent);"><i class="fa-solid fa-shuffle"></i> 互斥池: ${escapeHtml(group.exclusivePool)}</span>` : ''}
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-user-tag"></i> ${_roleLabel(group.injectionRole)}</span>
                            <span class="random-inspect-meta-pill"><i class="fa-solid fa-arrow-down-1-9"></i> 深度 ${group.injectionDepth ?? 4}</span>
                            ${statusBadge}
                        </div>
                    </div>
                    <div class="random-inspect-item-skipped">
                        <i class="fa-solid fa-ban"></i> ${escapeHtml(statusDesc)}
                    </div>
                </div>
            `);
        }
    });

    if (nextBadgeEl) {
        nextBadgeEl.textContent = `启用了 ${activeGroups.length} 个宏组`;
    }
    nextListEl.innerHTML = nextItems.length
        ? nextItems.join('')
        : `<div class="random-inspect-empty">当前没有已启用的宏组</div>`;

    // Bind copy buttons in both lists
    modal.querySelectorAll('.random-inspect-copy-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const text = btn.dataset.text || '';
            if (!text) return;
            navigator.clipboard.writeText(text).then(() => {
                showToast('提示词已复制到剪贴板', 'success');
            }).catch(() => {
                showToast('复制失败', 'error');
            });
        });
    });
}

// ── Group Modal ───────────────────────────────────────────────────────────────

function openGroupModal(groupId) {
    _editingGroupId = groupId;
    const modal = document.getElementById('random-group-modal');
    if (!modal) return;
    
    const isNew = !groupId;
    modal.querySelector('#random-group-modal-title').textContent = isNew ? '新建宏配置组' : '编辑宏配置组';
    
    const group = isNew ? _defaultGroup() : (getGroupById(groupId) || _defaultGroup());
    _groupMacros = (group.macros || []).map(id => getMacroById(id)).filter(Boolean);
    
    // Fill fields
    _setVal(modal, '#random-gm-name',        group.name || '');
    _setVal(modal, '#random-gm-category',    group.category || '');
    _setVal(modal, '#random-gm-pool',        group.exclusivePool || '');
    _setVal(modal, '#random-gm-scope',       group.scope === `character:${getContext().characterId}` ? 'character' : 'global');
    _setCheck(modal, '#random-gm-enabled',   group.enabled !== false);
    _setVal(modal, '#random-gm-role',        String(group.injectionRole ?? 0));
    _setVal(modal, '#random-gm-depth',       group.injectionDepth ?? 4);
    _setVal(modal, '#random-gm-order',       group.injectionOrder ?? 0);
    _setVal(modal, '#random-gm-template',    group.template || '');

    // Populate category datalist with existing category names for autocomplete
    const catDatalist = modal.querySelector('#random-gm-category-datalist');
    if (catDatalist) {
        const allCats = Array.from(new Set(getAllGroups().map(g => (g.category || '').trim()).filter(Boolean)));
        catDatalist.innerHTML = allCats.map(c => `<option value="${escapeHtml(c)}"></option>`).join('');
    }

    // Populate pool datalist with existing pool names for autocomplete
    const poolDatalist = modal.querySelector('#random-gm-pool-datalist');
    if (poolDatalist) {
        const allPools = Array.from(new Set(getAllGroups().map(g => (g.exclusivePool || '').trim()).filter(Boolean)));
        poolDatalist.innerHTML = allPools.map(p => `<option value="${escapeHtml(p)}"></option>`).join('');
    }
    
    const useGlobal = group.lifecycle?.useGlobal !== false;
    _setCheck(modal, '#random-gm-lifecycle-global', useGlobal);
    modal.querySelector('#random-gm-lifecycle-custom').style.display = useGlobal ? 'none' : '';
    
    const lc = group.lifecycle || {};
    _setVal(modal, '#random-gm-every-x', lc.everyXRounds ?? '');
    _setVal(modal, '#random-gm-keep-y',  lc.keepYRounds  ?? '');

    const detailsEl = modal.querySelector('.random-gm-details');
    if (detailsEl) detailsEl.open = isNew;

    // Reset search & batch on open
    const searchBar = modal.querySelector('#random-gm-search-bar');
    const searchInput = modal.querySelector('#random-gm-search-input');
    const searchClear = modal.querySelector('#random-gm-search-clear');
    if (searchBar) searchBar.style.display = 'none';
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.style.display = 'none';
    
    _batchMode = false;
    _rangeMode = false;
    _selectedMacroIds.clear();
    _lastCheckedIndex = -1;
    const batchToggleBtn = modal.querySelector('#random-gm-batch-toggle-btn');
    if (batchToggleBtn) {
        batchToggleBtn.innerHTML = '<i class="fa-solid fa-list-check"></i>';
        batchToggleBtn.title = '批量多选与删除';
        batchToggleBtn.classList.remove('random-btn--active');
    }
    const batchBar = modal.querySelector('#random-gm-batch-bar');
    if (batchBar) batchBar.style.display = 'none';
    _updateRangeBtnUI(modal);
    
    _renderGroupMacroList(modal, '');
    modal.style.display = 'flex';
}

function _defaultGroup() {
    return {
        id: generateId(),
        name: '',
        category: '',
        exclusivePool: '',
        scope: 'global',
        enabled: true,
        injectionDepth: 4,
        injectionOrder: 0,
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
    
    // View mode toggle button (Tree vs Flat)
    const viewModeBtn = modal.querySelector('#random-gm-view-mode-btn');
    viewModeBtn?.addEventListener('click', () => {
        _groupListViewMode = _groupListViewMode === 'tree' ? 'flat' : 'tree';
        if (viewModeBtn) {
            viewModeBtn.innerHTML = _groupListViewMode === 'tree' ? '<i class="fa-solid fa-list"></i>' : '<i class="fa-solid fa-sitemap"></i>';
            viewModeBtn.title = _groupListViewMode === 'tree' ? '切换为平铺列表' : '切换为树状层级视图';
            viewModeBtn.classList.toggle('random-btn--active', _groupListViewMode === 'tree');
        }
        _renderGroupMacroList(modal, searchInput?.value || '');
        showToast(_groupListViewMode === 'tree' ? '已切换至树状层级视图' : '已切换至平铺列表', 'info');
    });

    // Add macro button
    modal.querySelector('#random-gm-add-macro-btn')?.addEventListener('click', () => {
        openMacroModal(null, true);
    });

    // Batch toggle button
    const batchToggleBtn = modal.querySelector('#random-gm-batch-toggle-btn');
    const batchBar = modal.querySelector('#random-gm-batch-bar');

    batchToggleBtn?.addEventListener('click', () => {
        _batchMode = !_batchMode;
        _rangeMode = false;
        if (_batchMode) {
            if (batchBar) batchBar.style.display = 'flex';
            batchToggleBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            batchToggleBtn.title = '退出批量模式';
            batchToggleBtn.classList.add('random-btn--active');
        } else {
            _selectedMacroIds.clear();
            _lastCheckedIndex = -1;
            if (batchBar) batchBar.style.display = 'none';
            batchToggleBtn.innerHTML = '<i class="fa-solid fa-list-check"></i>';
            batchToggleBtn.title = '批量多选与删除';
            batchToggleBtn.classList.remove('random-btn--active');
        }
        _updateRangeBtnUI(modal);
        _renderGroupMacroList(modal, searchInput?.value || '');
    });

    // Search bar toggle & input
    const searchBar = modal.querySelector('#random-gm-search-bar');
    const searchInput = modal.querySelector('#random-gm-search-input');
    const searchClear = modal.querySelector('#random-gm-search-clear');

    modal.querySelector('#random-gm-search-toggle-btn')?.addEventListener('click', () => {
        if (!searchBar) return;
        const isHidden = searchBar.style.display === 'none';
        searchBar.style.display = isHidden ? 'flex' : 'none';
        if (isHidden && searchInput) {
            searchInput.focus();
        } else if (!isHidden && searchInput) {
            searchInput.value = '';
            if (searchClear) searchClear.style.display = 'none';
            _renderGroupMacroList(modal, '');
        }
    });

    searchInput?.addEventListener('input', (e) => {
        const val = e.target.value;
        if (searchClear) searchClear.style.display = val ? '' : 'none';
        _renderGroupMacroList(modal, val);
    });

    searchClear?.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        if (searchClear) searchClear.style.display = 'none';
        _renderGroupMacroList(modal, '');
        if (searchInput) searchInput.focus();
    });

    // Batch operations: Select All
    modal.querySelector('#random-gm-select-all')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const visibleIds = _getCurrentlyVisibleMacroIds(modal);
        visibleIds.forEach(id => {
            if (isChecked) {
                _selectedMacroIds.add(id);
            } else {
                _selectedMacroIds.delete(id);
            }
        });
        _syncSelectionUI(modal);
    });

    // Batch operations: Range Select (连选)
    modal.querySelector('#random-gm-select-range-btn')?.addEventListener('click', () => {
        _rangeMode = !_rangeMode;
        if (_rangeMode) {
            const visibleIds = _getCurrentlyVisibleMacroIds(modal);
            if (_lastCheckedIndex >= 0 && _lastCheckedIndex < visibleIds.length && _selectedMacroIds.has(visibleIds[_lastCheckedIndex])) {
                _rangeAnchorIndex = _lastCheckedIndex;
            } else if (_selectedMacroIds.size > 0) {
                let lastIdx = -1;
                visibleIds.forEach((id, idx) => {
                    if (_selectedMacroIds.has(id)) lastIdx = idx;
                });
                _rangeAnchorIndex = lastIdx;
            } else {
                _rangeAnchorIndex = -1;
            }

            _updateRangeBtnUI(modal);
            _syncSelectionUI(modal);
            if (_rangeAnchorIndex >= 0) {
                showToast(`已将 {{random_${visibleIds[_rangeAnchorIndex]}}} 设为连选起点，请点击终点宏`, 'info');
            } else {
                showToast('连选模式已开启：请点击起点宏，再点击终点宏', 'info');
            }
        } else {
            _rangeAnchorIndex = -1;
            _updateRangeBtnUI(modal);
            _syncSelectionUI(modal);
        }
    });

    // Batch operations: Invert Selection
    modal.querySelector('#random-gm-select-invert-btn')?.addEventListener('click', () => {
        const visibleIds = _getCurrentlyVisibleMacroIds(modal);
        visibleIds.forEach(id => {
            if (_selectedMacroIds.has(id)) {
                _selectedMacroIds.delete(id);
            } else {
                _selectedMacroIds.add(id);
            }
        });
        _syncSelectionUI(modal);
    });

    // Batch operations: Batch Delete
    modal.querySelector('#random-gm-batch-del-btn')?.addEventListener('click', () => {
        if (_selectedMacroIds.size === 0) return;
        if (!confirmDialog(`确认从当前组中批量移除选中的 ${_selectedMacroIds.size} 个宏？`)) return;
        
        const count = _selectedMacroIds.size;
        _groupMacros = _groupMacros.filter(m => !_selectedMacroIds.has(m.id));
        _selectedMacroIds.clear();
        _lastCheckedIndex = -1;
        _rangeMode = false;
        _updateRangeBtnUI(modal);
        _renderGroupMacroList(modal, searchInput?.value || '');
        showToast(`已批量移除 ${count} 个宏`, 'success');
    });

    // Template input change updates hierarchy live
    modal.querySelector('#random-gm-template')?.addEventListener('input', () => {
        const query = searchInput?.value || '';
        _renderGroupMacroList(modal, query);
    });

    // Scan template for {{random_xxx}} (recursively including nested macros)
    modal.querySelector('#random-gm-scan-btn')?.addEventListener('click', () => {
        const tpl = modal.querySelector('#random-gm-template')?.value || '';
        const uniqueIds = _collectAllReferencedMacroIds(tpl, _groupMacros);

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

        _renderGroupMacroList(modal, searchInput?.value || '');
        showToast(addedCount > 0 ? `已递归补齐 ${addedCount} 个层级宏` : '所有模板及嵌套宏已在列表中', 'success');
    });
    
    // Save group
    modal.querySelector('#random-group-modal-save')?.addEventListener('click', () => {
        _saveGroupFromModal(modal);
    });
}

function _getCurrentlyVisibleMacroIds(modal) {
    const listEl = modal.querySelector('#random-gm-macro-list');
    if (!listEl) return [];
    return Array.from(listEl.querySelectorAll('.random-gm-macro-item')).map(el => el.dataset.macroId).filter(Boolean);
}

function _syncSelectionUI(modal) {
    const listEl = modal.querySelector('#random-gm-macro-list');
    if (!listEl) return;
    const items = listEl.querySelectorAll('.random-gm-macro-item');
    items.forEach((row, idx) => {
        const id = row.dataset.macroId;
        const chk = row.querySelector('.random-gm-macro-check');
        const sel = _selectedMacroIds.has(id);
        if (chk) chk.checked = sel;
        row.classList.toggle('random-gm-macro-item--selected', sel);
        row.classList.toggle('random-gm-macro-item--anchor', _rangeMode && idx === _rangeAnchorIndex);
    });
    const visibleIds = Array.from(items).map(el => el.dataset.macroId);
    _updateBatchBar(modal, visibleIds);
}

function _updateRangeBtnUI(modal) {
    const rangeBtn = modal.querySelector('#random-gm-select-range-btn');
    if (!rangeBtn) return;
    if (_rangeMode) {
        rangeBtn.classList.add('random-btn--active');
        rangeBtn.innerHTML = '<i class="fa-solid fa-link"></i><span>连选中...</span>';
        rangeBtn.title = _rangeAnchorIndex >= 0 ? '已设起点，请点击终点宏' : '连选模式：请点击起点宏';
    } else {
        rangeBtn.classList.remove('random-btn--active');
        rangeBtn.innerHTML = '<i class="fa-solid fa-link"></i><span>连选</span>';
        rangeBtn.title = '开启连选模式：依次点击起点与终点宏即可连选区间';
    }
}

function _updateBatchBar(modal, visibleIds) {
    const batchBar = modal.querySelector('#random-gm-batch-bar');
    if (!batchBar) return;
    if (!_batchMode) {
        batchBar.style.display = 'none';
        return;
    }
    batchBar.style.display = 'flex';

    const totalVis = visibleIds.length;
    let selCount = 0;
    visibleIds.forEach(id => {
        if (_selectedMacroIds.has(id)) selCount++;
    });

    const countText = modal.querySelector('#random-gm-select-count');
    if (countText) countText.textContent = `${selCount} / ${totalVis} 已选`;

    const selectAllChk = modal.querySelector('#random-gm-select-all');
    if (selectAllChk) {
        selectAllChk.checked = (totalVis > 0 && selCount === totalVis);
        selectAllChk.indeterminate = (selCount > 0 && selCount < totalVis);
    }

    const batchDelBtn = modal.querySelector('#random-gm-batch-del-btn');
    const batchDelText = modal.querySelector('#random-gm-batch-del-text');
    if (batchDelBtn) {
        batchDelBtn.style.display = _selectedMacroIds.size > 0 ? '' : 'none';
    }
    if (batchDelText) {
        batchDelText.textContent = `批量删除 (${_selectedMacroIds.size})`;
    }
}

/**
 * Handle selection of macro items (Click, Range Select Mode, Shift-Select)
 */
function _handleMacroItemSelect(modal, targetIndex, isShiftPressed, visibleItems) {
    if (targetIndex < 0 || targetIndex >= visibleItems.length) return;
    const targetMacro = visibleItems[targetIndex].macro;
    const targetId = targetMacro.id;
    const isRange = _rangeMode || isShiftPressed;

    if (isRange) {
        if (_rangeAnchorIndex >= 0 && _rangeAnchorIndex < visibleItems.length) {
            if (_rangeAnchorIndex === targetIndex) {
                _rangeAnchorIndex = -1;
                _syncSelectionUI(modal);
                _updateRangeBtnUI(modal);
                showToast('已重置连选起点，请重新选择起点宏', 'info');
                return;
            }
            // Range selection completed
            const start = Math.min(_rangeAnchorIndex, targetIndex);
            const end   = Math.max(_rangeAnchorIndex, targetIndex);
            for (let i = start; i <= end; i++) {
                _selectedMacroIds.add(visibleItems[i].macro.id);
            }
            _rangeMode = false;
            _rangeAnchorIndex = -1;
            _lastCheckedIndex = targetIndex;
            _syncSelectionUI(modal);
            _updateRangeBtnUI(modal);
            showToast(`已成功连选 ${end - start + 1} 个宏`, 'success');
            return;
        } else {
            // Anchor set
            _rangeAnchorIndex = targetIndex;
            _selectedMacroIds.add(targetId);
            _lastCheckedIndex = targetIndex;
            _syncSelectionUI(modal);
            _updateRangeBtnUI(modal);
            showToast(`已选定起点: {{random_${targetId}}}，请点击终点宏完成连选`, 'info');
            return;
        }
    }

    // Single item toggle
    if (_selectedMacroIds.has(targetId)) {
        _selectedMacroIds.delete(targetId);
    } else {
        _selectedMacroIds.add(targetId);
    }
    _lastCheckedIndex = targetIndex;
    _syncSelectionUI(modal);
}

/**
 * Detect if a macro is part of a circular dependency graph
 */
function _detectCircularRef(startMacroId, macros) {
    const visited = new Set();
    const recursionStack = new Set();

    function dfs(currentId) {
        visited.add(currentId);
        recursionStack.add(currentId);

        const currentMacro = macros.find(m => m.id === currentId) || getMacroById(currentId);
        if (currentMacro && Array.isArray(currentMacro.options)) {
            for (const opt of currentMacro.options) {
                const text = typeof opt === 'string' ? opt : (opt?.text || '');
                const matches = [...text.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
                for (const childId of matches) {
                    if (!childId) continue;
                    if (childId === startMacroId || recursionStack.has(childId)) {
                        return true;
                    }
                    if (!visited.has(childId)) {
                        if (dfs(childId)) return true;
                    }
                }
            }
        }
        recursionStack.delete(currentId);
        return false;
    }

    return dfs(startMacroId);
}

/**
 * Calculate upstream/downstream relations and health status for a given macro.
 * @param {string} macroId
 * @param {string} template
 * @param {Array<Object>} macros
 * @returns {{ inTemplate: boolean, parents: string[], children: string[], missingChildren: string[], isCircular: boolean, isOrphan: boolean, isEmpty: boolean }}
 */
function _getMacroHealthAndHierarchy(macroId, template, macros) {
    const inTemplate = (template || '').includes(`{{random_${macroId}}}`);
    const targetMacro = macros.find(m => m.id === macroId) || getMacroById(macroId);
    
    // Parents: other macros whose options contain {{random_macroId}}
    const parents = [];
    macros.forEach(m => {
        if (m.id !== macroId && Array.isArray(m.options)) {
            const hasRef = m.options.some(opt => {
                const text = typeof opt === 'string' ? opt : (opt?.text || '');
                return text.includes(`{{random_${macroId}}}`);
            });
            if (hasRef && !parents.includes(m.id)) {
                parents.push(m.id);
            }
        }
    });

    // Children and missing children
    const children = [];
    const missingChildren = [];
    if (targetMacro && Array.isArray(targetMacro.options)) {
        targetMacro.options.forEach(opt => {
            const text = typeof opt === 'string' ? opt : (opt?.text || '');
            const matches = [...text.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
            matches.forEach(cId => {
                if (cId && !children.includes(cId)) {
                    children.push(cId);
                    const childExists = macros.some(m => m.id === cId) || !!getMacroById(cId);
                    if (!childExists && !missingChildren.includes(cId)) {
                        missingChildren.push(cId);
                    }
                }
            });
        });
    }

    const isCircular = _detectCircularRef(macroId, macros);
    const isOrphan = !inTemplate && parents.length === 0;
    const isEmpty = !targetMacro || !Array.isArray(targetMacro.options) || targetMacro.options.length === 0;

    return {
        inTemplate,
        parents,
        children,
        missingChildren,
        isCircular,
        isOrphan,
        isEmpty
    };
}

/**
 * Render health alert overview banner above macro list
 */
function _renderGroupHealthBar(modal, template, macros) {
    const healthBar = modal.querySelector('#random-gm-health-bar');
    if (!healthBar) return;

    if (macros.length === 0) {
        healthBar.style.display = 'none';
        return;
    }

    // Template missing macros
    const templateMatches = [...(template || '').matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
    const missingFromTemplate = templateMatches.filter(id => id && !macros.some(m => m.id === id) && !getMacroById(id));

    // Macro-referenced missing macros
    const allMissing = new Set([...missingFromTemplate]);
    let circularCount = 0;
    let orphanCount = 0;

    macros.forEach(m => {
        const health = _getMacroHealthAndHierarchy(m.id, template, macros);
        health.missingChildren.forEach(id => allMissing.add(id));
        if (health.isCircular) circularCount++;
        if (health.isOrphan) orphanCount++;
    });

    if (allMissing.size > 0 || circularCount > 0) {
        healthBar.style.display = 'flex';
        healthBar.className = 'random-gm-health-bar';
        
        let msgHtml = `<span><i class="fa-solid fa-triangle-exclamation"></i> <strong>宏体检提示：</strong>`;
        if (allMissing.size > 0) {
            msgHtml += ` 缺少 ${allMissing.size} 个被引用的宏 (${[...allMissing].map(id => '{{random_' + escapeHtml(id) + '}}').join(', ')})`;
        }
        if (circularCount > 0) {
            msgHtml += `${allMissing.size > 0 ? '；' : ' '}检测到 ${circularCount} 处循环嵌套死循环`;
        }
        msgHtml += `</span>`;

        if (allMissing.size > 0) {
            msgHtml += `<button class="random-health-chip random-health-chip--fix" id="random-gm-fix-missing-btn" title="一键自动补齐缺失的宏定义"><i class="fa-solid fa-wand-magic-sparkles"></i> 一键补齐缺失宏</button>`;
        }

        healthBar.innerHTML = msgHtml;

        healthBar.querySelector('#random-gm-fix-missing-btn')?.addEventListener('click', () => {
            let added = 0;
            allMissing.forEach(id => {
                if (!macros.some(m => m.id === id)) {
                    const globalMacro = getMacroById(id);
                    if (globalMacro) {
                        macros.push({ ...globalMacro });
                    } else {
                        macros.push({ id, triggerProbability: 100, options: [] });
                    }
                    added++;
                }
            });
            const searchInput = modal.querySelector('#random-gm-search-input');
            _renderGroupMacroList(modal, searchInput?.value || '');
            showToast(`已成功补齐 ${added} 个缺失宏`, 'success');
        });
    } else {
        healthBar.style.display = 'none';
    }
}

/**
 * Scroll to and pulse/highlight target macro in group modal list
 */
function _locateMacroInModal(modal, targetId) {
    const listEl = modal.querySelector('#random-gm-macro-list');
    if (!listEl) return;
    const targetItem = listEl.querySelector(`.random-gm-macro-item[data-macro-id="${targetId}"]`);
    if (targetItem) {
        targetItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        targetItem.classList.remove('random-gm-macro-item--flash');
        void targetItem.offsetWidth; // force reflow for animation restart
        targetItem.classList.add('random-gm-macro-item--flash');
        showToast(`已定位到宏: {{random_${targetId}}}`, 'info');
    } else {
        showToast(`宏 {{random_${targetId}}} 未在当前列表中`, 'info');
    }
}

/**
 * Recursively discover all macro IDs referenced in a template and in any referenced macro options.
 * @param {string} template
 * @param {Array<Object>} [seedMacros=[]]
 * @returns {string[]}
 */
function _collectAllReferencedMacroIds(template, seedMacros = []) {
    const collected = new Set();
    const queue = [];

    // 1. From template
    const templateMatches = [...(template || '').matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
    templateMatches.forEach(id => {
        if (id && !collected.has(id)) {
            collected.add(id);
            queue.push(id);
        }
    });

    // 2. From seedMacros
    seedMacros.forEach(m => {
        const id = typeof m === 'string' ? m : m?.id;
        if (id && !collected.has(id)) {
            collected.add(id);
            queue.push(id);
        }
    });

    // 3. BFS through options for nested {{random_xxx}}
    while (queue.length > 0) {
        const currentId = queue.shift();
        const macro = seedMacros.find(m => m && m.id === currentId) || getMacroById(currentId);
        if (macro && Array.isArray(macro.options)) {
            for (const opt of macro.options) {
                const optText = typeof opt === 'string' ? opt : (opt?.text || '');
                const optMatches = [...optText.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim());
                for (const nestedId of optMatches) {
                    if (nestedId && !collected.has(nestedId)) {
                        collected.add(nestedId);
                        queue.push(nestedId);
                    }
                }
            }
        }
    }

    return [...collected];
}

function _renderGroupMacroList(modal, query = '') {
    const listEl = modal.querySelector('#random-gm-macro-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    const templateText = modal.querySelector('#random-gm-template')?.value || '';
    _renderGroupHealthBar(modal, templateText, _groupMacros);

    if (_groupMacros.length === 0) {
        listEl.innerHTML = '<div class="random-empty-hint--sm">还没有宏，点击「添加宏」或「扫描模板宏」</div>';
        const statsEl = modal.querySelector('#random-gm-search-stats');
        if (statsEl) statsEl.style.display = 'none';
        _updateBatchBar(modal, []);
        return;
    }

    const cleanQuery = (query || '').trim().toLowerCase();

    // ── Tree View Mode (when not actively searching) ──
    if (!cleanQuery && _groupListViewMode === 'tree') {
        const healthMap = new Map();
        _groupMacros.forEach(m => {
            healthMap.set(m.id, _getMacroHealthAndHierarchy(m.id, templateText, _groupMacros));
        });

        // Roots: directly in template or having no parents
        const roots = _groupMacros.filter(m => {
            const h = healthMap.get(m.id);
            return h.inTemplate || h.parents.length === 0;
        });
        const rootSet = new Set((roots.length ? roots : [_groupMacros[0]]).map(m => m.id));

        const renderedInTree = new Set();
        function renderTreeNode(macroId, depth = 0, branchVisited = new Set()) {
            const macro = _groupMacros.find(m => m.id === macroId);
            if (!macro) return;
            const health = healthMap.get(macroId) || _getMacroHealthAndHierarchy(macroId, templateText, _groupMacros);
            renderedInTree.add(macroId);

            const hasChildren = health.children.length > 0;
            const isCollapsed = _collapsedTreeIds.has(macroId);

            const item = _createMacroItemElement(modal, {
                macro,
                origIdx: _groupMacros.findIndex(m => m.id === macroId),
                health,
                matchReason: '',
                isTree: true,
                depth,
                hasChildren,
                isCollapsed,
                onToggleCollapse: () => {
                    if (_collapsedTreeIds.has(macroId)) {
                        _collapsedTreeIds.delete(macroId);
                    } else {
                        _collapsedTreeIds.add(macroId);
                    }
                    _renderGroupMacroList(modal, query);
                },
            }, query);
            listEl.appendChild(item);

            if (hasChildren && !isCollapsed) {
                const nextVisited = new Set(branchVisited);
                nextVisited.add(macroId);
                health.children.forEach(childId => {
                    if (!nextVisited.has(childId)) {
                        renderTreeNode(childId, depth + 1, nextVisited);
                    }
                });
            }
        }

        rootSet.forEach(rootId => {
            renderTreeNode(rootId, 0, new Set());
        });

        // Any orphaned macros not rendered in tree yet
        _groupMacros.forEach(m => {
            if (!renderedInTree.has(m.id)) {
                renderTreeNode(m.id, 0, new Set());
            }
        });

        _updateBatchBar(modal, Array.from(renderedInTree));
        return;
    }
    
    // ── Flat View Mode / Search Filtered View ──
    const visibleItems = [];
    _groupMacros.forEach((macro, origIdx) => {
        const health = _getMacroHealthAndHierarchy(macro.id, templateText, _groupMacros);
        let isMatched = false;
        let matchReason = '';

        if (cleanQuery) {
            if (macro.id.toLowerCase().includes(cleanQuery)) {
                isMatched = true;
                matchReason = `宏ID: ${macro.id}`;
            } else {
                const matchedOpt = (macro.options || []).find(o => {
                    const t = typeof o === 'string' ? o : (o?.text || '');
                    return t.toLowerCase().includes(cleanQuery);
                });
                if (matchedOpt) {
                    isMatched = true;
                    const optText = typeof matchedOpt === 'string' ? matchedOpt : matchedOpt.text;
                    matchReason = `选项: ${optText.length > 18 ? optText.slice(0, 18) + '...' : optText}`;
                } else if (health.parents.some(p => p.toLowerCase().includes(cleanQuery))) {
                    isMatched = true;
                    matchReason = `上级调用匹配`;
                } else if (health.children.some(c => c.toLowerCase().includes(cleanQuery))) {
                    isMatched = true;
                    matchReason = `下级子宏匹配`;
                }
            }
            if (isMatched) {
                visibleItems.push({ macro, origIdx, health, matchReason });
            }
        } else {
            visibleItems.push({ macro, origIdx, health, matchReason: '' });
        }
    });

    // Update search stats badge
    const statsEl = modal.querySelector('#random-gm-search-stats');
    if (statsEl) {
        if (cleanQuery) {
            statsEl.style.display = '';
            statsEl.innerHTML = `<i class="fa-solid fa-filter"></i> 搜索「<strong>${escapeHtml(cleanQuery)}</strong>」：找到 <strong>${visibleItems.length}</strong> / ${_groupMacros.length} 个宏`;
        } else {
            statsEl.style.display = 'none';
        }
    }

    if (visibleItems.length === 0) {
        listEl.innerHTML = `<div class="random-empty-hint--sm">未找到与「${escapeHtml(cleanQuery)}」匹配的宏</div>`;
        _updateBatchBar(modal, []);
        return;
    }
    
    visibleItems.forEach((itemData, visIdx) => {
        const item = _createMacroItemElement(modal, itemData, query);
        listEl.appendChild(item);
    });

    _updateBatchBar(modal, visibleItems.map(v => v.macro.id));
}

function _createMacroItemElement(modal, itemData, query = '') {
    const { macro, origIdx, health, matchReason, isTree, depth, hasChildren, isCollapsed, onToggleCollapse } = itemData;
    const isSelected = _selectedMacroIds.has(macro.id);

    const item = document.createElement('div');
    item.className = `random-gm-macro-item${isSelected && _batchMode ? ' random-gm-macro-item--selected' : ''}${matchReason ? ' random-gm-macro-item--matched' : ''}${isTree ? ' random-gm-macro-item--tree' : ''}`;
    item.dataset.macroId = macro.id;

    // Tree indentation
    let treePrefixHtml = '';
    if (isTree && depth > 0) {
        let guides = '';
        for (let i = 0; i < depth; i++) {
            guides += `<span class="random-gm-tree-guide"></span>`;
        }
        treePrefixHtml = `<div class="random-gm-tree-indent">${guides}</div>`;
    }

    let toggleBtnHtml = '';
    if (isTree && hasChildren) {
        toggleBtnHtml = `<button class="random-icon-btn--xs random-gm-tree-toggle" title="${isCollapsed ? '展开子宏' : '折叠子宏'}"><i class="fa-solid ${isCollapsed ? 'fa-caret-right' : 'fa-caret-down'}"></i></button>`;
    } else if (isTree) {
        toggleBtnHtml = `<span style="width:16px; display:inline-block; flex-shrink:0;"></span>`;
    }

    // Build compact relation chips
    let chipsHtml = '';
    if (health.inTemplate) {
        chipsHtml += `<span class="random-rel-chip random-rel-chip--template" title="模板直接调用">模板</span>`;
    }
    if (health.parents.length > 0) {
        chipsHtml += health.parents.map(pId => `<span class="random-rel-chip" data-target-id="${escapeHtml(pId)}" title="上级宏: {{random_${escapeHtml(pId)}}}">↑${escapeHtml(pId)}</span>`).join('');
    }
    if (health.children.length > 0) {
        chipsHtml += health.children.map(cId => `<span class="random-rel-chip" data-target-id="${escapeHtml(cId)}" title="下级宏: {{random_${escapeHtml(cId)}}}">↓${escapeHtml(cId)}</span>`).join('');
    }

    // Build health warning chips
    let healthChipsHtml = '';
    if (health.missingChildren.length > 0) {
        healthChipsHtml += `<span class="random-health-chip random-health-chip--error" title="引用了不存在的子宏 {{random_${escapeHtml(health.missingChildren.join(', '))}}}"><i class="fa-solid fa-triangle-exclamation"></i> 缺: ${escapeHtml(health.missingChildren.join(','))}</span>`;
    }
    if (health.isCircular) {
        healthChipsHtml += `<span class="random-health-chip random-health-chip--error" title="检测到循环递归依赖"><i class="fa-solid fa-arrows-spin"></i> 循环引用</span>`;
    }
    if (health.isOrphan) {
        healthChipsHtml += `<span class="random-health-chip random-health-chip--info" title="模板及其他宏均未调用此宏"><i class="fa-solid fa-circle-info"></i> 未调用</span>`;
    }
    if (health.isEmpty) {
        healthChipsHtml += `<span class="random-health-chip random-health-chip--warn" title="此宏暂无候选选项"><i class="fa-solid fa-triangle-exclamation"></i> 空选项</span>`;
    }

    const probText = (macro.triggerProbability !== undefined && macro.triggerProbability !== 100) ? ` · ${macro.triggerProbability}%` : '';
    const checkHtml = _batchMode ? `<input type="checkbox" class="random-gm-macro-check" data-id="${escapeHtml(macro.id)}" ${isSelected ? 'checked' : ''} />` : '';

    item.innerHTML = `
        ${treePrefixHtml}
        ${toggleBtnHtml}
        ${checkHtml}
        <div class="random-gm-macro-content">
            <span class="random-gm-macro-id">{{random_${escapeHtml(macro.id)}}}</span>
            <span class="random-gm-macro-count">(${macro.options?.length || 0}项${probText})</span>
            <div class="random-gm-macro-chips-wrap">
                ${chipsHtml}
                ${healthChipsHtml}
            </div>
            ${matchReason ? `<span class="random-gm-match-badge" title="${escapeHtml(matchReason)}"><i class="fa-solid fa-bullseye"></i> ${escapeHtml(matchReason)}</span>` : ''}
        </div>
        <div class="random-gm-macro-actions">
            <button class="random-icon-btn--xs random-gm-macro-edit" title="编辑此宏">
                <i class="fa-solid fa-pen"></i>
            </button>
            <button class="random-icon-btn--xs random-gm-macro-remove random-icon-btn--danger" title="从组中移除此宏">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>
    `;

    // Toggle tree collapse
    if (onToggleCollapse) {
        item.querySelector('.random-gm-tree-toggle')?.addEventListener('click', (e) => {
            e.stopPropagation();
            onToggleCollapse();
        });
    }

    // Checkbox click
    const chk = item.querySelector('.random-gm-macro-check');
    if (chk) {
        chk.addEventListener('click', (e) => {
            e.stopPropagation();
            _handleMacroItemSelect(modal, origIdx, e.shiftKey, [itemData]);
        });
    }

    // Touch-friendly row tap in batch mode
    if (_batchMode) {
        item.style.cursor = 'pointer';
        item.addEventListener('click', (e) => {
            if (e.target.closest('.random-gm-macro-actions') || e.target.closest('.random-rel-chip') || e.target.closest('.random-health-chip') || e.target.classList.contains('random-gm-macro-check') || e.target.closest('.random-gm-tree-toggle')) {
                return;
            }
            _handleMacroItemSelect(modal, origIdx, e.shiftKey, [itemData]);
        });
    }

    // Edit macro
    item.querySelector('.random-gm-macro-edit')?.addEventListener('click', () => {
        openMacroModal(macro.id, false);
    });

    // Single delete with confirmation prompt
    item.querySelector('.random-gm-macro-remove')?.addEventListener('click', () => {
        if (!confirmDialog(`确认从当前组中移除宏「{{random_${macro.id}}}」？`)) return;
        const realIdx = _groupMacros.findIndex(m => m.id === macro.id);
        if (realIdx !== -1) _groupMacros.splice(realIdx, 1);
        _selectedMacroIds.delete(macro.id);
        _lastCheckedIndex = -1;
        _rangeAnchorIndex = -1;
        _rangeMode = false;
        _updateRangeBtnUI(modal);
        _renderGroupMacroList(modal, query);
        showToast(`已从组中移除宏: {{random_${macro.id}}}`, 'info');
    });

    // Click relation chip to jump & flash target macro
    item.querySelectorAll('.random-rel-chip[data-target-id]').forEach(chip => {
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            const targetId = chip.dataset.targetId;
            _locateMacroInModal(modal, targetId);
        });
    });

    return item;
}

function _saveGroupFromModal(modal) {
    const name = modal.querySelector('#random-gm-name')?.value.trim();
    if (!name) { showToast('请填写组名称', 'error'); return; }
    const category = modal.querySelector('#random-gm-category')?.value.trim() || '';
    const exclusivePool = modal.querySelector('#random-gm-pool')?.value.trim() || '';
    
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

    // Auto scan recursively and ensure all macros in template and nested options exist
    const allReferencedIds = _collectAllReferencedMacroIds(templateText, _groupMacros);
    allReferencedIds.forEach(id => {
        if (id && !_groupMacros.some(m => m.id === id)) {
            const existingGlobal = getMacroById(id);
            _groupMacros.push(existingGlobal ? { ...existingGlobal } : { id, triggerProbability: 100, options: [] });
        }
    });
    
    const group = {
        ...existing,
        name,
        category,
        exclusivePool,
        scope,
        enabled:        modal.querySelector('#random-gm-enabled')?.checked !== false,
        injectionRole:  Number(modal.querySelector('#random-gm-role')?.value ?? 0),
        injectionDepth: Number(modal.querySelector('#random-gm-depth')?.value ?? 4),
        injectionOrder: Number(modal.querySelector('#random-gm-order')?.value ?? 0),
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
    if (!group.enabled) {
        clearGroupInjection(group.id);
    }
    
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
 * @param {boolean} [pushToStack=false] - if true, push current modal state to breadcrumb stack
 */
function openMacroModal(macroId, addToGroup, pushToStack = false) {
    const modal = document.getElementById('random-macro-modal');
    if (!modal) return;

    if (pushToStack && _editingMacroId !== undefined) {
        // Save current draft state to stack before navigating to child
        _saveCurrentMacroDraftToMemory(modal);
        _macroModalStack.push({
            macroId: _editingMacroId,
            draftId: modal.querySelector('#random-mm-id')?.value.trim() || '',
            draftProb: Number(modal.querySelector('#random-mm-prob')?.value ?? 100),
            draftOptions: _macroOptions.map(o => ({ ...o })),
            isNew: !_editingMacroId,
            addToGroup: modal.dataset.addToGroup === '1',
            multilineMode: _multilineMode,
            multilineText: modal.querySelector('#random-mm-multiline-text')?.value || '',
        });
    } else if (!pushToStack) {
        // Fresh open from group list, reset stack
        _macroModalStack.length = 0;
    }

    _editingMacroId = macroId;
    const isNew = !macroId;

    const macro = isNew
        ? { id: '', triggerProbability: 100, options: [] }
        : (getMacroById(macroId) || _groupMacros.find(m => m.id === macroId) || { id: macroId, triggerProbability: 100, options: [] });
    
    _macroOptions = (macro.options || []).map(o => ({ ...o }));
    _showMacroWeights = _macroOptions.some(o => o.weight !== undefined && o.weight !== null && Number(o.weight) !== 1);
    _showMacroTags = _macroOptions.some(o => o.tag && String(o.tag).trim() !== '');
    _multilineMode = false;
    
    _setVal(modal, '#random-mm-id',   macro.id || '');
    _setVal(modal, '#random-mm-prob', macro.triggerProbability ?? 100);
    
    modal.querySelector('#random-mm-id').readOnly = !isNew && !!macroId;
    modal.dataset.addToGroup = addToGroup ? '1' : '0';

    // Update Breadcrumb UI
    _renderMacroBreadcrumbs(modal, isNew, macro.id);

    // Reset toolbar controls
    _updateToggleWeightBtn(modal);
    _updateToggleTagBtn(modal);
    _updateMultilineBtn(modal);

    // Close insert bar on open
    const insertBar = modal.querySelector('#random-mm-insert-bar');
    if (insertBar) insertBar.style.display = 'none';

    _renderOptionList(modal);
    _renderChildMacrosSection(modal);

    modal.style.display = 'flex';
}

function _renderMacroBreadcrumbs(modal, isNew, currentId) {
    const breadcrumbEl = modal.querySelector('#random-mm-breadcrumb');
    const backBtn = modal.querySelector('#random-mm-back-btn');
    if (!breadcrumbEl) return;

    if (_macroModalStack.length > 0) {
        if (backBtn) {
            backBtn.style.display = 'inline-flex';
            const prev = _macroModalStack[_macroModalStack.length - 1];
            backBtn.title = `返回上一级：{{random_${prev.draftId || prev.macroId || '新宏'}}}`;
        }
        let html = `<span class="random-mm-crumb" data-crumb-idx="-1" title="返回宏列表"><i class="fa-solid fa-list"></i> 宏列表</span>`;
        _macroModalStack.forEach((s, idx) => {
            const name = s.draftId || s.macroId || '新宏';
            html += `<span class="random-mm-crumb-sep">/</span><span class="random-mm-crumb" data-crumb-idx="${idx}" title="跳转到此层级">{{random_${escapeHtml(name)}}}</span>`;
        });
        const currentName = currentId || (isNew ? '新宏' : '未命名');
        html += `<span class="random-mm-crumb-sep">/</span><span class="random-mm-crumb-active">{{random_${escapeHtml(currentName)}}}</span>`;
        breadcrumbEl.innerHTML = html;

        // Bind crumb clicks
        breadcrumbEl.querySelectorAll('.random-mm-crumb[data-crumb-idx]').forEach(crumb => {
            crumb.addEventListener('click', () => {
                const targetIdx = Number(crumb.dataset.crumbIdx);
                if (targetIdx === -1) {
                    _saveCurrentMacroDraftToMemory(modal);
                    modal.style.display = 'none';
                    _macroModalStack.length = 0;
                    const groupModal = _container.querySelector('#random-group-modal');
                    if (groupModal) _renderGroupMacroList(groupModal);
                } else {
                    _saveCurrentMacroDraftToMemory(modal);
                    const targetState = _macroModalStack[targetIdx];
                    _macroModalStack.splice(targetIdx); // remove this and all following
                    _restoreMacroDraftState(modal, targetState);
                }
            });
        });
    } else {
        if (backBtn) backBtn.style.display = 'none';
        breadcrumbEl.innerHTML = `<span id="random-macro-modal-title">${isNew ? '新建宏' : `编辑宏: {{random_${escapeHtml(currentId)}}}`}</span>`;
    }
}

function _saveCurrentMacroDraftToMemory(modal) {
    const id = modal.querySelector('#random-mm-id')?.value.trim();
    if (!id) return;
    
    // Sync options if currently in multiline mode
    if (_multilineMode) {
        const text = modal.querySelector('#random-mm-multiline-text')?.value || '';
        _macroOptions = _parseMultilineText(text);
    }

    const macro = {
        id,
        triggerProbability: Number(modal.querySelector('#random-mm-prob')?.value ?? 100),
        options: _macroOptions.map(o => ({ ...o })),
    };

    const existingIdx = _groupMacros.findIndex(m => m.id === id);
    if (existingIdx !== -1) {
        _groupMacros[existingIdx] = macro;
    } else {
        _groupMacros.push(macro);
    }
}

function _restoreMacroDraftState(modal, state) {
    _editingMacroId = state.macroId;
    const isNew = state.isNew;
    
    _macroOptions = (state.draftOptions || []).map(o => ({ ...o }));
    _showMacroWeights = state.showMacroWeights !== undefined
        ? !!state.showMacroWeights
        : _macroOptions.some(o => o.weight !== undefined && o.weight !== null && Number(o.weight) !== 1);
    _showMacroTags = state.showMacroTags !== undefined
        ? !!state.showMacroTags
        : _macroOptions.some(o => o.tag && String(o.tag).trim() !== '');
    _multilineMode = !!state.multilineMode;

    _setVal(modal, '#random-mm-id',   state.draftId || state.macroId || '');
    _setVal(modal, '#random-mm-prob', state.draftProb ?? 100);

    modal.querySelector('#random-mm-id').readOnly = !isNew && !!state.macroId;
    modal.dataset.addToGroup = state.addToGroup ? '1' : '0';

    _renderMacroBreadcrumbs(modal, isNew, state.draftId || state.macroId);
    _updateToggleWeightBtn(modal);
    _updateToggleTagBtn(modal);
    _updateMultilineBtn(modal);

    if (_multilineMode) {
        const wrapEl = modal.querySelector('#random-mm-multiline-wrap');
        const listEl = modal.querySelector('#random-mm-option-list');
        const textEl = modal.querySelector('#random-mm-multiline-text');
        if (wrapEl) wrapEl.style.display = '';
        if (listEl) listEl.style.display = 'none';
        if (textEl) textEl.value = state.multilineText || _optionsToMultilineText(_macroOptions);
    } else {
        _renderOptionList(modal);
    }
    _renderChildMacrosSection(modal);
}

function _optionsToMultilineText(options) {
    return (options || []).map(o => {
        const text = (o.text || '').trim();
        const weight = o.weight !== undefined && o.weight !== null && Number(o.weight) !== 1 ? ` ${o.weight}` : '';
        return `${text}${weight}`;
    }).join('\n');
}

function _parseMultilineText(text) {
    const lines = (text || '').split('\n');
    const options = [];
    lines.forEach(rawLine => {
        const line = rawLine.trim();
        if (!line) return;
        // Check for trailing number as weight: e.g. "选项内容 2"
        const match = line.match(/^(.*?)(?:\s+(\d+))?$/);
        if (match) {
            const optText = match[1]?.trim() || line;
            const weight = match[2] ? Number(match[2]) : 1;
            options.push({ text: optText, weight, tag: '' });
        } else {
            options.push({ text: line, weight: 1, tag: '' });
        }
    });
    return options;
}

function _updateToggleWeightBtn(modal) {
    const btn = modal.querySelector('#random-mm-toggle-weight-btn');
    const textEl = modal.querySelector('#random-mm-toggle-weight-text');
    if (!btn) return;
    if (_showMacroWeights) {
        btn.classList.add('random-btn--active');
        if (textEl) textEl.textContent = '隐藏权重';
        btn.title = '隐藏权重列';
    } else {
        btn.classList.remove('random-btn--active');
        if (textEl) textEl.textContent = '权重';
        btn.title = '显示权重列';
    }
}

function _updateToggleTagBtn(modal) {
    const btn = modal.querySelector('#random-mm-toggle-tag-btn');
    const textEl = modal.querySelector('#random-mm-toggle-tag-text');
    if (!btn) return;
    if (_showMacroTags) {
        btn.classList.add('random-btn--active');
        if (textEl) textEl.textContent = '隐藏标签';
        btn.title = '隐藏标签列';
    } else {
        btn.classList.remove('random-btn--active');
        if (textEl) textEl.textContent = '标签';
        btn.title = '显示标签列';
    }
}

function _updateMultilineBtn(modal) {
    const btn = modal.querySelector('#random-mm-toggle-multiline-btn');
    const textEl = modal.querySelector('#random-mm-toggle-multiline-text');
    if (!btn) return;
    if (_multilineMode) {
        btn.classList.add('random-btn--active');
        if (textEl) textEl.textContent = '单行列表';
        btn.title = '切换回单行列表模式';
    } else {
        btn.classList.remove('random-btn--active');
        if (textEl) textEl.textContent = '批量文本';
        btn.title = '切换为多行文本批量编辑模式';
    }
}

function _renderChildMacrosSection(modal) {
    const childSection = modal.querySelector('#random-mm-child-section');
    const chipsContainer = modal.querySelector('#random-mm-child-chips');
    if (!childSection || !chipsContainer) return;

    // Scan all options for {{random_xxx}}
    const currentText = _multilineMode
        ? (modal.querySelector('#random-mm-multiline-text')?.value || '')
        : _macroOptions.map(o => o.text || '').join('\n');
    
    const matches = [...currentText.matchAll(/\{\{random_([^}]+)\}\}/g)].map(m => m[1].trim()).filter(Boolean);
    const uniqueChildIds = Array.from(new Set(matches)).filter(id => id !== modal.querySelector('#random-mm-id')?.value.trim());

    if (uniqueChildIds.length === 0) {
        childSection.style.display = 'none';
        chipsContainer.innerHTML = '';
        return;
    }

    childSection.style.display = '';
    chipsContainer.innerHTML = uniqueChildIds.map(childId => {
        const exists = _groupMacros.some(m => m.id === childId) || !!getMacroById(childId);
        if (exists) {
            return `<button class="random-mm-child-chip" data-child-id="${escapeHtml(childId)}" title="下钻编辑子宏 {{random_${escapeHtml(childId)}}}"><i class="fa-solid fa-pen"></i> {{random_${escapeHtml(childId)}}}</button>`;
        } else {
            return `<button class="random-mm-child-chip random-mm-child-chip--missing" data-child-id="${escapeHtml(childId)}" data-create="1" title="一键创建缺失的子宏 {{random_${escapeHtml(childId)}}}"><i class="fa-solid fa-plus"></i> 一键创建 {{random_${escapeHtml(childId)}}}</button>`;
        }
    }).join('');

    // Bind child chip clicks
    chipsContainer.querySelectorAll('.random-mm-child-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const childId = chip.dataset.childId;
            const isMissing = chip.dataset.create === '1';
            
            if (isMissing) {
                // Auto create missing child macro in group
                if (!_groupMacros.some(m => m.id === childId)) {
                    _groupMacros.push({ id: childId, triggerProbability: 100, options: [] });
                }
            }
            // Navigate down to child
            openMacroModal(childId, false, true);
        });
    });
}

function _renderQuickInserterChips(modal) {
    const chipsContainer = modal.querySelector('#random-mm-insert-chips');
    if (!chipsContainer) return;

    const currentId = modal.querySelector('#random-mm-id')?.value.trim();
    const otherMacros = _groupMacros.filter(m => m.id !== currentId);

    if (otherMacros.length === 0) {
        chipsContainer.innerHTML = `<span style="font-size:0.8em; color:var(--random-text-muted); font-style:italic;">当前组内暂无其他宏可选</span>`;
        return;
    }

    chipsContainer.innerHTML = otherMacros.map(m => `
        <button class="random-mm-insert-chip" data-insert-id="${escapeHtml(m.id)}" title="点击插入 {{random_${escapeHtml(m.id)}}}">
            <i class="fa-solid fa-plus"></i> {{random_${escapeHtml(m.id)}}}
        </button>
    `).join('');

    chipsContainer.querySelectorAll('.random-mm-insert-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const insertId = chip.dataset.insertId;
            const insertText = `{{random_${insertId}}}`;
            
            if (_multilineMode) {
                const textarea = modal.querySelector('#random-mm-multiline-text');
                if (textarea) {
                    const start = textarea.selectionStart || textarea.value.length;
                    const end = textarea.selectionEnd || textarea.value.length;
                    textarea.value = textarea.value.substring(0, start) + insertText + textarea.value.substring(end);
                    textarea.selectionStart = textarea.selectionEnd = start + insertText.length;
                    textarea.focus();
                }
            } else if (_lastActiveOptionInput && modal.contains(_lastActiveOptionInput)) {
                const input = _lastActiveOptionInput;
                const start = input.selectionStart || input.value.length;
                const end = input.selectionEnd || input.value.length;
                input.value = input.value.substring(0, start) + insertText + input.value.substring(end);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.selectionStart = input.selectionEnd = start + insertText.length;
                input.focus();
            } else {
                // If no input active, add as a new option
                _macroOptions.push({ text: insertText, weight: 1, tag: '' });
                _renderOptionList(modal);
            }
            _renderChildMacrosSection(modal);
        });
    });
}

function _bindMacroModal(container) {
    const modal = container.querySelector('#random-macro-modal');
    if (!modal) return;
    
    // Close / Cancel
    modal.querySelector('#random-macro-modal-close')?.addEventListener('click', () => {
        modal.style.display = 'none';
        _macroModalStack.length = 0;
    });
    modal.querySelector('#random-macro-modal-cancel')?.addEventListener('click', () => {
        modal.style.display = 'none';
        _macroModalStack.length = 0;
    });

    // Back Button (navigate up in breadcrumb stack)
    modal.querySelector('#random-mm-back-btn')?.addEventListener('click', () => {
        if (_macroModalStack.length > 0) {
            _saveCurrentMacroDraftToMemory(modal);
            const prevState = _macroModalStack.pop();
            _restoreMacroDraftState(modal, prevState);
        }
    });

    // Fullscreen Toggle
    const fullscreenBtn = modal.querySelector('#random-mm-fullscreen-btn');
    const modalContent = modal.querySelector('.random-modal');
    fullscreenBtn?.addEventListener('click', () => {
        if (!modalContent) return;
        const isFull = modalContent.classList.toggle('random-modal--fullscreen');
        fullscreenBtn.innerHTML = isFull ? '<i class="fa-solid fa-compress"></i>' : '<i class="fa-solid fa-expand"></i>';
        fullscreenBtn.title = isFull ? '还原窗口' : '全屏 / 置顶编辑';
    });

    // Weight Column Toggle
    modal.querySelector('#random-mm-toggle-weight-btn')?.addEventListener('click', () => {
        _showMacroWeights = !_showMacroWeights;
        _updateToggleWeightBtn(modal);
        if (!_multilineMode) _renderOptionList(modal);
    });

    // Tag Column Toggle
    modal.querySelector('#random-mm-toggle-tag-btn')?.addEventListener('click', () => {
        _showMacroTags = !_showMacroTags;
        _updateToggleTagBtn(modal);
        if (!_multilineMode) _renderOptionList(modal);
    });

    // Multi-line Batch Mode Toggle
    modal.querySelector('#random-mm-toggle-multiline-btn')?.addEventListener('click', () => {
        _multilineMode = !_multilineMode;
        _updateMultilineBtn(modal);

        const wrapEl = modal.querySelector('#random-mm-multiline-wrap');
        const listEl = modal.querySelector('#random-mm-option-list');
        const textEl = modal.querySelector('#random-mm-multiline-text');

        if (_multilineMode) {
            if (wrapEl) wrapEl.style.display = '';
            if (listEl) listEl.style.display = 'none';
            if (textEl) textEl.value = _optionsToMultilineText(_macroOptions);
        } else {
            if (wrapEl) wrapEl.style.display = 'none';
            if (listEl) listEl.style.display = '';
            if (textEl) _macroOptions = _parseMultilineText(textEl.value);
            _renderOptionList(modal);
        }
        _renderChildMacrosSection(modal);
    });

    // Multi-line textarea input updates child macros dynamically
    modal.querySelector('#random-mm-multiline-text')?.addEventListener('input', () => {
        _renderChildMacrosSection(modal);
    });

    // Quick Insert Button
    modal.querySelector('#random-mm-quick-insert-btn')?.addEventListener('click', () => {
        const insertBar = modal.querySelector('#random-mm-insert-bar');
        if (!insertBar) return;
        const isHidden = insertBar.style.display === 'none';
        insertBar.style.display = isHidden ? 'flex' : 'none';
        if (isHidden) {
            _renderQuickInserterChips(modal);
        }
    });

    // Add Option button (in row mode)
    modal.querySelector('#random-mm-add-option-btn')?.addEventListener('click', () => {
        if (_multilineMode) {
            const textarea = modal.querySelector('#random-mm-multiline-text');
            if (textarea) {
                textarea.value += (textarea.value.endsWith('\n') || !textarea.value ? '' : '\n') + '新选项';
                textarea.focus();
            }
        } else {
            _macroOptions.push({ text: '', weight: 1, tag: '' });
            _renderOptionList(modal);
            // Focus the newly added input
            const inputs = modal.querySelectorAll('.random-opt-text');
            if (inputs.length) inputs[inputs.length - 1].focus();
        }
        _renderChildMacrosSection(modal);
    });
    
    // Save Macro button
    modal.querySelector('#random-macro-modal-save')?.addEventListener('click', () => {
        _saveMacroFromModal(modal);
    });
}

function _renderOptionList(modal) {
    const listEl = modal.querySelector('#random-mm-option-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    
    if (_macroOptions.length === 0) {
        listEl.innerHTML = '<div class="random-empty-hint--sm">还没有选项，点击「添加选项」或「批量文本」</div>';
        return;
    }
    
    _macroOptions.forEach((opt, idx) => {
        const row = document.createElement('div');
        row.className = 'random-option-row';
        const weightInputHtml = _showMacroWeights
            ? `<input type="number" class="random-input random-opt-weight" value="${opt.weight ?? 1}" min="0" step="1" title="抽取权重" placeholder="权重" />`
            : '';
        const tagInputHtml = _showMacroTags
            ? `<input type="text" class="random-input random-opt-tag" value="${escapeHtml(opt.tag || '')}" placeholder="标签(可选)" title="标签(可选)" />`
            : '';

        row.innerHTML = `
            <textarea class="random-input random-opt-text" rows="2" placeholder="选项内容（支持换行与嵌套 {{random_xxx}}）">${escapeHtml(opt.text || '')}</textarea>
            ${weightInputHtml}
            ${tagInputHtml}
            <button class="random-icon-btn--xs random-opt-delete random-icon-btn--danger" title="删除">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        
        const textInput = row.querySelector('.random-opt-text');
        textInput.addEventListener('focus', () => {
            _lastActiveOptionInput = textInput;
        });
        textInput.addEventListener('input', e => {
            _macroOptions[idx].text = e.target.value;
            _renderChildMacrosSection(modal);
        });

        if (_showMacroWeights) {
            row.querySelector('.random-opt-weight')?.addEventListener('input', e => {
                _macroOptions[idx].weight = Number(e.target.value) || 1;
            });
        }
        if (_showMacroTags) {
            row.querySelector('.random-opt-tag')?.addEventListener('input', e => {
                _macroOptions[idx].tag = e.target.value;
            });
        }
        row.querySelector('.random-opt-delete').addEventListener('click', () => {
            _macroOptions.splice(idx, 1);
            _renderOptionList(modal);
            _renderChildMacrosSection(modal);
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

    // Sync options if in multiline mode
    if (_multilineMode) {
        const text = modal.querySelector('#random-mm-multiline-text')?.value || '';
        _macroOptions = _parseMultilineText(text);
    }
    
    const macro = {
        id,
        triggerProbability: Number(modal.querySelector('#random-mm-prob')?.value ?? 100),
        options: _macroOptions.map(o => ({ ...o })),
    };
    
    const addToGroup = modal.dataset.addToGroup === '1';
    
    if (addToGroup) {
        const existingIdx = _groupMacros.findIndex(m => m.id === id);
        if (existingIdx !== -1) {
            _groupMacros[existingIdx] = macro;
        } else {
            _groupMacros.push(macro);
        }
    } else {
        const existingIdx = _groupMacros.findIndex(m => m.id === _editingMacroId);
        if (existingIdx !== -1) _groupMacros[existingIdx] = macro;
        saveMacro(macro);
    }

    // If we have parent macros in breadcrumb stack, pop and return to parent!
    if (_macroModalStack.length > 0) {
        const prevState = _macroModalStack.pop();
        _restoreMacroDraftState(modal, prevState);
        showToast(`子宏「{{random_${id}}}」已保存，已返回上级`, 'success');
        return;
    }
    
    modal.style.display = 'none';
    const groupModal = document.getElementById('random-group-modal');
    if (groupModal) _renderGroupMacroList(groupModal);
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
