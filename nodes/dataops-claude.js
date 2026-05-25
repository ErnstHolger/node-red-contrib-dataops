/**
 * dataops-claude — Send cache samples to an LLM and harvest per-topic
 * processing instructions (TOON in, TOON out).
 *
 * Workflow:
 *   1. Read cache entries.
 *   2. Encode as TOON: samples[N]{topic,ts,payload}
 *   3. Call the Anthropic-compatible Messages API.
 *   4. Parse TOON response: specs[M]{topic,type,value,timestamp,quality}
 *   5. Optionally merge into a context dictionary.
 *   6. Emit one msg per spec on output 1.
 *
 * Topic IS the canonical name — slashes preserved, no name field in the spec.
 */
'use strict';

const path = require('path');
const SqliteStore = require('../lib/sqlite-store');
const toon = require('../lib/toon');

module.exports = function(RED) {

    /**
     * Encode cache entries as TOON for the LLM prompt.
     * Each row: topic, ts (epoch ms), payload (JSON-encoded if object).
     */
    function entriesToToon(entries, maxRows) {
        const cap = (typeof maxRows === 'number' && maxRows > 0) ? Math.floor(maxRows) : 250;
        const sampled = entries.length > cap ? entries.slice(0, cap) : entries;
        const rows = sampled.map(e => ({
            topic: (e.metadata && e.metadata.originalTopic) || e.key || '',
            ts: e.ts || 0,
            payload: e.payload
        }));
        return toon.encodeTable('samples', ['topic', 'ts', 'payload'], rows);
    }

    /**
     * Parse the LLM TOON response into a spec dictionary keyed by topic.
     * Expected columns: topic, type, value, timestamp, quality.
     * Falls back to JSON.parse if TOON decode fails (for resilience).
     */
    function parseSpecResponse(text) {
        let decoded;
        try {
            decoded = toon.decodeTable(text);
        } catch (toonErr) {
            // Fallback: maybe the model emitted JSON despite instructions
            let jsonText = text;
            const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (fenceMatch) jsonText = fenceMatch[1].trim();
            try {
                const obj = JSON.parse(jsonText);
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    return { dict: obj, format: 'json-fallback' };
                }
            } catch (_) { /* fall through */ }
            throw new Error(`Could not parse response as TOON or JSON: ${toonErr.message}`);
        }

        const lcCols = decoded.columns.map(c => c.toLowerCase());
        const idx = (n) => lcCols.indexOf(n);
        const iTopic = idx('topic');
        const iType  = idx('type');
        const iVal   = idx('value');
        const iTs    = idx('timestamp');
        const iQual  = idx('quality');

        if (iTopic < 0) {
            throw new Error('TOON response missing required "topic" column');
        }

        const dict = {};
        for (const row of decoded.rows) {
            const topic = row[iTopic];
            if (topic === null || topic === undefined || topic === '') continue;
            dict[String(topic)] = {
                type:      iType  >= 0 ? (row[iType] !== null ? String(row[iType]) : '') : '',
                value:     iVal   >= 0 ? row[iVal] : null,
                timestamp: iTs    >= 0 ? row[iTs]  : null,
                quality:   iQual  >= 0 ? row[iQual] : true
            };
        }
        return { dict, format: 'toon' };
    }

    /**
     * Call the Anthropic Messages API with retry/backoff.
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
        let lastError;

        for (let attempt = 0; attempt < 3; attempt++) {
            if (attempt > 0) {
                await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)));
            }
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 120000);
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
                if (err.name === 'AbortError') lastError = new Error('API request timed out after 120s');
            }
        }
        throw lastError || new Error('API request failed after 3 attempts');
    }

    const DEFAULT_SYSTEM_PROMPT = [
        '# Role',
        'Generate per-topic processing instructions (JSONata expressions) that normalize Node-RED messages into canonical {timestamp, value, quality} records, plus a declared data type for each topic.',
        '',
        '# Input format — TOON',
        'You will receive cache samples as a TOON table:',
        '  samples[N]{topic,ts,payload}:',
        '    "<topic>",<ts>,<payload>',
        '    ...',
        'Each payload is either a bare primitive (number, boolean, null) or a quoted JSON-encoded string for objects, arrays, and complex strings.',
        '',
        '# Output format — TOON',
        'Return a TOON table with exactly these columns in this order:',
        '  specs[M]{topic,type,value,timestamp,quality}:',
        '    "<topic>",<type>,<value-jsonata>,<timestamp-jsonata>,<quality-jsonata>',
        '    ...',
        'No prose, no markdown fences, no commentary outside the TOON block.',
        'M may equal N (one spec per topic) or be smaller (group identical topics).',
        'The topic is the canonical name — preserve slashes, do NOT rename.',
        '',
        '# How to fill each column',
        '',
        '## topic',
        'Verbatim from the input row. Quote it if it contains commas or quotes.',
        '',
        '## type',
        'The most likely scalar data type. Use exactly one of: number, integer, string, boolean, object.',
        '- number: continuous numeric measurements (temperature, pressure, flow rate, level, density, voltage, current).',
        '- integer: counts, indexes, status codes, alarm severities.',
        '- string: text identifiers, names, status text, alarm messages.',
        '- boolean: on/off, active/inactive, alarm true/false, online/offline.',
        '- object: structured records that must stay as a JSON object (rare).',
        'If torn between number and integer, prefer number.',
        '',
        '## value (JSONata expression evaluated against msg)',
        '- If payload is primitive: payload',
        '- If payload is an OPC UA Variant (nested .value.value): payload.value.value',
        '- If payload is an object with .value: payload.value',
        '- If payload is an object with .v: payload.v',
        '- Otherwise pick the most plausible scalar field name from the sample.',
        'Quote the cell if the expression contains commas (e.g. JSONata function calls like "$substring(payload, 0, 5)").',
        '',
        '## timestamp (JSONata expression)',
        '- payload has a string timestamp field: "$toMillis(payload.sourceTimestamp)"',
        '- payload has a numeric epoch field: payload.ts',
        '- msg-level timestamp visible: timestamp',
        '- otherwise: $millis()',
        '',
        '## quality (JSONata expression or literal)',
        '- payload has a status/quality field: "payload.statusCode = 0" or "payload.quality = \'Good\'"',
        '- msg.quality visible: quality',
        '- otherwise: true',
        '',
        '# Example output',
        'specs[3]{topic,type,value,timestamp,quality}:',
        '  "plant/HWS/Denis/temp",number,payload.value,"$toMillis(payload.sourceTimestamp)","payload.statusCode = 0"',
        '  "plant/AIIN",integer,payload,$millis(),true',
        '  "plant/online",boolean,payload,$millis(),true'
    ].join('\n');

    function DataOpsClaudeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.cacheConfig      = RED.nodes.getNode(config.cache);
        node.apiConfig        = RED.nodes.getNode(config.apiConfig);
        node.systemPrompt     = config.systemPrompt || DEFAULT_SYSTEM_PROMPT;
        node.dbPath           = config.dbPath || path.join(RED.settings.userDir || process.cwd(), 'dataops.db');
        node.specContextKey   = config.specContextKey   || '';
        node.specContextScope = config.specContextScope || 'global';
        node.maxSampleRows    = parseInt(config.maxSampleRows) || 250;

        if (!node.cacheConfig) { node.status({ fill: 'red', shape: 'ring', text: 'no cache' }); return; }
        if (!node.apiConfig)   { node.status({ fill: 'red', shape: 'ring', text: 'no API config' }); return; }

        let store;
        try { store = new SqliteStore(node.dbPath); }
        catch (err) { node.status({ fill: 'yellow', shape: 'ring', text: 'DB init: ' + err.message }); store = null; }

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            const startTime = Date.now();

            try {
                const keys = node.cacheConfig.getKeys();
                const entries = [];
                for (const key of keys) {
                    const entry = node.cacheConfig.getValue(key);
                    if (entry) entries.push({ key, payload: entry.payload, ts: entry.ts, metadata: entry.metadata });
                }

                const toonInput = entriesToToon(entries, node.maxSampleRows);

                let userPrompt;
                if (msg.payload && typeof msg.payload === 'string' && msg.payload.trim()) {
                    userPrompt = msg.payload;
                } else {
                    const note = entries.length > node.maxSampleRows
                        ? `${node.maxSampleRows} samples from ${entries.length} total entries.`
                        : `${entries.length} entries.`;
                    userPrompt = [
                        `Cache (${note}):`,
                        '',
                        toonInput,
                        '',
                        'Generate the specs TOON table as specified by the system prompt. Output the TOON block only.'
                    ].join('\n');
                }

                const apiKey = node.apiConfig.credentials && node.apiConfig.credentials.apiKey;
                if (!apiKey) throw new Error('API key not configured.');

                node.status({ fill: 'blue', shape: 'dot', text: 'calling API...' });

                const apiResult = await callAnthropicAPI({
                    apiKey, baseUrl: node.apiConfig.baseUrl,
                    model: node.apiConfig.model,
                    maxTokens: node.apiConfig.maxTokens,
                    temperature: node.apiConfig.temperature,
                    systemPrompt: node.systemPrompt,
                    userPrompt
                });

                const durationMs = Date.now() - startTime;

                if (store) {
                    try {
                        store.insertRecord({
                            node_id: node.id, timestamp: startTime, cache_size: entries.length,
                            model: node.apiConfig.model, system_prompt: node.systemPrompt,
                            user_prompt: userPrompt,
                            response: JSON.stringify({ text: apiResult.text, blocks: apiResult.content.length }),
                            input_tokens: apiResult.usage.input_tokens,
                            output_tokens: apiResult.usage.output_tokens,
                            duration_ms: durationMs
                        });
                    } catch (dbErr) { RED.log.warn(`[dataops-claude] SQLite write: ${dbErr.message}`); }
                }

                const claudeMeta = {
                    model: apiResult.model, usage: apiResult.usage,
                    duration_ms: durationMs, cache_size: entries.length,
                    stop_reason: apiResult.stop_reason
                };

                let parsed;
                try {
                    parsed = parseSpecResponse(apiResult.text);
                } catch (parseErr) {
                    // Diagnose: was the response truncated? thinking-only?
                    const hasTextBlock = apiResult.content.some(b => b.type === 'text');
                    const truncated = apiResult.stop_reason === 'max_tokens';
                    let reason = parseErr.message;
                    if (truncated && !hasTextBlock) reason = `truncated at max_tokens=${apiResult.usage.output_tokens} (thinking only, no answer)`;
                    else if (truncated) reason = `truncated at max_tokens=${apiResult.usage.output_tokens}; ${parseErr.message}`;
                    else if (!hasTextBlock) reason = `no text block in response (thinking only); ${parseErr.message}`;
                    RED.log.warn(`[dataops-claude] ${reason}`);
                    node.status({ fill: 'red', shape: 'ring', text: reason });
                    send([null, {
                        topic: msg.topic || 'dataops/claude',
                        payload: { error: reason, raw: apiResult.text, stop_reason: apiResult.stop_reason },
                        _claude: claudeMeta, _error: true
                    }]);
                    return done();
                }

                const specDict = parsed.dict;
                const specKeys = Object.keys(specDict);

                // Optional: merge into a context dictionary
                if (node.specContextKey && specKeys.length > 0) {
                    try {
                        const ctx = node.context()[node.specContextScope];
                        const existing = ctx.get(node.specContextKey);
                        const base = (existing && typeof existing === 'object' && !Array.isArray(existing)) ? existing : {};
                        const merged = Object.assign({}, base);
                        for (const [k, v] of Object.entries(specDict)) {
                            if (v && typeof v === 'object' && !Array.isArray(v)) {
                                merged[k] = Object.assign({}, v, {
                                    _meta: { generated_at: startTime, model: apiResult.model, format: parsed.format }
                                });
                            } else {
                                merged[k] = v;
                            }
                        }
                        ctx.set(node.specContextKey, merged);
                    } catch (ctxErr) {
                        RED.log.warn(`[dataops-claude] context write: ${ctxErr.message}`);
                    }
                }

                // Emit one msg per topic
                const messages = Object.entries(specDict).map(([topic, spec]) => ({
                    topic: topic, payload: spec, _claude: claudeMeta
                }));
                send([messages, null]);

                const ctxNote = node.specContextKey ? ` → ${node.specContextScope}.${node.specContextKey}` : '';
                node.status({
                    fill: 'green', shape: 'dot',
                    text: `${specKeys.length} specs / ${entries.length} entries${ctxNote}`
                });
                done();

            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                node.send([null, {
                    topic: msg.topic || 'dataops/claude',
                    payload: { error: err.message }, _error: true
                }]);
                done(err);
            }
        });

        node.on('close', function(done) { if (store) store.close(); done(); });
        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
    }

    RED.nodes.registerType('dataops-claude', DataOpsClaudeNode);
};
