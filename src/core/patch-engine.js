/**
 * patch-engine.js - Point-to-point modification & diff engine for macros
 *
 * Implements an Agentic Patch protocol allowing granular, atomic operations
 * (add/replace/remove options, update templates, adjust probabilities, etc.)
 * with fuzzy text matching and visual diff computation.
 */

import { getAllGroups, getMacroById, saveMacro, saveGroup } from './storage.js';

// ── Text Normalization & Fuzzy Matcher ────────────────────────────────────────

/**
 * Normalize string for resilient fuzzy matching (handles full/half-width quotes, punctuation, spacing).
 * @param {string} str
 * @returns {string}
 */
export function normalizeText(str) {
    if (typeof str !== 'string') return '';
    return str
        .trim()
        .toLowerCase()
        .replace(/[“”"'`‘'‛„‟«»「」『』\u201C\u201D\u2018\u2019\u300C\u300D\u300E\u300F]/g, '"')
        .replace(/[（(【\[\u3010]/g, '(')
        .replace(/[）)】\]\u3011]/g, ')')
        .replace(/[，、,]/g, ',')
        .replace(/[。！.!\uFF01\uFF0E]/g, '.')
        .replace(/[？?\uFF1F]/g, '?')
        .replace(/[:：]/g, ':')
        .replace(/[;\uFF1B]/g, ';')
        .replace(/[~～]/g, '~')
        .replace(/[\s\t\r\n]+/g, ' ');
}

/**
 * Check if candidate string matches target string using exact or normalized fuzzy matching.
 * @param {string} target - The text to search for (from AI patch)
 * @param {string} candidate - The existing option text in storage
 * @returns {boolean}
 */
export function isFuzzyMatch(target, candidate) {
    if (!target || !candidate) return false;
    if (target === candidate) return true;

    const normTarget = normalizeText(target);
    const normCand = normalizeText(candidate);
    if (normTarget === normCand) return true;

    if (normTarget.length >= 6 && (normCand.includes(normTarget) || normTarget.includes(normCand))) return true;

    // Compare without punctuation/brackets
    const strippedTarget = normTarget.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
    const strippedCand = normCand.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
    if (strippedTarget && strippedTarget === strippedCand) return true;
    if (strippedTarget.length >= 6 && (strippedCand.includes(strippedTarget) || strippedTarget.includes(strippedCand))) return true;

    return false;
}

// ── Diff Computation ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} DiffItem
 * @property {number} index - Index in the operations array
 * @property {string} op - Operation type ('add_options'|'replace_option'|'remove_options'|'update_template'|'update_macro'|'add_macro'|'remove_macro'|'update_group_info')
 * @property {string} [macroId] - Target macro ID
 * @property {string} title - Human-readable summary label
 * @property {'added'|'modified'|'removed'|'template'|'attribute'} type - Visual category
 * @property {Array<{ label?: string, oldVal?: any, newVal?: any, status?: 'matched'|'unmatched'|'created' }>} details
 * @property {boolean} valid - Whether the target entities exist and can be patched
 * @property {string} [error] - Error explanation if invalid
 */

/**
 * Compute detailed diff items for a list of operations against a target group.
 * @param {string} targetGroupId
 * @param {Array<Object>} operations
 * @returns {{ group: Object|null, diffs: DiffItem[], summary: { added: number, modified: number, removed: number, template: number, total: number } }}
 */
export function computePatchDiff(targetGroupId, operations) {
    const allGroups = getAllGroups();
    const group = allGroups.find(g => g.id === targetGroupId) || null;

    if (!Array.isArray(operations)) {
        return { group, diffs: [], summary: { added: 0, modified: 0, removed: 0, template: 0, total: 0 } };
    }

    const diffs = [];
    const summary = { added: 0, modified: 0, removed: 0, template: 0, total: operations.length };

    operations.forEach((opObj, idx) => {
        const op = opObj.op || opObj.action || opObj.type;
        const macroId = opObj.macroId || opObj.id || opObj.targetMacro;

        switch (op) {
            case 'update_template': {
                const oldTpl = group?.template || '(无模板)';
                const newTpl = opObj.template ?? opObj.newTemplate ?? '';
                summary.template++;
                diffs.push({
                    index: idx,
                    op: 'update_template',
                    title: '更新主注入提示词模板',
                    type: 'template',
                    valid: Boolean(group),
                    details: [{ label: '模板变更', oldVal: oldTpl, newVal: newTpl }],
                });
                break;
            }

            case 'update_group_info': {
                summary.modified++;
                const details = [];
                if (opObj.name && opObj.name !== group?.name) {
                    details.push({ label: '宏组名称', oldVal: group?.name, newVal: opObj.name });
                }
                if (opObj.injectionRole !== undefined && opObj.injectionRole !== group?.injectionRole) {
                    details.push({ label: '注入角色', oldVal: group?.injectionRole, newVal: opObj.injectionRole });
                }
                if (opObj.injectionDepth !== undefined && opObj.injectionDepth !== group?.injectionDepth) {
                    details.push({ label: '注入深度', oldVal: group?.injectionDepth, newVal: opObj.injectionDepth });
                }
                if (opObj.category && opObj.category !== group?.category) {
                    details.push({ label: '分类', oldVal: group?.category || '未分类', newVal: opObj.category });
                }
                diffs.push({
                    index: idx,
                    op: 'update_group_info',
                    title: '更新宏组基本信息',
                    type: 'attribute',
                    valid: Boolean(group),
                    details: details.length > 0 ? details : [{ label: '信息变更', newVal: '属性微调' }],
                });
                break;
            }

            case 'add_options': {
                const macro = macroId ? getMacroById(macroId) : null;
                const opts = Array.isArray(opObj.options) ? opObj.options : (opObj.text ? [{ text: opObj.text, weight: opObj.weight, tag: opObj.tag }] : []);
                summary.added += opts.length;

                diffs.push({
                    index: idx,
                    op: 'add_options',
                    macroId,
                    title: `【宏: {{random_${macroId}}}】追加 ${opts.length} 条候选项`,
                    type: 'added',
                    valid: Boolean(macro || (group && macroId)),
                    details: opts.map(o => ({
                        newVal: typeof o === 'string' ? o : o.text,
                        weight: typeof o === 'object' ? (o.weight ?? 1) : 1,
                        tag: typeof o === 'object' ? (o.tag || '') : '',
                        status: 'created',
                    })),
                });
                break;
            }

            case 'replace_option': {
                const macro = macroId ? getMacroById(macroId) : null;
                const targetText = opObj.target || opObj.oldText || opObj.match || '';
                const newText = opObj.newText || opObj.replacement || opObj.text || '';
                const newWeight = opObj.newWeight ?? opObj.weight;
                const newTag = opObj.newTag ?? opObj.tag;

                let matchedOld = null;
                if (macro && Array.isArray(macro.options)) {
                    matchedOld = macro.options.find(o => isFuzzyMatch(targetText, typeof o === 'string' ? o : o.text));
                }

                summary.modified++;
                diffs.push({
                    index: idx,
                    op: 'replace_option',
                    macroId,
                    title: `【宏: {{random_${macroId}}}】修改现有选项`,
                    type: 'modified',
                    valid: Boolean(macro),
                    error: !matchedOld ? `未能在宏 {{random_${macroId}}} 中精准匹配到原句: "${targetText}"` : null,
                    details: [{
                        oldVal: matchedOld ? (typeof matchedOld === 'string' ? matchedOld : matchedOld.text) : targetText,
                        newVal: newText,
                        oldWeight: matchedOld && typeof matchedOld === 'object' ? (matchedOld.weight ?? 1) : 1,
                        newWeight: newWeight !== undefined ? newWeight : undefined,
                        status: matchedOld ? 'matched' : 'unmatched',
                    }],
                });
                break;
            }

            case 'remove_options': {
                const macro = macroId ? getMacroById(macroId) : null;
                const matches = Array.isArray(opObj.matches) ? opObj.matches : (opObj.target ? [opObj.target] : (opObj.text ? [opObj.text] : []));
                summary.removed += matches.length;

                const details = matches.map(targetText => {
                    const matched = macro && Array.isArray(macro.options)
                        ? macro.options.find(o => isFuzzyMatch(targetText, typeof o === 'string' ? o : o.text))
                        : null;
                    return {
                        oldVal: matched ? (typeof matched === 'string' ? matched : matched.text) : targetText,
                        status: matched ? 'matched' : 'unmatched',
                    };
                });

                diffs.push({
                    index: idx,
                    op: 'remove_options',
                    macroId,
                    title: `【宏: {{random_${macroId}}}】移除 ${matches.length} 条选项`,
                    type: 'removed',
                    valid: Boolean(macro),
                    details,
                });
                break;
            }

            case 'update_macro': {
                const macro = macroId ? getMacroById(macroId) : null;
                const details = [];
                if (opObj.triggerProbability !== undefined) {
                    details.push({ label: '触发概率', oldVal: `${macro?.triggerProbability ?? 100}%`, newVal: `${opObj.triggerProbability}%` });
                }
                if (opObj.newId && opObj.newId !== macroId) {
                    details.push({ label: '宏标识重命名', oldVal: macroId, newVal: opObj.newId });
                }
                summary.modified++;
                diffs.push({
                    index: idx,
                    op: 'update_macro',
                    macroId,
                    title: `【宏: {{random_${macroId}}}】属性调整`,
                    type: 'attribute',
                    valid: Boolean(macro),
                    details: details.length > 0 ? details : [{ label: '配置更新', newVal: '微调' }],
                });
                break;
            }

            case 'add_macro': {
                summary.added++;
                const newOpts = Array.isArray(opObj.options) ? opObj.options : [];
                diffs.push({
                    index: idx,
                    op: 'add_macro',
                    macroId,
                    title: `新增子宏 {{random_${macroId}}} (含 ${newOpts.length} 条初始选项)`,
                    type: 'added',
                    valid: Boolean(group && macroId),
                    details: [{
                        label: '子宏定义',
                        newVal: `{{random_${macroId}}} (概率: ${opObj.triggerProbability ?? 100}%)`,
                    }],
                });
                break;
            }

            case 'remove_macro': {
                summary.removed++;
                diffs.push({
                    index: idx,
                    op: 'remove_macro',
                    macroId,
                    title: `从宏组中移除子宏 {{random_${macroId}}}`,
                    type: 'removed',
                    valid: Boolean(group && macroId),
                    details: [{ label: '移除子宏', oldVal: `{{random_${macroId}}}` }],
                });
                break;
            }

            default: {
                diffs.push({
                    index: idx,
                    op: op || 'unknown',
                    title: `未知操作: ${op}`,
                    type: 'modified',
                    valid: false,
                    details: [{ label: '参数', newVal: JSON.stringify(opObj) }],
                });
                break;
            }
        }
    });

    return { group, diffs, summary };
}

// ── Apply Patch Operations ────────────────────────────────────────────────────

/**
 * Apply selected operations directly to the specified macro group and its macros in storage.
 *
 * @param {string} targetGroupId
 * @param {Array<Object>} operations
 * @param {Set<number>|Array<number>|null} [selectedIndices=null] - If provided, only operations at these indices will be executed.
 * @returns {{ success: boolean, appliedCount: number, error?: string, report: string[] }}
 */
export function applyPatchOperations(targetGroupId, operations, selectedIndices = null) {
    if (!targetGroupId || !Array.isArray(operations) || operations.length === 0) {
        return { success: false, appliedCount: 0, error: '无效的操作列表或目标宏组ID', report: [] };
    }

    const allGroups = getAllGroups();
    const group = allGroups.find(g => g.id === targetGroupId);
    if (!group) {
        return { success: false, appliedCount: 0, error: `未找到目标宏配置组 (ID: ${targetGroupId})`, report: [] };
    }

    const indexSet = selectedIndices instanceof Set
        ? selectedIndices
        : (Array.isArray(selectedIndices) ? new Set(selectedIndices) : null);

    const report = [];
    let appliedCount = 0;

    // Keep track of modified macros to save in batch
    const touchedMacros = new Map();

    operations.forEach((opObj, idx) => {
        if (indexSet && !indexSet.has(idx)) {
            return; // Skipped by user selection
        }

        const op = opObj.op || opObj.action || opObj.type;
        const macroId = opObj.macroId || opObj.id || opObj.targetMacro;

        try {
            switch (op) {
                case 'update_template': {
                    const newTpl = opObj.template ?? opObj.newTemplate ?? '';
                    group.template = newTpl;
                    report.push(`已更新注入提示词模板`);
                    appliedCount++;
                    break;
                }

                case 'update_group_info': {
                    if (opObj.name) group.name = opObj.name;
                    if (opObj.injectionRole !== undefined) group.injectionRole = Number(opObj.injectionRole);
                    if (opObj.injectionDepth !== undefined) group.injectionDepth = Number(opObj.injectionDepth);
                    if (opObj.category !== undefined) group.category = opObj.category;
                    report.push(`已更新宏组基础信息`);
                    appliedCount++;
                    break;
                }

                case 'add_options': {
                    if (!macroId) break;
                    let macro = touchedMacros.get(macroId) || getMacroById(macroId);
                    if (!macro) {
                        macro = { id: macroId, triggerProbability: 100, options: [] };
                        if (!group.macros.includes(macroId)) group.macros.push(macroId);
                    }
                    const optsToAdd = Array.isArray(opObj.options)
                        ? opObj.options.map(o => ({
                            text: typeof o === 'string' ? o : o.text,
                            weight: Number(o.weight) || 1,
                            tag: o.tag || '',
                        }))
                        : (opObj.text ? [{ text: opObj.text, weight: Number(opObj.weight) || 1, tag: opObj.tag || '' }] : []);

                    if (!Array.isArray(macro.options)) macro.options = [];
                    macro.options.push(...optsToAdd);
                    touchedMacros.set(macroId, macro);
                    report.push(`已向宏 {{random_${macroId}}} 追加 ${optsToAdd.length} 条候选项`);
                    appliedCount++;
                    break;
                }

                case 'replace_option': {
                    if (!macroId) break;
                    const macro = touchedMacros.get(macroId) || getMacroById(macroId);
                    if (!macro || !Array.isArray(macro.options)) break;

                    const targetText = opObj.target || opObj.oldText || opObj.match || '';
                    const newText = opObj.newText || opObj.replacement || opObj.text || '';
                    const newWeight = opObj.newWeight ?? opObj.weight;
                    const newTag = opObj.newTag ?? opObj.tag;

                    let replaced = false;
                    for (let i = 0; i < macro.options.length; i++) {
                        const cur = macro.options[i];
                        const curText = typeof cur === 'string' ? cur : cur.text;
                        if (isFuzzyMatch(targetText, curText)) {
                            macro.options[i] = {
                                text: newText || curText,
                                weight: newWeight !== undefined ? Number(newWeight) : (typeof cur === 'object' ? (cur.weight ?? 1) : 1),
                                tag: newTag !== undefined ? newTag : (typeof cur === 'object' ? (cur.tag || '') : ''),
                            };
                            replaced = true;
                            break;
                        }
                    }

                    if (replaced) {
                        touchedMacros.set(macroId, macro);
                        report.push(`已更新宏 {{random_${macroId}}} 中的选项: "${newText}"`);
                        appliedCount++;
                    } else {
                        report.push(`[提示] 宏 {{random_${macroId}}} 中未找到原选项: "${targetText}"，已跳过替换`);
                    }
                    break;
                }

                case 'remove_options': {
                    if (!macroId) break;
                    const macro = touchedMacros.get(macroId) || getMacroById(macroId);
                    if (!macro || !Array.isArray(macro.options)) break;

                    const matches = Array.isArray(opObj.matches) ? opObj.matches : (opObj.target ? [opObj.target] : (opObj.text ? [opObj.text] : []));
                    const initialLen = macro.options.length;

                    macro.options = macro.options.filter(o => {
                        const curText = typeof o === 'string' ? o : o.text;
                        return !matches.some(m => isFuzzyMatch(m, curText));
                    });

                    const removedCount = initialLen - macro.options.length;
                    if (removedCount > 0) {
                        touchedMacros.set(macroId, macro);
                        report.push(`已从宏 {{random_${macroId}}} 移除 ${removedCount} 条选项`);
                        appliedCount++;
                    }
                    break;
                }

                case 'update_macro': {
                    if (!macroId) break;
                    let macro = touchedMacros.get(macroId) || getMacroById(macroId);
                    if (!macro) break;

                    if (opObj.triggerProbability !== undefined) {
                        macro.triggerProbability = Math.max(0, Math.min(100, Number(opObj.triggerProbability)));
                    }

                    if (opObj.newId && opObj.newId !== macroId) {
                        const newId = opObj.newId.trim();
                        // Update id in group.macros list
                        const gIdx = group.macros.indexOf(macroId);
                        if (gIdx !== -1) group.macros[gIdx] = newId;
                        macro.id = newId;
                    }

                    touchedMacros.set(macro.id, macro);
                    report.push(`已微调宏 {{random_${macro.id}}} 的属性`);
                    appliedCount++;
                    break;
                }

                case 'add_macro': {
                    if (!macroId) break;
                    let macro = touchedMacros.get(macroId) || getMacroById(macroId);
                    if (!macro) {
                        macro = {
                            id: macroId,
                            triggerProbability: Number(opObj.triggerProbability ?? 100),
                            options: (opObj.options || []).map(o => ({
                                text: typeof o === 'string' ? o : o.text,
                                weight: Number(o.weight) || 1,
                                tag: o.tag || '',
                            })),
                        };
                    }
                    if (!group.macros.includes(macroId)) {
                        group.macros.push(macroId);
                    }
                    touchedMacros.set(macroId, macro);
                    report.push(`已新增子宏 {{random_${macroId}}}`);
                    appliedCount++;
                    break;
                }

                case 'remove_macro': {
                    if (!macroId) break;
                    group.macros = (group.macros || []).filter(id => id !== macroId);
                    report.push(`已从宏组移除子宏 {{random_${macroId}}}`);
                    appliedCount++;
                    break;
                }
            }
        } catch (err) {
            console.error(`[Patch Engine] Error executing operation #${idx}:`, err);
            report.push(`[错误] 执行操作 #${idx + 1} 失败: ${err.message}`);
        }
    });

    // Save all touched macros
    touchedMacros.forEach(m => saveMacro(m));
    // Save the updated group
    saveGroup(group);

    return {
        success: appliedCount > 0,
        appliedCount,
        report,
    };
}
