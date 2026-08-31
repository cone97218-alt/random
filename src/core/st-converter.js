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
import { getAllMacros, saveMacro, saveGroup } from './storage.js';

/**
 * Splits options in a {{random::...}} content string.
 * Automatically detects whether the delimiter is '::' or ',' at the current depth level,
 * and preserves commas inside parentheses (...), brackets [...], and nested macros {{...}}.
 *
 * @param {string} innerContent
 * @returns {string[]}
 */
export function splitTopLevelOptions(innerContent) {
    if (!innerContent || typeof innerContent !== 'string') return [];

    // 1. First pass: detect if '::' exists at top level (outside {{...}})
    let hasColons = false;
    let braceDepth = 0;

    for (let i = 0; i < innerContent.length; i++) {
        const char = innerContent[i];
        const nextChar = innerContent[i + 1];

        if (char === '{' && nextChar === '{') {
            braceDepth += 2;
            i++;
        } else if (char === '}' && nextChar === '}') {
            braceDepth = Math.max(0, braceDepth - 2);
            i++;
        } else if (char === '{') {
            braceDepth++;
        } else if (char === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
        } else if (braceDepth === 0 && char === ':' && nextChar === ':') {
            hasColons = true;
            break;
        }
    }

    const delimiter = hasColons ? '::' : ',';

    // 2. Second pass: split by the detected delimiter, respecting braces, parens, brackets
    const options = [];
    let current = '';
    braceDepth = 0;
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let i = 0; i < innerContent.length; i++) {
        const char = innerContent[i];
        const nextChar = innerContent[i + 1];

        if (char === '{' && nextChar === '{') {
            braceDepth += 2;
            current += '{{';
            i++;
        } else if (char === '}' && nextChar === '}') {
            braceDepth = Math.max(0, braceDepth - 2);
            current += '}}';
            i++;
        } else if (char === '{') {
            braceDepth++;
            current += char;
        } else if (char === '}') {
            braceDepth = Math.max(0, braceDepth - 1);
            current += char;
        } else if (char === '(') {
            parenDepth++;
            current += char;
        } else if (char === ')') {
            parenDepth = Math.max(0, parenDepth - 1);
            current += char;
        } else if (char === '[') {
            bracketDepth++;
            current += char;
        } else if (char === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            current += char;
        } else if (braceDepth === 0 && delimiter === '::' && char === ':' && nextChar === ':') {
            options.push(current.trim());
            current = '';
            i++; // Skip the second colon
        } else if (braceDepth === 0 && delimiter === ',' && parenDepth === 0 && bracketDepth === 0 && (char === ',' || char === '，')) {
            options.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    if (current.trim().length > 0 || options.length > 0) {
        options.push(current.trim());
    }

    return options.filter(o => o.length > 0);
}

/**
 * Generate a clean numeric ID for a macro based on sequential ordering.
 * @param {number} index
 * @param {Set<string>} existingIds
 * @returns {string}
 */
function getNextSequentialId(counterObj, existingIds) {
    while (existingIds.has(String(counterObj.val).toLowerCase())) {
        counterObj.val++;
    }
    const finalId = String(counterObj.val++);
    existingIds.add(finalId.toLowerCase());
    return finalId;
}

/**
 * Parse input string into a tree of AST nodes.
 * @param {string} text
 * @returns {Array<Object>}
 */
export function parseToAst(text) {
    const rootNodes = [];
    let i = 0;
    let textBuffer = '';

    while (i < text.length) {
        const tagMatch = text.slice(i).match(/^\{\{random::/i);
        if (tagMatch) {
            if (textBuffer) {
                rootNodes.push({ type: 'text', value: textBuffer });
                textBuffer = '';
            }
            const tagLen = tagMatch[0].length;
            let depth = 2; // already inside {{
            let j = i + tagLen;
            let contentStart = j;

            while (j < text.length && depth > 0) {
                if (text[j] === '{' && text[j + 1] === '{') {
                    depth += 2;
                    j += 2;
                } else if (text[j] === '}' && text[j + 1] === '}') {
                    depth -= 2;
                    if (depth === 0) break;
                    j += 2;
                } else {
                    j++;
                }
            }

            if (depth === 0) {
                const innerContent = text.slice(contentStart, j);
                const rawOptions = splitTopLevelOptions(innerContent);
                const macroNode = {
                    type: 'macro',
                    raw: text.slice(i, j + 2),
                    options: rawOptions.map(opt => parseToAst(opt)),
                };
                rootNodes.push(macroNode);
                i = j + 2;
                continue;
            }
        }
        textBuffer += text[i];
        i++;
    }
    if (textBuffer) {
        rootNodes.push({ type: 'text', value: textBuffer });
    }
    return rootNodes;
}

/**
 * Top-down hierarchical AST converter for SillyTavern random macros.
 * Ensures root macros are numbered first (1, 2, ...), followed by child macros,
 * maintaining crystal-clear tree hierarchy and parent-child linkages.
 *
 * @param {string} text
 * @param {string} [suggestedGroupName]
 * @returns {{ template: string, macros: Array<Object>, groupName: string, maxDepth: number, tree: Array<Object> }}
 */
export function convertStRandomMacros(text, suggestedGroupName = '') {
    if (!text || typeof text !== 'string') {
        return { template: '', macros: [], groupName: suggestedGroupName || '酒馆宏转换组', maxDepth: 0, tree: [] };
    }

    const astList = parseToAst(text.trim());
    const usedIds = new Set(getAllMacros().map(m => String(m.id).toLowerCase()));
    const counterObj = { val: 1 };
    const flatMacros = [];
    let maxDepth = 0;

    // 1. Assign IDs top-down (Breadth-first / Pre-order from root to leaves)
    function assignIdsTopDown(nodes, level = 1, parentId = null) {
        if (level > maxDepth) maxDepth = level;

        for (const node of nodes) {
            if (node.type === 'macro') {
                node.id = getNextSequentialId(counterObj, usedIds);
                node.level = level;
                node.parentId = parentId;
                node.childrenIds = [];

                if (parentId) {
                    const parentMacro = flatMacros.find(m => m.id === parentId);
                    if (parentMacro && !parentMacro.childrenIds.includes(node.id)) {
                        parentMacro.childrenIds.push(node.id);
                    }
                }
                flatMacros.push(node);

                // Recurse on children options
                for (const optNodes of node.options) {
                    assignIdsTopDown(optNodes, level + 1, node.id);
                }
            }
        }
    }

    assignIdsTopDown(astList, 1, null);

    // 2. Render AST nodes back to converted string with {{random_xxx}}
    function renderAst(nodes) {
        let str = '';
        for (const node of nodes) {
            if (node.type === 'text') {
                str += node.value;
            } else if (node.type === 'macro') {
                str += `{{random_${node.id}}}`;
            }
        }
        return str;
    }

    // 3. Format structured macro definitions with rich hierarchy info
    const macroDefs = flatMacros.map(m => {
        return {
            id: m.id,
            level: m.level,
            parentId: m.parentId,
            childrenIds: m.childrenIds || [],
            triggerProbability: 100,
            options: m.options.map(optNodes => ({
                text: renderAst(optNodes),
                weight: 1,
            })),
        };
    });

    const template = renderAst(astList);
    const groupName = suggestedGroupName.trim() || (macroDefs.length > 0 ? `酒馆宏转换组_${macroDefs[0].id}` : '酒馆宏导入组');

    return {
        template,
        macros: macroDefs,
        groupName,
        maxDepth,
        tree: astList,
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
