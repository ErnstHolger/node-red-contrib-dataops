/**
 * dataops-claude — Send cache samples to Claude and harvest per-topic
 * processing instructions (TOON in, TOON out).
 *
 * Workflow (on any input):
 *   1. Read samples from the Source dictionary <sourceScope>.<sourceKey>
 *      (a wrapped cache written by dataops-in; bare-value dicts are tolerated).
 *   2. Encode as TOON: samples[N]{topic,ts,payload}
 *   3. Call Claude via the dataops-claude-api config node.
 *   4. Parse TOON response: specs[M]{topic,type,value,timestamp,quality}
 *      (JSON object fallback).
 *   5. Merge into the Destination dictionary <specScope>.<specKey>.
 *   6. Emit one msg per spec on output 1.
 *
 * A non-empty string in msg.payload replaces the generated user prompt.
 * Topic IS the canonical name — slashes preserved, no name field in the spec.
 */
'use strict';

const toon = require('../lib/toon');
const { describeError } = require('../lib/anthropic');
const { sanitizeKey } = require('../lib/ctxkey');
const { readDict, writeDict } = require('../lib/context');
const { isWrapped } = require('../lib/values');

const DEFAULT_MAX_SAMPLES = 250;

// ---------------------------------------------------------------------------
// Default system prompt
//
// Teaches Claude to turn a cache dictionary (TOON samples) into one spec per
// topic for dataops-transform. The worked example is built with the real TOON
// encoder so its quoting always matches what Claude receives. Every expression
// in EXAMPLE_SPECS is executed by test/nodes.test.js against EXAMPLE_SAMPLES.
// ---------------------------------------------------------------------------

const SPEC_COLUMNS = ['topic', 'type', 'value', 'timestamp', 'quality', 'unit', 'description'];

const EXAMPLE_SAMPLES = [
    { topic: 'plant/boiler/temp', ts: 1780000000000,
      payload: { value: { value: 182.4, dataType: 'Double' }, sourceTimestamp: '2026-05-30 20:54:56.056+0100', statusCode: 0 } },
    { topic: 'plant/boiler/pressure', ts: 1780000000000,
      payload: { value: 12.7, quality: 'Good', unit: 'bar' } },
    { topic: 'plant/pump/running', ts: 1780000000000,
      payload: { v: true, ts: 1780000000 } },
    { topic: 'plant/line/count', ts: 1780000000000,
      payload: 4711 },
    { topic: 'plant/tank/level', ts: 1780000000000,
      payload: { reading: { val: 61.4, unit: '%' }, status: { value: 2150891520, name: 'BadSensorFailure' } } }
];

const EXAMPLE_SPECS = [
    { topic: 'plant/boiler/temp', type: 'number', value: 'payload.value.value',
      timestamp: '$toMillis(payload.sourceTimestamp)', quality: 'payload.statusCode < 1073741824',
      unit: undefined, description: 'Boiler temperature' },
    { topic: 'plant/boiler/pressure', type: 'number', value: 'payload.value',
      timestamp: '$millis()', quality: "$lowercase(payload.quality) = 'good'",
      unit: 'bar', description: 'Boiler pressure' },
    { topic: 'plant/pump/running', type: 'boolean', value: 'payload.v',
      timestamp: 'payload.ts * 1000', quality: 'true',
      unit: undefined, description: 'Pump running state' },
    { topic: 'plant/line/count', type: 'integer', value: 'payload',
      timestamp: '$millis()', quality: 'true',
      unit: undefined, description: 'Line production count' },
    { topic: 'plant/tank/level', type: 'number', value: 'payload.reading.val',
      timestamp: '$millis()', quality: 'payload.status.value < 1073741824',
      unit: '%', description: 'Tank fill level' }
];

const indent = (text) => text.split('\n').map(l => '    ' + l).join('\n');

const DEFAULT_SYSTEM_PROMPT = [
    '# Role',
    '',
    'You write normalization specs for a Node-RED data pipeline.',
    'For every topic in a cache dictionary, write one spec that tells the',
    'dataops-transform node how to turn that topic\'s raw messages into a clean record:',
    '',
    '    { name, type, timestamp, value, quality }',
    '',
    '# How your specs are used',
    '',
    '- A spec is applied to every LIVE message on its topic, not to the sample.',
    '- `value`, `timestamp` and `quality` are JSONata expressions evaluated against the',
    '  whole Node-RED message `{ topic, payload, ... }`. Write `payload.x`, never `msg.payload.x`.',
    '- At runtime `payload` is already a parsed object. Never use `$eval()` or `$fromJSON()`.',
    '- The result of `value` is converted to `type`. Prefer the simplest expression that fits.',
    '',
    '# Input',
    '',
    'A TOON table with one row per topic:',
    '',
    '    samples[N]{topic,ts,payload}:',
    '      "<topic>",<ts>,<payload>',
    '',
    '| Column  | Meaning                                                                    |',
    '|---------|----------------------------------------------------------------------------|',
    '| topic   | The topic. It becomes the record name.                                     |',
    '| ts      | When the cache received the sample (epoch ms). Not device time. Ignore it. |',
    '| payload | A bare number/boolean/null, or the payload object as a quoted JSON string. |',
    '',
    '# Output',
    '',
    'Return ONLY this TOON table: no prose, no markdown fences.',
    '',
    '    specs[M]{' + SPEC_COLUMNS.join(',') + '}:',
    '      "<topic>",<type>,<value>,<timestamp>,<quality>,<unit>,<description>',
    '',
    '- Exactly one row per input topic, in input order (M = N).',
    '- Copy `topic` verbatim, including slashes.',
    '- Wrap a cell in double quotes when it contains a comma, a space or a double quote.',
    '- Inside JSONata, use single-quoted strings (`\'Good\'`) so nothing needs escaping.',
    '- Leave `unit` or `description` empty (nothing between the commas) when unknown.',
    '',
    '# Column rules',
    '',
    '## 1. type: exactly one of these words',
    '',
    '| type    | Use for                                                               |',
    '|---------|-----------------------------------------------------------------------|',
    '| number  | Measurements: temperature, pressure, flow, level, speed, voltage, ... |',
    '| integer | Counts, ids, enumerations, alarm severities                           |',
    '| boolean | On/off, running/stopped, open/closed, alarm active                    |',
    '| string  | Names, modes, status text, messages                                   |',
    '| object  | Structured records that must stay together (rare)                     |',
    '',
    'Anything measured is `number`, even when the sample happens to be a whole number.',
    '',
    '## 2. value: where the measurement is',
    '',
    'Match the payload style (first match wins):',
    '',
    '| Payload in the sample                          | value                    | Style              |',
    '|------------------------------------------------|--------------------------|--------------------|',
    '| `25.4`, `true`, `"RUN"`                        | `payload`                | bare scalar        |',
    '| `{"value":{"value":25.4,"dataType":"Double"}}` | `payload.value.value`    | OPC UA Variant     |',
    '| `{"value":1013.2,"quality":"Good"}`            | `payload.value`          | Kepware / generic  |',
    '| `{"v":true,"ts":1780000000}`                   | `payload.v`              | Sparkplug B        |',
    '| `{"reading":{"val":1.2,"unit":"bar"}}`         | `payload.reading.val`    | nested with unit   |',
    '| `{"data":[{"value":1},{"value":2}]}`           | `payload.data[-1].value` | array: latest item |',
    '| anything else                                  | the measurement field    |                    |',
    '',
    'Never pick metadata as the value: unit, dataType, id, timestamps, status or quality fields.',
    '',
    '## 3. timestamp: device time as epoch milliseconds',
    '',
    '| Time field in the sample                          | timestamp                        |',
    '|---------------------------------------------------|----------------------------------|',
    '| ISO date string: `"2026-05-30T20:54:56Z"`         | `$toMillis(payload.<field>)`     |',
    '| Device date string: `"2026-05-30 20:54:56+0100"`  | `$toMillis(payload.<field>)`     |',
    '| Epoch milliseconds, 13 digits: `1780000000000`    | `payload.<field>`                |',
    '| Epoch seconds, 10 digits: `1780000000`            | `payload.<field> * 1000`         |',
    '| Epoch microseconds, 16 digits: `1780000000000000` | `$floor(payload.<field> / 1000)` |',
    '| No time field                                     | `$millis()`                      |',
    '',
    'Use the real field name from the sample. `$toMillis` here also accepts a space instead',
    'of `T` and offsets without a colon.',
    '',
    '## 4. quality: true when the reading is good, false when it is not',
    '',
    '| Quality field in the sample                       | quality                                  |',
    '|---------------------------------------------------|------------------------------------------|',
    '| OPC UA status code number: `"statusCode":0`       | `payload.statusCode < 1073741824`        |',
    '| OPC UA status object: `{"value":0,"name":"Good"}` | `payload.<field>.value < 1073741824`     |',
    "| Quality text: `\"Good\"`, `\"GOOD\"`, `\"Bad\"`         | `$lowercase(payload.quality) = 'good'`   |",
    '| OPC DA numeric quality: `192` = good              | `payload.quality >= 192`                 |',
    '| Boolean quality field                             | `payload.quality`                        |',
    '| No quality field                                  | `true`                                   |',
    '',
    'OPC UA status codes below 1073741824 (0x40000000) are Good. Uncertain and Bad codes',
    'have the top bits set.',
    '',
    '## 5. unit: plain text, not an expression',
    '',
    '- Copy it from the payload when present (`unit`, `reading.unit`, `EngineeringUnits`): e.g. `bar`.',
    '- Otherwise leave it empty. Never guess, e.g. between degC and degF.',
    '- Leave it empty for boolean and string topics.',
    '',
    '## 6. description: plain text',
    '',
    '- A short label of at most 6 words, built from the topic path: e.g. `"Boiler temperature"`.',
    '- Always quote it.',
    '',
    '# Example',
    '',
    'Input:',
    '',
    indent(toon.encodeTable('samples', ['topic', 'ts', 'payload'], EXAMPLE_SAMPLES)),
    '',
    'Output:',
    '',
    indent(toon.encodeTable('specs', SPEC_COLUMNS, EXAMPLE_SPECS)),
    '',
    '# Before you answer, check',
    '',
    '1. One row per input topic, in input order, topic copied verbatim.',
    '2. Seven cells per row.',
    '3. `type` is one of: number, integer, boolean, string, object.',
    '4. Expressions start from `payload` and use no `msg.`, `$eval` or `$fromJSON`.',
    '5. Cells with commas, spaces or double quotes are double-quoted.',
    '6. The answer is the TOON table and nothing else.'
].join('\n');

/** Dictionary → sample entries [{key, payload, ts, metadata}]. */
function dictToEntries(dict) {
    return Object.entries(dict).map(([key, entry]) => isWrapped(entry)
        ? { key, payload: entry.payload, ts: entry.ts, metadata: entry.metadata }
        : { key, payload: entry, ts: undefined, metadata: undefined });
}

/** Encode up to maxRows entries as a TOON samples table. */
function entriesToToon(entries, maxRows) {
    const rows = entries.slice(0, maxRows).map(e => ({
        topic: (e.metadata && e.metadata.originalTopic) || e.key || '',
        ts: e.ts || 0,
        payload: e.payload
    }));
    return toon.encodeTable('samples', ['topic', 'ts', 'payload'], rows);
}

/**
 * Parse the model's response into a spec dictionary keyed by topic.
 * TOON first; falls back to a JSON object (fences stripped).
 */
function parseSpecResponse(text) {
    let decoded;
    try {
        decoded = toon.decodeTable(text);
    } catch (toonErr) {
        let jsonText = text;
        const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) jsonText = fence[1].trim();
        try {
            const obj = JSON.parse(jsonText);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { dict: obj, format: 'json-fallback' };
        } catch (_) { /* fall through */ }
        throw new Error(`Could not parse response as TOON or JSON: ${toonErr.message}`);
    }

    const cols = decoded.columns.map(c => c.toLowerCase());
    const col = (n) => cols.indexOf(n);
    const iTopic = col('topic'), iType = col('type'), iVal = col('value'), iTs = col('timestamp'), iQual = col('quality');
    const iUnit = col('unit'), iDesc = col('description');
    if (iTopic < 0) throw new Error('TOON response missing required "topic" column');

    const dict = {};
    for (const row of decoded.rows) {
        const topic = row[iTopic];
        if (topic === null || topic === undefined || topic === '') continue;
        const spec = {
            type:      iType >= 0 && row[iType] !== null ? String(row[iType]) : '',
            value:     iVal  >= 0 ? row[iVal]  : null,
            timestamp: iTs   >= 0 ? row[iTs]   : null,
            quality:   iQual >= 0 ? row[iQual] : true
        };
        // Reference only; dataops-transform ignores them.
        if (iUnit >= 0 && row[iUnit] !== null && row[iUnit] !== '') spec.unit = String(row[iUnit]);
        if (iDesc >= 0 && row[iDesc] !== null && row[iDesc] !== '') spec.description = String(row[iDesc]);
        dict[String(topic)] = spec;
    }
    return { dict, format: 'toon' };
}

module.exports = function(RED) {

    function DataOpsClaudeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.apiConfig     = RED.nodes.getNode(config.apiConfig);
        node.systemPrompt  = (config.systemPrompt && config.systemPrompt.trim()) ? config.systemPrompt : DEFAULT_SYSTEM_PROMPT;
        node.sourceScope   = config.sourceScope || 'global';
        node.sourceKey     = sanitizeKey(config.sourceKey);
        // Destination; legacy property names still read for older flows.
        node.specScope     = config.specScope || config.specContextScope || 'global';
        node.specKey       = sanitizeKey(config.specKey || config.specContextKey);
        node.maxSampleRows = parseInt(config.maxSampleRows, 10) > 0 ? parseInt(config.maxSampleRows, 10) : DEFAULT_MAX_SAMPLES;

        function setReady() {
            if (!node.apiConfig) node.status({ fill: 'red', shape: 'ring', text: 'no API config' });
            else if (!node.sourceKey) node.status({ fill: 'yellow', shape: 'ring', text: 'no source key' });
            else node.status({ fill: 'green', shape: 'dot', text: 'ready' });
        }
        setReady();

        function fail(send, msg, payload, extra) {
            send([null, Object.assign({ topic: msg.topic || 'dataops/claude', payload, _error: true }, extra)]);
        }

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };
            const startTime = Date.now();

            try {
                if (!node.apiConfig) throw new Error('No API config selected');

                const customPrompt = typeof msg.payload === 'string' && msg.payload.trim() ? msg.payload : null;
                const entries = dictToEntries(readDict(node, node.sourceScope, node.sourceKey));
                if (!customPrompt && entries.length === 0) {
                    throw new Error(node.sourceKey
                        ? `Source dictionary ${node.sourceScope}.${node.sourceKey} is empty`
                        : 'No Source Key configured');
                }

                let userPrompt = customPrompt;
                if (!userPrompt) {
                    const note = entries.length > node.maxSampleRows
                        ? `${node.maxSampleRows} samples from ${entries.length} total entries.`
                        : `${entries.length} entries.`;
                    userPrompt = [
                        `Cache (${note}):`,
                        '',
                        entriesToToon(entries, node.maxSampleRows),
                        '',
                        'Generate the specs TOON table as specified by the system prompt. Output the TOON block only.'
                    ].join('\n');
                }

                node.status({ fill: 'blue', shape: 'dot', text: 'calling API...' });

                let apiResult;
                try {
                    apiResult = await node.apiConfig.complete({ systemPrompt: node.systemPrompt, userPrompt });
                } catch (apiErr) {
                    const reason = describeError(apiErr);
                    node.status({ fill: 'red', shape: 'ring', text: reason.slice(0, 60) });
                    fail(send, msg, { error: reason, stop_details: apiErr.stop_details });
                    return done(new Error(reason));
                }

                const claudeMeta = {
                    model: apiResult.model, usage: apiResult.usage,
                    duration_ms: Date.now() - startTime, cache_size: entries.length,
                    stop_reason: apiResult.stop_reason
                };

                let parsed;
                try {
                    parsed = parseSpecResponse(apiResult.text);
                } catch (parseErr) {
                    const hasText = apiResult.content.some(b => b.type === 'text' && b.text);
                    const truncated = apiResult.stop_reason === 'max_tokens';
                    let reason = parseErr.message;
                    if (truncated && !hasText) reason = `truncated at max_tokens (${apiResult.usage.output_tokens} output tokens, no answer text) — raise Max Tokens`;
                    else if (truncated) reason = `truncated at max_tokens — raise Max Tokens; ${parseErr.message}`;
                    else if (!hasText) reason = `no text in response; ${parseErr.message}`;
                    node.warn(reason);
                    node.status({ fill: 'red', shape: 'ring', text: reason.slice(0, 60) });
                    fail(send, msg, { error: reason, raw: apiResult.text, stop_reason: apiResult.stop_reason }, { _claude: claudeMeta });
                    return done();
                }

                const specs = parsed.dict;
                const topics = Object.keys(specs);

                if (node.specKey && topics.length > 0) {
                    const merged = Object.assign({}, readDict(node, node.specScope, node.specKey));
                    for (const [k, v] of Object.entries(specs)) {
                        merged[k] = (v && typeof v === 'object' && !Array.isArray(v))
                            ? Object.assign({}, v, { _meta: { generated_at: startTime, model: apiResult.model, format: parsed.format } })
                            : v;
                    }
                    writeDict(node, node.specScope, node.specKey, merged);
                }

                send([topics.map(topic => ({ topic, payload: specs[topic], _claude: claudeMeta })), null]);

                const ctxNote = node.specKey ? ` → ${node.specScope}.${node.specKey}` : '';
                node.status({ fill: 'green', shape: 'dot', text: `${topics.length} specs / ${entries.length} entries${ctxNote}` });
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                fail(send, msg, { error: err.message });
                done(err);
            }
        });
    }

    RED.nodes.registerType('dataops-claude', DataOpsClaudeNode);

    // Editor "Load default" button: serve the built-in system prompt.
    RED.httpAdmin.get('/dataops/claude/default-prompt',
        RED.auth.needsPermission('flows.read'),
        function(req, res) { res.json({ prompt: DEFAULT_SYSTEM_PROMPT }); });
};

module.exports.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
module.exports.EXAMPLE_SAMPLES = EXAMPLE_SAMPLES;
module.exports.EXAMPLE_SPECS = EXAMPLE_SPECS;
module.exports.parseSpecResponse = parseSpecResponse;
module.exports.entriesToToon = entriesToToon;
