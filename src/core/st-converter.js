/**
 * st-converter.js - Converts SillyTavern native {{random::...}} macros into Random Macro Extension format
 *
 * Features:
 *   - Parses arbitrarily nested {{random::...}} structures with depth tracking
 *   - Automatically generates intuitive Chinese macro IDs and nested relations
 *   - Converts root text into {{random_xxx}} template
 *   - Supports batch import into extension storage (macros + macro group)
 */

import { generateId } from '../utils/dom.js';
import { getAllMacros, getAllGroups, saveMacro, saveGroup } from './storage.js';

/**
 * Check if a substring at index starts with any random macro opening tag.
 * Matches: {{random:: , {{random: , {{pick:: , {{pick: , {{roll:: , {{roll:
 * case-insensitively with optional spaces.
 *
 * @param {string} text
 * @param {number} index
 * @returns {string|null}
 */
export function matchRandomOpenTag(text, index) {
    const slice = text.slice(index);
    const match = slice.match(/^\{\{\s*(?:random|pick|roll)\s*::?/i);
    return match ? match[0] : null;
}

/**
 * Find the closing '}}' for a macro opening at contentStart with balanced brace depth.
 * Ensures non-random inner macros like {{char}}, {{user}}, {{getvar::...}} don't prematurely close the block.
 *
 * @param {string} text
 * @param {number} contentStart
 * @returns {number} Index where closing '}}' starts, or -1 if unbalanced
 */
export function findMatchingClosingBraces(text, contentStart) {
    let depth = 2; // already inside opening '{{'
    let i = contentStart;

    while (i < text.length && depth > 0) {
        if (text[i] === '{' && text[i + 1] === '{') {
            depth += 2;
            i += 2;
        } else if (text[i] === '}' && text[i + 1] === '}') {
            depth -= 2;
            if (depth === 0) {
                return i;
            }
            i += 2;
        } else {
            i++;
        }
    }
    return -1;
}

/**
 * Check if a text snippet contains any un-converted random macro opening tag.
 * @param {string} text
 * @returns {boolean}
 */
export function containsRandomOpenTag(text) {
    return /\{\{\s*(?:random|pick|roll)\s*::?/i.test(text);
}

/**
 * Splits options in an innermost (leaf-level) random macro content string.
 * Preserves non-random nested macros like {{char}}, {{user}}, {{getvar::...}}
 * and parentheses (...), brackets [...] without splitting them.
 * Note: Only splits by '::' or ASCII comma ',', NEVER by Chinese full-width comma '，'.
 *
 * @param {string} innerContent
 * @returns {string[]}
 */
export function splitInnermostOptions(innerContent) {
    if (!innerContent || typeof innerContent !== 'string') return [];
    
    // 1. Scan at top level (depth 0 of any {{...}}, (...), [...]) to see if '::' exists
    let hasColons = false;
    let braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < innerContent.length; i++) {
        if (innerContent[i] === '{' && innerContent[i + 1] === '{') {
            braceDepth += 2;
            i++;
        } else if (innerContent[i] === '}' && innerContent[i + 1] === '}') {
            braceDepth = Math.max(0, braceDepth - 2);
            i++;
        } else if (innerContent[i] === '(') {
            parenDepth++;
        } else if (innerContent[i] === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
        } else if (innerContent[i] === '[') {
            bracketDepth++;
        } else if (innerContent[i] === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
        } else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && innerContent[i] === ':' && innerContent[i + 1] === ':') {
            hasColons = true;
            break;
        }
    }

    const delimiter = hasColons ? '::' : ',';

    // 2. Split by delimiter at top level
    const options = [];
    let current = '';
    braceDepth = 0;
    parenDepth = 0;
    bracketDepth = 0;

    for (let i = 0; i < innerContent.length; i++) {
        if (innerContent[i] === '{' && innerContent[i + 1] === '{') {
            braceDepth += 2;
            current += '{{';
            i++;
        } else if (innerContent[i] === '}' && innerContent[i + 1] === '}') {
            braceDepth = Math.max(0, braceDepth - 2);
            current += '}}';
            i++;
        } else if (innerContent[i] === '(') {
            parenDepth++;
            current += '(';
        } else if (innerContent[i] === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
            current += ')';
        } else if (innerContent[i] === '[') {
            bracketDepth++;
            current += '[';
        } else if (innerContent[i] === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            current += ']';
        } else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && delimiter === '::' && innerContent[i] === ':' && innerContent[i + 1] === ':') {
            options.push(current.trim());
            current = '';
            i++;
        } else if (braceDepth === 0 && parenDepth === 0 && bracketDepth === 0 && delimiter === ',' && innerContent[i] === ',') {
            options.push(current.trim());
            current = '';
        } else {
            current += innerContent[i];
        }
    }

    if (current.trim().length > 0 || options.length > 0) {
        options.push(current.trim());
    }

    return options.filter(o => o.length > 0);
}

/**
 * Calculate the next available integer root index that avoids collisions with existing macros.
 * @returns {number}
 */
export function getNextAvailableRootIndex() {
    const existingMacros = getAllMacros();
    const existingGroups = getAllGroups();
    let maxIndex = 0;

    // 1. Check all macro IDs
    existingMacros.forEach(m => {
        const str = String(m.id || '').trim();
        const match = str.match(/^(\d+)/);
        if (match) {
            const num = parseInt(match[1], 10);
            if (!isNaN(num) && num > maxIndex) maxIndex = num;
        }
    });

    // 2. Check all group templates & referenced macros
    existingGroups.forEach(g => {
        (g.macros || []).forEach(mid => {
            const str = String(mid || '').trim();
            const match = str.match(/^(\d+)/);
            if (match) {
                const num = parseInt(match[1], 10);
                if (!isNaN(num) && num > maxIndex) maxIndex = num;
            }
        });
        const templateMatches = [...(g.template || '').matchAll(/\{\{random_(\d+)[^}]*\}\}/gi)];
        templateMatches.forEach(tm => {
            const num = parseInt(tm[1], 10);
            if (!isNaN(num) && num > maxIndex) maxIndex = num;
        });
    });

    return maxIndex + 1;
}

/**
 * Bottom-up (innermost-first) parser and converter for SillyTavern random macros.
 * Recursively resolves leaf macros from the inside out, constructing clean nested relations.
 *
 * @param {string} text
 * @param {string} [suggestedGroupName]
 * @returns {{ template: string, macros: Array<Object>, groupName: string, maxDepth: number }}
 */
export function convertStRandomMacros(text, suggestedGroupName = '', startRootNumber = null) {
    if (!text || typeof text !== 'string') {
        return { template: '', macros: [], groupName: suggestedGroupName || '酒馆宏转换组', maxDepth: 0 };
    }

    let workingText = text.trim();

    // Auto-balance missing closing braces if user omitted the last }}
    const openCount = (workingText.match(/\{\{/g) || []).length;
    const closeCount = (workingText.match(/\}\}/g) || []).length;
    if (openCount > closeCount) {
        workingText += '}}'.repeat(openCount - closeCount);
    }

    const rawMacros = [];
    let tempCounter = 1;
    let maxIterations = 500;

    // 1. Bottom-up extraction: continually extract the innermost {{random::...}} (leaf macros)
    while (maxIterations-- > 0) {
        let candidateStart = -1;
        let candidateTag = null;
        let candidateContentStart = -1;
        let candidateEnd = -1;
        let candidateInnerContent = null;

        // Scan backwards to find the innermost random macro block
        for (let i = workingText.length - 1; i >= 0; i--) {
            const tag = matchRandomOpenTag(workingText, i);
            if (tag) {
                const contentStart = i + tag.length;
                const endIdx = findMatchingClosingBraces(workingText, contentStart);
                if (endIdx !== -1) {
                    const innerContent = workingText.substring(contentStart, endIdx);
                    // Ensure this block contains no other un-converted random macro tags
                    if (!containsRandomOpenTag(innerContent)) {
                        candidateStart = i;
                        candidateTag = tag;
                        candidateContentStart = contentStart;
                        candidateEnd = endIdx;
                        candidateInnerContent = innerContent;
                        break;
                    }
                }
            }
        }

        if (candidateStart === -1) {
            break; // No more random macros found
        }

        const rawOptions = splitInnermostOptions(candidateInnerContent);
        const tempId = String(tempCounter++);
        const placeholder = `@@RANDOM_MACRO_${tempId}@@`;

        rawMacros.push({
            tempId,
            placeholder,
            triggerProbability: 100,
            options: rawOptions.map(opt => ({ text: opt, weight: 1 })),
        });

        // Replace the matched innermost block with the atomic placeholder
        workingText = workingText.substring(0, candidateStart) + placeholder + workingText.substring(candidateEnd + 2);
    }

    // 2. Build tree relations from placeholders
    const template = workingText;

    const macroDefs = rawMacros.map(m => ({
        tempId: m.tempId,
        triggerProbability: m.triggerProbability,
        options: m.options.map(opt => ({ text: opt.text, weight: opt.weight })),
        childrenTempIds: [],
        parentTempId: null,
        level: 1,
    }));

    // Find children
    macroDefs.forEach(m => {
        const childSet = new Set();
        m.options.forEach(opt => {
            const matches = [...opt.text.matchAll(/@@RANDOM_MACRO_(\d+)@@/g)].map(match => match[1]);
            matches.forEach(cid => childSet.add(cid));
        });
        m.childrenTempIds = [...childSet];
    });

    // Find parents
    macroDefs.forEach(parent => {
        parent.childrenTempIds.forEach(cid => {
            const child = macroDefs.find(m => m.tempId === cid);
            if (child) child.parentTempId = parent.tempId;
        });
    });

    // Roots in the main template
    const templateRootTempIds = [...template.matchAll(/@@RANDOM_MACRO_(\d+)@@/g)].map(m => m[1]);

    // 3. Option-Indexed Hierarchical ID Assignment:
    // When sub-macros appear inside Option K of Root Macro, they become Prefix-K-1, Prefix-K-2...
    // e.g. Root 1, Option 11 -> {{random_1-11-1}}
    const baseStart = Number(startRootNumber) > 0
        ? Number(startRootNumber)
        : getNextAvailableRootIndex();
    let rootCounter = baseStart;
    const idMap = {};

    function assignOptionIndexedIds(tempId, currentPrefix, currentLevel) {
        idMap[tempId] = currentPrefix;
        const m = macroDefs.find(node => node.tempId === tempId);
        if (!m) return;
        m.level = currentLevel;

        // Iterate through each option of this macro
        m.options.forEach((opt, optIndex) => {
            const optNum = optIndex + 1;
            const subMatches = [...opt.text.matchAll(/@@RANDOM_MACRO_(\d+)@@/g)].map(match => match[1]);
            
            subMatches.forEach((childTempId, subIndex) => {
                const childPrefix = `${currentPrefix}-${optNum}-${subIndex + 1}`;
                assignOptionIndexedIds(childTempId, childPrefix, currentLevel + 1);
            });
        });
    }

    templateRootTempIds.forEach(rootTempId => {
        const rootId = String(rootCounter++);
        assignOptionIndexedIds(rootTempId, rootId, 1);
    });

    // Handle any orphaned macros (if any)
    macroDefs.forEach(m => {
        if (!idMap[m.tempId]) {
            const orphanId = String(rootCounter++);
            assignOptionIndexedIds(m.tempId, orphanId, 1);
        }
    });

    // Calculate max depth
    let maxDepth = 1;
    macroDefs.forEach(m => {
        if (m.level > maxDepth) maxDepth = m.level;
    });

    // Sort in top-down tree display order
    const orderedList = [];
    const visited = new Set();
    function addSubtree(tempId) {
        if (visited.has(tempId)) return;
        visited.add(tempId);
        const m = macroDefs.find(node => node.tempId === tempId);
        if (!m) return;
        orderedList.push(m);
        m.childrenTempIds.forEach(cid => addSubtree(cid));
    }
    templateRootTempIds.forEach(rootId => addSubtree(rootId));
    macroDefs.forEach(m => { if (!visited.has(m.tempId)) orderedList.push(m); });

    function replaceWithFinalIds(str) {
        return str.replace(/@@RANDOM_MACRO_(\d+)@@/g, (match, tempId) => `{{random_${idMap[tempId] || tempId}}}`);
    }

    const finalMacros = orderedList.map(m => ({
        id: idMap[m.tempId],
        level: m.level,
        parentId: m.parentTempId ? idMap[m.parentTempId] : null,
        childrenIds: m.childrenTempIds.map(cid => idMap[cid]),
        triggerProbability: m.triggerProbability,
        options: m.options.map(opt => ({
            text: replaceWithFinalIds(opt.text),
            weight: opt.weight,
        })),
    }));

    const finalTemplate = replaceWithFinalIds(template);
    const groupName = suggestedGroupName.trim() || (finalMacros.length > 0 ? `酒馆宏转换组_${finalMacros[0].id}` : '酒馆宏导入组');

    return {
        template: finalTemplate,
        macros: finalMacros,
        groupName,
        maxDepth,
    };
}

/**
 * Save converted macros and macro group into storage.
 * @param {Object} params
 * @param {string} params.groupName
 * @param {string} params.template
 * @param {Array<Object>} params.macros
 * @param {number} [params.injectionDepth=4]
 * @param {number} [params.injectionRole=0]
 * @param {string} [params.scope='global']
 * @returns {{ groupId: string, macroCount: number }}
 */
export function importConvertedGroup({
    groupName,
    template,
    macros,
    injectionDepth = 4,
    injectionOrder = 0,
    injectionRole = 0,
    scope = 'global',
}) {
    // 1. Save all macros
    for (const macro of macros) {
        saveMacro({
            id: macro.id,
            triggerProbability: Number(macro.triggerProbability) || 100,
            options: (macro.options || []).map(o => ({
                text: typeof o === 'string' ? o : (o.text || ''),
                weight: Number(o.weight) || 1,
            })),
        });
    }

    // 2. Save group
    const groupId = generateId();
    const group = {
        id: groupId,
        name: groupName.trim() || '酒馆宏转换组',
        scope: scope || 'global',
        enabled: true,
        injectionDepth: Number(injectionDepth) ?? 4,
        injectionOrder: Number(injectionOrder) ?? 0,
        injectionRole: Number(injectionRole) ?? 0,
        template: template.trim(),
        macros: macros.map(m => m.id),
        lifecycle: { useGlobal: true, everyXRounds: null, keepYRounds: null },
    };
    saveGroup(group);

    return {
        groupId,
        macroCount: macros.length,
    };
}
