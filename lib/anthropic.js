/**
 * Shared Anthropic Messages API client with retry/backoff.
 *
 * Used by both the dataops-claude node (runtime) and the DataOps AI sidebar
 * endpoints (dataops-claude-api). No Node-RED dependency — plain async fn.
 */
'use strict';

/**
 * Call the Anthropic Messages API.
 *
 * @param {object} opts
 *   apiKey, baseUrl, model, maxTokens, temperature, userPrompt, [systemPrompt]
 *   [maxAttempts=3] [timeoutMs=120000]
 * @returns {Promise<{content, text, model, usage, stop_reason}>}
 */
async function callAnthropicAPI(opts) {
    const body = {
        model: opts.model,
        max_tokens: opts.maxTokens,
        temperature: opts.temperature,
        messages: [{ role: 'user', content: opts.userPrompt }]
    };
    if (opts.systemPrompt && opts.systemPrompt.trim()) {
        body.system = opts.systemPrompt;
    }
    const bodyStr = JSON.stringify(body);
    const maxAttempts = opts.maxAttempts || 3;
    const timeoutMs = opts.timeoutMs || 120000;
    let lastError;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (attempt > 0) {
            await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(opts.baseUrl + '/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': opts.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: bodyStr,
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (!res.ok) {
                let errText = '';
                try { errText = await res.text(); } catch (_) { /* */ }
                const statusErr = new Error(`API ${res.status}: ${errText}`);
                if (res.status === 429 || res.status >= 500) { lastError = statusErr; continue; }
                throw statusErr;
            }
            const data = await res.json();
            const textBlocks = data.content.filter(b => b.type === 'text').map(b => b.text);
            return {
                content: data.content,
                text: textBlocks.join('\n') || JSON.stringify(data.content),
                model: data.model,
                usage: { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
                stop_reason: data.stop_reason
            };
        } catch (err) {
            clearTimeout(timeout);
            lastError = err;
            if (err.name === 'AbortError') lastError = new Error(`API request timed out after ${timeoutMs}ms`);
        }
    }
    throw lastError || new Error(`API request failed after ${maxAttempts} attempts`);
}

module.exports = { callAnthropicAPI };
