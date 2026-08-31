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
 * Splits options in a {{random::opt1,opt2,...}} content string by commas,
 * respecting nested braces {{...}}.
 * @param {string} innerContent
 * @returns {string[]}
 */
export function splitTopLevelOptions(innerContent) {
    const options = [];
    let current = '';
    let braceDepth = 0;

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
        } else if (char === ',' && braceDepth === 0) {
            options.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }

    if (current.trim().length > 0 || options.length > 0) {
        options.push(current.trim());
    }

    return options;
}

/**
 * Generate a friendly Chinese ID for a macro based on options or context.
 * @param {string[]} options
 * @param {number} index
 * @param {Set<string>} existingIds
 * @returns {string}
 */
function generateMacroId(options, index, existingIds) {
    // Try to extract clean keywords from options
    const cleanOpts = options.map(o => o.replace(/\{\{[^}]+\}\}/g, '').trim()).filter(Boolean);
    let candidate = '';

    if (cleanOpts.length >= 2) {
        const o1 = cleanOpts[0].substring(0, 5).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
        const o2 = cleanOpts[1].substring(0, 5).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
        if (o1 && o2) {
            candidate = `${o1}_${o2}`;
        } else if (o1) {
            candidate = o1;
        }
    } else if (cleanOpts.length === 1) {
        const o1 = cleanOpts[0].substring(0, 6).replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
        if (o1) candidate = o1;
    }

    if (!candidate) {
        candidate = `随机宏_${index}`;
    }

    let finalId = candidate;
    let suffix = 2;
    while (existingIds.has(finalId.toLowerCase())) {
        finalId = `${candidate}_${suffix++}`;
    }
    existingIds.add(finalId.toLowerCase());
    return finalId;
}

/**
 * Recursively parse and convert {{random::...}} occurrences in text.
 * @param {string} text
 * @param {string} [suggestedGroupName]
 * @returns {{ template: string, macros: Array<{ id: string, triggerProbability: number, options: Array<{ text: string, weight: number }> }>, groupName: string }}
 */
export function convertStRandomMacros(text, suggestedGroupName = '') {
    if (!text || typeof text !== 'string') {
        return { template: '', macros: [], groupName: suggestedGroupName || '酒馆宏转换组' };
    }

    const macros = [];
    const usedIds = new Set(getAllMacros().map(m => m.id.toLowerCase()));
    let macroCounter = 1;

    /**
     * Recursively convert a text snippet that may contain {{random::...}}
     * @param {string} str
     * @returns {string} Converted string with {{random_xxx}}
     */
    function processString(str) {
        let result = '';
        let i = 0;

        while (i < str.length) {
            // Check for {{random::
            const tagMatch = str.slice(i).match(/^\{\{random::/i);
            if (tagMatch) {
                const tagLen = tagMatch[0].length;
                let depth = 2; // already in {{
                let j = i + tagLen;
                let contentStart = j;

                while (j < str.length && depth > 0) {
                    if (str[j] === '{' && str[j + 1] === '{') {
                        depth += 2;
                        j += 2;
                    } else if (str[j] === '}' && str[j + 1] === '}') {
                        depth -= 2;
                        if (depth === 0) break;
                        j += 2;
                    } else {
                        j++;
                    }
                }

                if (depth === 0) {
                    const innerContent = str.slice(contentStart, j);
                    const rawOptions = splitTopLevelOptions(innerContent);

                    // Recursively process options in case they contain nested {{random::...}}
                    const processedOptions = rawOptions.map(opt => {
                        return {
                            text: processString(opt),
                            weight: 1,
                        };
                    });

                    // Generate ID
                    const macroId = generateMacroId(rawOptions, macroCounter++, usedIds);

                    macros.push({
                        id: macroId,
                        triggerProbability: 100,
                        options: processedOptions,
                    });

                    result += `{{random_${macroId}}}`;
                    i = j + 2; // Skip over the closing }}
                    continue;
                }
            }

            result += str[i];
            i++;
        }

        return result;
    }

    const template = processString(text.trim());
    const groupName = suggestedGroupName.trim() || (macros.length > 0 ? `转换组_${macros[macros.length - 1].id}` : '酒馆宏导入组');

    return {
        template,
        macros,
        groupName,
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
