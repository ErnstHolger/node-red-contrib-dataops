/**
 * Claude Messages API client built on the official @anthropic-ai/sdk.
 *
 * Used by the dataops-claude-api config node, which exposes it to dataops-claude
 * and the DataOps AI sidebar. No Node-RED dependency.
 *
 * - Streams the response (avoids HTTP timeouts on long thinking/outputs) and
 *   returns the final message.
 * - Retries 408/409/429/5xx and connection errors via the SDK (maxRetries).
 * - Sends `temperature` only when explicitly configured: current models
 *   (Opus 4.7+, Sonnet 5+, Fable) reject sampling parameters with a 400.
 * - Optional server-side refusal fallback (`fallbacks: "default"`).
 */
'use strict';

const { Anthropic } = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_MAX_TOKENS = 16384;
const DEFAULT_TIMEOUT_MS = 300000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Normalize a configured base URL for the SDK, which appends `/v1/messages`
 * itself. Older configs stored "https://api.anthropic.com/v1" — strip the /v1.
 * Empty → undefined (SDK default).
 */
function normalizeBaseURL(url) {
    if (!url || !String(url).trim()) return undefined;
    return String(url).trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

/** True for an empty base URL (SDK default) or one on api.anthropic.com. */
function isAnthropicBaseURL(url) {
    const u = normalizeBaseURL(url);
    if (!u) return true;
    try { return new URL(u).hostname === 'api.anthropic.com'; } catch (_) { return false; }
}

/** Parse an optional temperature: '' / null / NaN → undefined (not sent). */
function parseTemperature(t) {
    if (t === undefined || t === null || String(t).trim() === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
}

function parseEffort(e) {
    const s = typeof e === 'string' ? e.trim().toLowerCase() : '';
    return EFFORTS.includes(s) ? s : undefined;
}

function createClient({ apiKey, baseUrl, timeoutMs, maxRetries }) {
    return new Anthropic({
        apiKey,
        baseURL: normalizeBaseURL(baseUrl),
        timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
        maxRetries: maxRetries === undefined ? 2 : maxRetries
    });
}

/** Build Messages API request params from resolved settings. Exported for tests. */
function buildParams(settings, { systemPrompt, userPrompt }) {
    const params = {
        model: settings.model || DEFAULT_MODEL,
        max_tokens: settings.maxTokens || DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: userPrompt }]
    };
    if (systemPrompt && String(systemPrompt).trim()) params.system = systemPrompt;
    const temperature = parseTemperature(settings.temperature);
    if (temperature !== undefined) params.temperature = temperature;
    const effort = parseEffort(settings.effort);
    if (effort) params.output_config = { effort };
    if (settings.fallbacks) {
        params.betas = [FALLBACK_BETA];
        params.fallbacks = 'default';
    }
    return params;
}

/**
 * Send one user prompt and return the final message.
 *
 * @param {Anthropic} client
 * @param {object} settings  { model, maxTokens, temperature?, effort?, fallbacks? }
 * @param {object} prompt    { systemPrompt?, userPrompt }
 * @returns {Promise<{content, text, model, usage, stop_reason, stop_details}>}
 * @throws on API errors and on stop_reason "refusal"
 */
async function complete(client, settings, prompt) {
    const params = buildParams(settings, prompt);
    const stream = params.betas
        ? client.beta.messages.stream(params)
        : client.messages.stream(params);
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
        const d = message.stop_details || {};
        const err = new Error(`Claude declined the request${d.category ? ` (${d.category})` : ''}${d.explanation ? `: ${d.explanation}` : ''}`);
        err.stop_reason = 'refusal';
        err.stop_details = message.stop_details || null;
        throw err;
    }

    const text = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    return {
        content: message.content,
        text,
        model: message.model,
        usage: {
            input_tokens: message.usage ? message.usage.input_tokens : 0,
            output_tokens: message.usage ? message.usage.output_tokens : 0
        },
        stop_reason: message.stop_reason,
        stop_details: message.stop_details || null
    };
}

/** Human-readable message for SDK errors (status + API error message when present). */
function describeError(err) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) return 'API request timed out';
    if (err instanceof Anthropic.APIConnectionError) return `API connection error: ${err.message}`;
    if (err instanceof Anthropic.APIError) {
        const apiMsg = err.error && err.error.error && err.error.error.message;
        return `API ${err.status || ''}: ${apiMsg || err.message}`.trim();
    }
    return err && err.message ? err.message : String(err);
}

module.exports = {
    createClient, complete, buildParams, describeError,
    normalizeBaseURL, isAnthropicBaseURL, parseTemperature, parseEffort,
    DEFAULT_MODEL, DEFAULT_MAX_TOKENS, EFFORTS
};
