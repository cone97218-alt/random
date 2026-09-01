/**
 * view-generate.js - AI generation view controller
 *
 * Allows users to:
 *   1. Select a target macro group and optionally a specific macro
 *   2. Type a prompt requirement
 *   3. Stream AI output into an editable option list
 *   4. Confirm and import selected options into the macro
 *   5. Full wide chat bubbles with user edit/delete/reroll controls
 */

import { renderExtensionTemplateAsync } from '../../../../../extensions.js';
import { getAllGroups, getMacroById, saveMacro, saveGroup } from '../core/storage.js';
import { generateMacroOptions, parseAIResponseToOptions, tryParseStructuredAIResponse } from '../core/ai-client.js';
import { generateId, showToast, escapeHtml } from '../utils/dom.js';
import { refreshGroupList } from './view-manage.js';

let _container = null;
let _abortController = null;
let _streamedText = '';
let _rendered = false;
const _injectedGroupIds = new Set();

const PROMPT_SLOT_TEMPLATES = {
    merge: '请深度整合上述注入的全部已有宏配置组：分析各个宏组的职能与候选项，合并重写为一个统一连贯的主注入模板，合并重叠或强相关的子宏（并去除重复选项），规划成一个结构完整、层级清晰的全新合并宏组，并按标准 JSON 格式输出。',
    clean: '请帮我全面整理并优化上述宏配置组的候选项：去除重复或表意相近的项，修正错别字与语病，规范句式结构，剔除低质内容，保持高质量并按标准结构返回。',
    expand: '请深度分析上述宏组已有选项的主题风格、语境和叙事维度，扩充 15-20 个更丰富生动、不同维度的全新高质量候选项。',
    split_nested: '请分析上述宏组的选项与模板，提取其中可抽取的公共维度（如时间、天气、场景、人物动作、情绪氛围等），重构为结构化的二级嵌套宏 {{random_xxx}}，并规划对应的主注入模板。',
    weight_tag: '请为上述宏组的各个候选项评估并分配合理的抽取权重(weight)，并标注语义分类标签(tag)，输出规范的结构化配置。',
    polish: '请对上述宏组现有的全部选项进行深度文学润色，增强感官描写张力、情绪氛围与文字质感，提升在角色扮演中的浸入感。',
};

/**
 * Message history with swipe turns
 * @type {Array<{ prompt: string, swipes: string[], activeIndex: number, structuredData: Object|null, injectedGroupIds?: string[] }>}
 */
let _chatHistory = [];

// ── Entry Point ───────────────────────────────────────────────────────────────

export async function renderGenerateView(container) {
    _container = container;

    if (_rendered) {
        _refreshGroupSelect(container);
        _refreshInjectGroupSelect(container);
        _renderInjectedGroups(container);
        return;
    }
    _rendered = true;

    const html = await renderExtensionTemplateAsync('third-party/random', 'templates/view-generate');
    container.innerHTML = html;

    _bindEvents(container);
    _refreshGroupSelect(container);
    _refreshInjectGroupSelect(container);
    _renderInjectedGroups(container);
}

export function refreshGenerateViewSelectors() {
    if (_container && _rendered) {
        _refreshGroupSelect(_container);
        _refreshInjectGroupSelect(_container);
        _renderInjectedGroups(_container);
    }
}

// ── Group / Macro selectors ───────────────────────────────────────────────────

function _refreshGroupSelect(container) {
    const groupSelect = container.querySelector('#random-gen-group-select');
    if (!groupSelect) return;

    const prevVal = groupSelect.value;
    groupSelect.innerHTML = '<option value="">-- 选择宏配置组 --</option>';

    const groups = getAllGroups();
    groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${g.name || '未命名组'} (${g.scope === 'global' ? '全局' : '角色卡'})`;
        groupSelect.appendChild(opt);
    });

    if (prevVal && groups.some(g => g.id === prevVal)) {
        groupSelect.value = prevVal;
    }
    _onGroupSelected(container, groupSelect.value);
}

function _refreshInjectGroupSelect(container) {
    const select = container.querySelector('#random-gen-inject-group-select');
    if (!select) return;

    select.innerHTML = '<option value="">+ 追加注入宏组到提示词...</option>';

    const groups = getAllGroups();
    groups.forEach(g => {
        const isInjected = _injectedGroupIds.has(g.id);
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = `${isInjected ? '✓ ' : ''}${g.name || '未命名组'} (${(g.macros || []).length}个宏)`;
        select.appendChild(opt);
    });
}

function _updateSummaryHeader(container) {
    const summaryText = container.querySelector('#random-gen-summary-text');
    const badgeEl = container.querySelector('#random-gen-summary-badge');
    const targetGroupId = container.querySelector('#random-gen-group-select')?.value;

    const allGroups = getAllGroups();
    const targetGroup = targetGroupId ? allGroups.find(g => g.id === targetGroupId) : null;
    const injectedList = Array.from(_injectedGroupIds).map(id => allGroups.find(g => g.id === id)).filter(Boolean);

    if (summaryText) {
        if (targetGroup && injectedList.length > 0) {
            summaryText.textContent = `目标: ${targetGroup.name} · 已注入: ${injectedList.map(g => g.name).join(', ')}`;
        } else if (targetGroup) {
            summaryText.textContent = `目标宏组: ${targetGroup.name}`;
        } else if (injectedList.length > 0) {
            summaryText.textContent = `已注入参考组: ${injectedList.map(g => g.name).join(', ')}`;
        } else {
            summaryText.textContent = '目标宏组与注入上下文';
        }
    }

    if (badgeEl) {
        if (injectedList.length > 0) {
            badgeEl.style.display = '';
            badgeEl.textContent = `已注入 ${injectedList.length} 个宏组`;
        } else {
            badgeEl.style.display = 'none';
        }
    }
}

function _addInjectedGroup(container, groupId) {
    if (!groupId) return;
    const group = getAllGroups().find(g => g.id === groupId);
    if (!group) return;

    if (_injectedGroupIds.has(groupId)) {
        showToast(`宏组「${group.name}」已在注入列表中`, 'info');
        return;
    }

    _injectedGroupIds.add(groupId);
    _renderInjectedGroups(container);
    _refreshInjectGroupSelect(container);
    _updateSummaryHeader(container);
    showToast(`已追加注入宏组「${group.name}」到提示词上下文！`, 'success');
}

function _removeInjectedGroup(container, groupId) {
    if (!_injectedGroupIds.has(groupId)) return;
    const group = getAllGroups().find(g => g.id === groupId);
    _injectedGroupIds.delete(groupId);
    _renderInjectedGroups(container);
    _refreshInjectGroupSelect(container);
    _updateSummaryHeader(container);
    showToast(`已移除宏组「${group?.name || groupId}」的注入`, 'info');
}

function _clearAllInjectedGroups(container) {
    if (_injectedGroupIds.size === 0) return;
    _injectedGroupIds.clear();
    _renderInjectedGroups(container);
    _refreshInjectGroupSelect(container);
    _updateSummaryHeader(container);
    showToast('已清空全部已注入的宏组', 'info');
}

function _renderInjectedGroups(container) {
    const listEl = container.querySelector('#random-gen-injected-list');
    const clearAllBtn = container.querySelector('#random-gen-injected-clear-all-btn');
    const countEl = container.querySelector('#random-gen-injected-count');
    if (!listEl) return;

    const count = _injectedGroupIds.size;
    if (count === 0) {
        listEl.style.display = 'none';
        listEl.innerHTML = '';
        if (clearAllBtn) clearAllBtn.style.display = 'none';
        if (countEl) countEl.style.display = 'none';
        return;
    }

    listEl.style.display = 'flex';
    listEl.innerHTML = '';
    if (clearAllBtn) clearAllBtn.style.display = 'inline-flex';
    if (countEl) {
        countEl.style.display = '';
        countEl.textContent = `共 ${count} 个`;
    }

    const allGroups = getAllGroups();
    _injectedGroupIds.forEach(groupId => {
        const group = allGroups.find(g => g.id === groupId);
        if (!group) return;

        let totalOptions = 0;
        (group.macros || []).forEach(mId => {
            const m = getMacroById(mId);
            if (m && Array.isArray(m.options)) totalOptions += m.options.length;
        });

        const chip = document.createElement('div');
        chip.className = 'random-gen-injected-chip';
        chip.innerHTML = `
            <i class="fa-solid fa-layer-group" style="color:var(--random-accent);"></i>
            <span class="random-gen-injected-chip-name">${escapeHtml(group.name || '未命名组')}</span>
            <span class="random-gen-injected-chip-stats">(${(group.macros || []).length}宏 · ${totalOptions}条)</span>
            <span class="random-gen-injected-chip-remove" title="取消注入此宏组"><i class="fa-solid fa-xmark"></i></span>
        `;

        chip.querySelector('.random-gen-injected-chip-remove')?.addEventListener('click', (e) => {
            e.stopPropagation();
            _removeInjectedGroup(container, groupId);
        });

        listEl.appendChild(chip);
    });
}

function _onGroupSelected(container, groupId) {
    const macroSelect = container.querySelector('#random-gen-macro-select');
    _updateSummaryHeader(container);
    if (!macroSelect) return;

    macroSelect.innerHTML = '<option value="__all__">全部宏</option>';
    if (!groupId) return;

    const groups = getAllGroups();
    const group  = groups.find(g => g.id === groupId);
    if (!group || !Array.isArray(group.macros)) return;

    group.macros.forEach(macroId => {
        const opt = document.createElement('option');
        opt.value = macroId;
        opt.textContent = `{{random_${macroId}}}`;
        macroSelect.appendChild(opt);
    });
}

// ── Events ────────────────────────────────────────────────────────────────────

function _bindEvents(container) {
    container.querySelector('#random-gen-group-select')?.addEventListener('change', e => {
        _onGroupSelected(container, e.target.value);
        container.querySelector('#random-gen-hint').style.display = e.target.value ? 'none' : '';
    });

    // Injected Group selector events
    container.querySelector('#random-gen-inject-group-select')?.addEventListener('change', e => {
        if (e.target.value) {
            _addInjectedGroup(container, e.target.value);
            e.target.value = '';
        }
    });

    container.querySelector('#random-gen-inject-curr-btn')?.addEventListener('click', () => {
        const currGroupId = container.querySelector('#random-gen-group-select')?.value;
        if (!currGroupId) {
            showToast('请先在顶部「目标宏组」中选择一个宏配置组', 'info');
            return;
        }
        _addInjectedGroup(container, currGroupId);
    });

    container.querySelector('#random-gen-injected-clear-all-btn')?.addEventListener('click', () => {
        _clearAllInjectedGroups(container);
    });

    // Prompt Functional Slots Chips
    container.querySelectorAll('.random-gen-chip-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const slotKey = btn.dataset.slot;
            const templateText = PROMPT_SLOT_TEMPLATES[slotKey];
            if (!templateText) return;

            // Auto-inject current target group if none injected yet
            if (_injectedGroupIds.size === 0) {
                const currGroupId = container.querySelector('#random-gen-group-select')?.value;
                if (currGroupId) {
                    _addInjectedGroup(container, currGroupId);
                }
            }

            const inputEl = container.querySelector('#random-gen-input');
            if (inputEl) {
                inputEl.value = templateText;
                inputEl.focus();
            }
        });
    });

    container.querySelector('#random-gen-send-btn')?.addEventListener('click', () => {
        const userPrompt = container.querySelector('#random-gen-input')?.value.trim();
        if (!userPrompt) {
            showToast('请输入需求描述', 'error');
            return;
        }
        _startGeneration(container, userPrompt, false);
    });

    container.querySelector('#random-gen-abort-btn')?.addEventListener('click', () => {
        _abortController?.abort();
        _abortController = null;
        _setGenerating(container, false);
        showToast('已停止生成', 'info');
    });

    container.querySelector('#random-gen-clear-result-btn')?.addEventListener('click', () => {
        container.querySelector('#random-gen-result').style.display = 'none';
        container.querySelector('#random-gen-option-edit-list').innerHTML = '';
        container.querySelector('#random-gen-structured-preview').style.display = 'none';
        _streamedText = '';
    });

    container.querySelector('#random-gen-add-option-btn')?.addEventListener('click', () => {
        _addEditableRow(container, '');
    });

    container.querySelector('#random-gen-import-btn')?.addEventListener('click', () => {
        _importOptions(container);
    });

    container.querySelector('#random-gen-apply-update-btn')?.addEventListener('click', () => {
        _applyUpdateToInjectedGroup(container);
    });

    // Send on Ctrl+Enter
    container.querySelector('#random-gen-input')?.addEventListener('keydown', e => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const userPrompt = container.querySelector('#random-gen-input')?.value.trim();
            if (userPrompt) _startGeneration(container, userPrompt, false);
        }
    });
}

// ── Generation Flow ───────────────────────────────────────────────────────────

async function _startGeneration(container, userPrompt, isSwipe = false, turnIndex = -1) {
    _abortController?.abort();
    _abortController = new AbortController();
    _streamedText = '';

    _setGenerating(container, true);

    const chatEl = container.querySelector('#random-gen-chat');
    container.querySelector('#random-gen-hint').style.display = 'none';

    let currentTurn;
    let turnIdx;

    const currentInjectedIds = Array.from(_injectedGroupIds);

    if (isSwipe && turnIndex >= 0 && turnIndex < _chatHistory.length) {
        turnIdx = turnIndex;
        currentTurn = _chatHistory[turnIdx];
        currentTurn.prompt = userPrompt; // In case prompt was edited
        currentTurn.swipes.push('');
        currentTurn.activeIndex = currentTurn.swipes.length - 1;

        // Update user bubble text in case it changed
        const userBubble = chatEl.querySelector(`.random-gen-bubble--user[data-turn="${turnIdx}"]`);
        if (userBubble) {
            const userTextEl = userBubble.querySelector('.random-gen-bubble-text');
            if (userTextEl) userTextEl.textContent = userPrompt;
        }
    } else {
        currentTurn = {
            prompt: userPrompt,
            swipes: [''],
            activeIndex: 0,
            structuredData: null,
            injectedGroupIds: currentInjectedIds,
        };
        _chatHistory.push(currentTurn);
        turnIdx = _chatHistory.length - 1;

        // Render User bubble
        const userBubble = _createUserBubble(turnIdx, userPrompt, container, currentInjectedIds);
        chatEl.appendChild(userBubble);
    }

    // Render/update AI bubble
    let aiBubble = chatEl.querySelector(`.random-gen-bubble--ai[data-turn="${turnIdx}"]`);
    if (!aiBubble) {
        aiBubble = _createAIBubble(turnIdx);
        chatEl.appendChild(aiBubble);
    }
    _updateAIBubbleSwipeControls(aiBubble, currentTurn, turnIdx);
    chatEl.scrollTop = chatEl.scrollHeight;

    // History = all turns before this one (for multi-turn context)
    const historyContext = _chatHistory.slice(0, turnIdx);

    try {
        const genOptions = {
            injectedGroupIds: currentTurn.injectedGroupIds || currentInjectedIds,
        };
        for await (const chunk of generateMacroOptions(userPrompt, _abortController.signal, historyContext, genOptions)) {
            _streamedText += chunk;
            currentTurn.swipes[currentTurn.activeIndex] = _streamedText;
            aiBubble.querySelector('.random-gen-bubble-text').textContent = _streamedText;
            chatEl.scrollTop = chatEl.scrollHeight;
        }

        // Check if structured group
        const structured = tryParseStructuredAIResponse(_streamedText);
        currentTurn.structuredData = structured;

        _populateResultEditor(container, _streamedText, structured);
    } catch (err) {
        if (err.name !== 'AbortError') {
            aiBubble.querySelector('.random-gen-bubble-text').textContent = `[错误] ${err.message}`;
            showToast(`生成失败: ${err.message}`, 'error');
        }
    } finally {
        _setGenerating(container, false);
    }
}

// ── Bubble Builders ───────────────────────────────────────────────────────────

function _createUserBubble(turnIdx, userPrompt, container, injectedGroupIds = []) {
    const userBubble = document.createElement('div');
    userBubble.className = 'random-gen-bubble random-gen-bubble--user';
    userBubble.dataset.turn = turnIdx;

    let injectedTagHtml = '';
    const ids = Array.isArray(injectedGroupIds) ? injectedGroupIds : (injectedGroupIds ? [injectedGroupIds] : []);
    if (ids.length > 0) {
        const allGroups = getAllGroups();
        const names = ids.map(id => {
            const g = allGroups.find(item => item.id === id);
            return g ? escapeHtml(g.name || id) : null;
        }).filter(Boolean);

        if (names.length > 0) {
            injectedTagHtml = `
                <div class="random-gen-bubble-injected-tag">
                    <i class="fa-solid fa-boxes-stacked"></i>
                    <span>已注入参考组: <strong>${names.join(', ')}</strong></span>
                </div>
            `;
        }
    }

    userBubble.innerHTML = `
        <div class="random-gen-bubble-content">
            ${injectedTagHtml}
            <div class="random-gen-bubble-text">${escapeHtml(userPrompt)}</div>
            <div class="random-gen-bubble-footer">
                <button class="random-icon-btn--xs random-user-edit" title="重新编辑并重Roll此消息"><i class="fa-solid fa-pen"></i></button>
                <button class="random-icon-btn--xs random-user-delete random-icon-btn--danger" title="删除此条问答"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
        <div class="random-gen-bubble-avatar"><i class="fa-solid fa-user"></i></div>
    `;

    // Edit prompt & reroll
    userBubble.querySelector('.random-user-edit')?.addEventListener('click', () => {
        const textEl = userBubble.querySelector('.random-gen-bubble-text');
        const currentText = _chatHistory[turnIdx]?.prompt || textEl.textContent;
        const newText = prompt('编辑用户输入并重新生成：', currentText);
        if (newText !== null && newText.trim() !== '') {
            _startGeneration(container, newText.trim(), true, turnIdx);
        }
    });

    // Delete turn
    userBubble.querySelector('.random-user-delete')?.addEventListener('click', () => {
        if (!confirm('确认删除此轮问答？')) return;
        _chatHistory.splice(turnIdx, 1);
        _rebuildChatDOM(container);
    });

    return userBubble;
}

function _createAIBubble(turnIdx) {
    const bubble = document.createElement('div');
    bubble.className = 'random-gen-bubble random-gen-bubble--ai';
    bubble.dataset.turn = turnIdx;
    bubble.innerHTML = `
        <div class="random-gen-bubble-avatar"><i class="fa-solid fa-robot"></i></div>
        <div class="random-gen-bubble-content">
            <div class="random-gen-bubble-text"></div>
            <div class="random-gen-bubble-footer">
                <button class="random-icon-btn--xs random-swipe-prev" title="上一条 (Swipe Left)"><i class="fa-solid fa-chevron-left"></i></button>
                <span class="random-gen-swipe-counter">1/1</span>
                <button class="random-icon-btn--xs random-swipe-next" title="下一条 (Swipe Right)"><i class="fa-solid fa-chevron-right"></i></button>
                <button class="random-icon-btn--xs random-swipe-reroll" title="重新生成 (Swipe/Reroll)"><i class="fa-solid fa-rotate"></i></button>
                <button class="random-icon-btn--xs random-swipe-rescan" title="重新扫描并载入此条选项 (防止误关闭)"><i class="fa-solid fa-file-import"></i></button>
            </div>
        </div>
    `;
    return bubble;
}

function _updateAIBubbleSwipeControls(aiBubble, turn, turnIdx) {
    const counter = aiBubble.querySelector('.random-gen-swipe-counter');
    const prevBtn = aiBubble.querySelector('.random-swipe-prev');
    const nextBtn = aiBubble.querySelector('.random-swipe-next');
    const rerollBtn = aiBubble.querySelector('.random-swipe-reroll');
    const rescanBtn = aiBubble.querySelector('.random-swipe-rescan');
    const textEl = aiBubble.querySelector('.random-gen-bubble-text');

    const total = turn.swipes.length;
    const current = turn.activeIndex + 1;
    if (counter) counter.textContent = `${current}/${total}`;

    textEl.textContent = turn.swipes[turn.activeIndex] || '';

    prevBtn.onclick = () => {
        if (turn.activeIndex > 0) {
            turn.activeIndex--;
            _updateAIBubbleSwipeControls(aiBubble, turn, turnIdx);
            const structured = tryParseStructuredAIResponse(turn.swipes[turn.activeIndex]);
            _populateResultEditor(_container, turn.swipes[turn.activeIndex], structured);
        }
    };

    nextBtn.onclick = () => {
        if (turn.activeIndex < turn.swipes.length - 1) {
            turn.activeIndex++;
            _updateAIBubbleSwipeControls(aiBubble, turn, turnIdx);
            const structured = tryParseStructuredAIResponse(turn.swipes[turn.activeIndex]);
            _populateResultEditor(_container, turn.swipes[turn.activeIndex], structured);
        }
    };

    rerollBtn.onclick = () => {
        _startGeneration(_container, turn.prompt, true, turnIdx);
    };

    if (rescanBtn) {
        rescanBtn.onclick = () => {
            const raw = turn.swipes[turn.activeIndex] || '';
            const structured = tryParseStructuredAIResponse(raw);
            _populateResultEditor(_container, raw, structured);
            showToast('已重新扫描此条消息并打开导入面板', 'info');
        };
    }
}

function _rebuildChatDOM(container) {
    const chatEl = container.querySelector('#random-gen-chat');
    if (!chatEl) return;
    chatEl.innerHTML = '';

    if (_chatHistory.length === 0) {
        const hint = container.querySelector('#random-gen-hint');
        if (hint) hint.style.display = '';
        return;
    }

    _chatHistory.forEach((turn, idx) => {
        const userBubble = _createUserBubble(idx, turn.prompt, container, turn.injectedGroupIds);
        chatEl.appendChild(userBubble);

        const aiBubble = _createAIBubble(idx);
        chatEl.appendChild(aiBubble);
        _updateAIBubbleSwipeControls(aiBubble, turn, idx);
    });

    chatEl.scrollTop = chatEl.scrollHeight;
}

// ── Populate Result Editor ────────────────────────────────────────────────────

function _populateResultEditor(container, rawText, structured) {
    const resultEl = container.querySelector('#random-gen-result');
    const editListEl = container.querySelector('#random-gen-option-edit-list');
    const structPreviewEl = container.querySelector('#random-gen-structured-preview');
    const structNameEl = container.querySelector('#random-gen-structured-name');
    const structCountEl = container.querySelector('#random-gen-structured-count');
    const structTemplateEl = container.querySelector('#random-gen-structured-template');
    const updateBtn = container.querySelector('#random-gen-apply-update-btn');
    const importBtn = container.querySelector('#random-gen-import-btn');

    resultEl.style.display = '';
    editListEl.innerHTML = '';

    const hasInjected = _injectedGroupIds.size > 0;
    const isMultiInjected = _injectedGroupIds.size > 1;

    if (structured && structured.macros && structured.macros.length > 0) {
        // Structured Full Group
        if (structPreviewEl) {
            structPreviewEl.style.display = 'flex';
            if (structNameEl) structNameEl.textContent = structured.groupName || (isMultiInjected ? 'AI 合并重构宏组' : 'AI 生成/整理宏组');
            if (structCountEl) structCountEl.textContent = `共 ${structured.macros.length} 个宏定义`;
            if (structTemplateEl) structTemplateEl.textContent = structured.template || '(无模板)';
        }

        (structured.macros || []).forEach(m => {
            (m.options || []).forEach(opt => {
                _addEditableRow(container, opt.text || opt, opt.weight || 1, m.id);
            });
        });

        if (updateBtn) {
            updateBtn.style.display = hasInjected ? '' : 'none';
            const span = updateBtn.querySelector('span');
            if (span) span.textContent = isMultiInjected ? '覆盖更新到主宏组' : '更新原宏组';
        }
        if (importBtn) {
            const span = importBtn.querySelector('span');
            if (span) span.textContent = isMultiInjected ? '另存为合并新宏组' : '另存为新宏组';
        }

        showToast(`AI 已完成智能处理: ${structured.groupName || '宏配置组'}`, 'success');
    } else {
        if (structPreviewEl) structPreviewEl.style.display = 'none';
        if (updateBtn) updateBtn.style.display = 'none';
        if (importBtn) {
            const span = importBtn.querySelector('span');
            if (span) span.textContent = '确认导入';
        }

        const options = parseAIResponseToOptions(rawText);
        if (options.length === 0) {
            showToast('AI 未返回有效选项', 'info');
        } else {
            options.forEach(opt => _addEditableRow(container, opt, 1));
            showToast(`已生成 ${options.length} 个选项`, 'success');
        }
    }

    resultEl.scrollIntoView({ behavior: 'smooth' });
}

function _addEditableRow(container, text, weight = 1, macroTag = '') {
    const listEl = container.querySelector('#random-gen-option-edit-list');
    if (!listEl) return;

    const row = document.createElement('div');
    row.className = 'random-option-edit-row';
    row.innerHTML = `
        <input type="number" class="random-input random-opt-edit-weight" value="${weight}" min="0" step="1" title="抽取权重" placeholder="权重" />
        <div class="random-option-edit-text-wrap">
            <input type="text" class="random-input random-opt-edit-text" value="${escapeHtml(text)}" placeholder="选项内容" />
        </div>
        ${macroTag ? `<span class="random-macro-chip-id" title="所属宏">{{random_${escapeHtml(macroTag)}}}</span>` : ''}
        <button class="random-icon-btn--xs random-opt-edit-delete random-icon-btn--danger" title="删除此行">
            <i class="fa-solid fa-xmark"></i>
        </button>
    `;
    row.querySelector('.random-opt-edit-delete').addEventListener('click', () => row.remove());
    listEl.appendChild(row);
}

// ── Update Injected Group in Place ────────────────────────────────────────────

function _applyUpdateToInjectedGroup(container) {
    if (_injectedGroupIds.size === 0) {
        showToast('未检测到已注入的宏组', 'error');
        return;
    }

    const allGroups = getAllGroups();
    // Use target group if selected, otherwise the first injected group
    const targetGroupId = container.querySelector('#random-gen-group-select')?.value;
    const primaryGroupId = targetGroupId || Array.from(_injectedGroupIds)[0];
    const group = allGroups.find(g => g.id === primaryGroupId);

    if (!group) {
        showToast('找不到待更新的目标宏配置组', 'error');
        return;
    }

    const activeTurn = _chatHistory[_chatHistory.length - 1];
    const structured = activeTurn?.structuredData;
    const rows = container.querySelectorAll('.random-option-edit-row');

    if (structured && structured.macros && structured.macros.length > 0) {
        // Collect edited options from UI rows mapped to macro ids
        const macroOptsMap = new Map();
        rows.forEach(row => {
            const text   = row.querySelector('.random-opt-edit-text')?.value.trim();
            const weight = Number(row.querySelector('.random-opt-edit-weight')?.value) || 1;
            const tagEl  = row.querySelector('.random-macro-chip-id');
            const mId    = tagEl ? tagEl.textContent.replace('{{random_', '').replace('}}', '').trim() : '';
            if (text && mId) {
                if (!macroOptsMap.has(mId)) macroOptsMap.set(mId, []);
                macroOptsMap.get(mId).push({ text, weight, tag: '' });
            }
        });

        // Update group properties
        if (structured.template) group.template = structured.template;
        if (structured.groupName) group.name = structured.groupName;
        group.macros = structured.macros.map(m => m.id);

        structured.macros.forEach(m => {
            const opts = macroOptsMap.has(m.id)
                ? macroOptsMap.get(m.id)
                : (m.options || []).map(o => ({
                    text: typeof o === 'string' ? o : o.text,
                    weight: Number(o.weight) || 1,
                    tag: o.tag || '',
                }));

            saveMacro({
                id: m.id,
                triggerProbability: Number(m.triggerProbability ?? 100),
                options: opts,
            });
        });

        saveGroup(group);
        _refreshGroupSelect(container);
        _refreshInjectGroupSelect(container);
        _renderInjectedGroups(container);
        refreshGroupList();

        container.querySelector('#random-gen-result').style.display = 'none';
        container.querySelector('#random-gen-option-edit-list').innerHTML = '';

        showToast(`🎉 成功更新宏组「${group.name}」及 ${structured.macros.length} 个关联宏！`, 'success');
    } else {
        // Fallback: normal options update into group
        _importOptions(container);
    }
}

// ── Import Logic ──────────────────────────────────────────────────────────────

function _importOptions(container) {
    const activeTurn = _chatHistory[_chatHistory.length - 1];
    const structured = activeTurn?.structuredData;

    // 1. Auto import full structured group if available
    if (structured && structured.macros && structured.macros.length > 0) {
        const newGroup = {
            id: generateId(),
            name: structured.groupName || 'AI 生成宏组',
            scope: 'global',
            enabled: true,
            injectionRole: Number(structured.injectionRole ?? 0),
            injectionDepth: Number(structured.injectionDepth ?? 4),
            injectionOrder: Number(structured.injectionOrder ?? 0),
            template: structured.template || '',
            macros: structured.macros.map(m => m.id),
            lifecycle: { useGlobal: true, everyXRounds: null, keepYRounds: null },
        };

        structured.macros.forEach(m => {
            saveMacro({
                id: m.id,
                triggerProbability: Number(m.triggerProbability ?? 100),
                options: (m.options || []).map(o => ({
                    text: typeof o === 'string' ? o : o.text,
                    weight: Number(o.weight) || 1,
                    tag: '',
                })),
            });
        });

        saveGroup(newGroup);
        _refreshGroupSelect(container);
        refreshGroupList();

        // Collapse result editor
        container.querySelector('#random-gen-result').style.display = 'none';
        container.querySelector('#random-gen-option-edit-list').innerHTML = '';

        showToast(`已成功创建并注入宏组「${newGroup.name}」`, 'success');
        return;
    }

    // 2. Normal import into selected group
    const groupId  = container.querySelector('#random-gen-group-select')?.value;
    const macroId  = container.querySelector('#random-gen-macro-select')?.value;

    if (!groupId) {
        showToast('请在顶部选择要导入的目标宏配置组', 'error');
        return;
    }

    const rows = container.querySelectorAll('.random-option-edit-row');
    const newOptions = [];
    rows.forEach(row => {
        const text   = row.querySelector('.random-opt-edit-text')?.value.trim();
        const weight = Number(row.querySelector('.random-opt-edit-weight')?.value) || 1;
        if (text) newOptions.push({ text, weight, tag: '' });
    });

    if (newOptions.length === 0) { showToast('没有可导入的选项', 'error'); return; }

    const groups = getAllGroups();
    const group  = groups.find(g => g.id === groupId);
    if (!group) { showToast('找不到目标宏配置组', 'error'); return; }

    if (macroId && macroId !== '__all__') {
        _importIntoMacro(macroId, newOptions, group);
    } else {
        if (group.macros?.length === 0) {
            showToast('该组还没有宏，请先在「宏管理」中添加或扫描宏', 'error');
            return;
        }

        // Check if rows have macro tags (from structured output)
        const taggedGroups = {};
        rows.forEach(row => {
            const text     = row.querySelector('.random-opt-edit-text')?.value.trim();
            const weight   = Number(row.querySelector('.random-opt-edit-weight')?.value) || 1;
            const tagEl    = row.querySelector('.random-macro-chip-id');
            const macroTag = tagEl ? tagEl.textContent.replace('{{random_', '').replace('}}', '').trim() : '';

            if (text) {
                const targetKey = macroTag || '__all__';
                if (!taggedGroups[targetKey]) taggedGroups[targetKey] = [];
                taggedGroups[targetKey].push({ text, weight, tag: '' });
            }
        });

        if (Object.keys(taggedGroups).length > 1 || (Object.keys(taggedGroups).length === 1 && !taggedGroups['__all__'])) {
            let totalImported = 0;
            for (const [mId, opts] of Object.entries(taggedGroups)) {
                if (mId === '__all__') {
                    group.macros.forEach(id => _importIntoMacro(id, opts, group, true));
                } else {
                    _importIntoMacro(mId, opts, group, true);
                }
                totalImported += opts.length;
            }
            showToast(`已将 ${totalImported} 个选项分派导入到对应宏`, 'success');
        } else {
            // Import all options to all macros in group
            group.macros.forEach(id => _importIntoMacro(id, newOptions, group, true));
            showToast(`已导入 ${newOptions.length} 个选项到该组所有宏 (${group.macros.length} 个)`, 'success');
        }
    }

    // Collapse result editor
    container.querySelector('#random-gen-result').style.display = 'none';
    container.querySelector('#random-gen-option-edit-list').innerHTML = '';
}

function _importIntoMacro(macroId, newOptions, group, silent = false) {
    let macro = getMacroById(macroId);
    if (!macro) {
        macro = { id: macroId, triggerProbability: 100, options: [] };
        if (!group.macros.includes(macroId)) {
            group.macros.push(macroId);
            saveGroup(group);
        }
    }
    const existing = Array.isArray(macro.options) ? macro.options : [];
    macro.options = [...existing, ...newOptions];
    saveMacro(macro);
    if (!silent) showToast(`已导入 ${newOptions.length} 个选项到宏 {{random_${macroId}}}`, 'success');
}

// ── UI Helpers ────────────────────────────────────────────────────────────────

function _setGenerating(container, isGenerating) {
    const sendBtn  = container.querySelector('#random-gen-send-btn');
    const abortBtn = container.querySelector('#random-gen-abort-btn');
    const input    = container.querySelector('#random-gen-input');

    if (sendBtn)  sendBtn.style.display  = isGenerating ? 'none' : '';
    if (abortBtn) abortBtn.style.display = isGenerating ? ''     : 'none';
    if (input)    input.disabled         = isGenerating;
}
