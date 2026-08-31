/**
 * ai-client.js - AI generation client for the random macro extension
 *
 * Uses SillyTavern's current API and preset.
 * Builds messages[] from the prompt component pipeline, injects extension
 * chat history as real multi-turn context, then streams results.
 */

import { getContext } from '../../../../../extensions.js';
import { oai_settings, getChatCompletionModel, createGenerationParameters } from '../../../../../openai.js';
import { getSettings } from './storage.js';
import { buildMessages } from './prompt-builder.js';

// ── SSE stream reader ─────────────────────────────────────────────────────────

async function* readSSEStream(reader, decoder) {
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed === 'data: [DONE]') continue;
                if (trimmed.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(trimmed.slice(6));
                        const text = json.choices?.[0]?.delta?.content || '';
                        if (text) yield text;
                    } catch (_) {}
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// ── Error parsing ─────────────────────────────────────────────────────────────

async function parseErrorResponse(response) {
    let errorMsg = response.statusText;
    try {
        const errText = await response.text();
        const errData = JSON.parse(errText);
        if (errData?.error?.message) errorMsg = errData.error.message;
        else if (errData?.message)   errorMsg = errData.message;
        else if (errText)            errorMsg = errText;
    } catch (_) {}
    return errorMsg;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Call the ST current AI in streaming mode.
 *
 * @param {string} userPrompt - Current user input
 * @param {AbortSignal} [signal] - Optional abort signal
 * @param {Array} [chatHistory] - Extension chat history turns
 * @yields {string} Text chunks
 */
export async function* generateMacroOptions(userPrompt, signal = null, chatHistory = []) {
    const ctx = getContext();
    const messages = await buildMessages(userPrompt, chatHistory);

    try {
        let model = '';
        try {
            model = getChatCompletionModel(oai_settings);
        } catch (e) {
            console.warn('[Random AI] getChatCompletionModel failed:', e);
        }

        const { generate_data } = await createGenerationParameters(oai_settings, model || 'default', 'chat', messages);
        generate_data.stream = true;

        const response = await fetch('/api/backends/chat-completions/generate', {
            method: 'POST',
            body: JSON.stringify(generate_data),
            headers: { 'Content-Type': 'application/json', ...ctx.getRequestHeaders() },
            signal,
        });

        if (!response.ok) {
            const errorMsg = await parseErrorResponse(response);
            throw new Error(`AI 请求失败: ${errorMsg}`);
        }

        const contentType = response.headers.get('content-type') || '';

        if (contentType.includes('application/json')) {
            const data = await response.json();
            const reply = data.choices?.[0]?.message?.content || data.content || '';
            if (reply) yield reply;
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        for await (const chunk of readSSEStream(reader, decoder)) {
            yield chunk;
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            console.log('[Random AI] Generation aborted by user.');
            return;
        }
        console.error('[Random AI] Generation error:', err);
        throw err;
    }
}

/**
 * Try to parse structured JSON from AI output (handles code blocks or raw JSON).
 * @param {string} text
 * @returns {Object|null}
 */
export function tryParseStructuredAIResponse(text) {
    if (!text || typeof text !== 'string') return null;

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || text.match(/(\{[\s\S]*\})/);
    const candidate = jsonMatch ? jsonMatch[1] : text.trim();

    try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object' && (parsed.isFullGroup || parsed.macros || parsed.groupName)) {
            return parsed;
        }
    } catch (_) {}

    return null;
}

/**
 * Parse a raw AI response text into an array of option strings.
 * Splits by newline and strips numbering/bullets.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseAIResponseToOptions(text) {
    if (!text || !text.trim()) return [];

    if (tryParseStructuredAIResponse(text)) return [];

    return text
        .split('\n')
        .map(line => line
            .replace(/^\s*(?:\d+[.)、]\s*|[-•*]\s*)/, '')
            .trim()
        )
        .filter(line => line.length > 0 && !line.startsWith('```'));
}
