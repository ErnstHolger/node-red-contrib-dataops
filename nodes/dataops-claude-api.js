/**
 * dataops-claude-api — Config node storing Claude API settings.
 *
 * Exposes `complete({systemPrompt, userPrompt})` to dataops-claude and the
 * DataOps AI sidebar, so request construction lives in one place (lib/anthropic).
 *
 * Also hosts the "DataOps AI" sidebar's admin HTTP endpoints:
 *   GET  /dataops/claude/configs        — list available API config nodes
 *   POST /dataops/claude/generate-flow  — describe → Claude → importable flow JSON
 */
'use strict';

const anthropic = require('../lib/anthropic');

const API_CONFIG_PLACEHOLDER = '__API_CONFIG_ID__';

// System prompt teaching Claude to emit flows using ONLY this package's nodes.
// Keep in sync with each node's `defaults` in nodes/*.html.
const FLOW_SYSTEM_PROMPT = [
    '# Role',
    'You generate Node-RED flows (a JSON array of node objects) that build data pipelines using the node-red-contrib-dataops package. Output ONLY valid Node-RED flow JSON — an array — with no prose and no markdown fences.',
    '',
    '# Concepts',
    '- Nodes share data through context dictionaries at <scope>.<specKey> (scope "global" or "flow"). Use the same specKey on the writer and its readers.',
    '- dataops-transform normalizes device messages. outputFormat "record" emits msg.payload = {name, type, timestamp, value, quality}; "value" emits msg.payload = value with msg.topic/timestamp/quality/type.',
    '- To merge or explode messages, use the core "join" and "split" nodes.',
    '',
    '# Available node types (use ONLY these, plus core "inject", "debug", "change", "function", "join" and "split")',
    'Output counts matter: "wires" must have exactly one array per output.',
    '',
    '## dataops-in  (1 input, 1 output: pass-through)',
    'Writes msg.payload into the cache dictionary <specScope>.<specKey>, keyed by msg[keyField].',
    'Fields: name, specScope ("global"|"flow"), specKey (string, required), keyField (default "topic"), storeMode ("wrapped" = {payload,ts,metadata,previous}, use as dataops-claude source | "flat" = payload as-is, use for dataops-runtime), maxEntries (number, 0 = unbounded), ttl (number ms, 0 = none; wrapped only).',
    '',
    '## dataops-transform  (1 input, 2 outputs: [records, error])',
    'Normalizes each message using per-topic JSONata specs from <specScope>.<specKey>.',
    'Fields: name, specScope, specKey (default "dataopsSpecs"), keyField (default "topic"), fallbackMode ("heuristic" | "passthrough" | "error"), outputFormat ("record" | "value").',
    '',
    '## dataops-cron  (0 inputs, 2 outputs: [tick, error])',
    'Cron trigger with 6 fields: sec min hour dom mon dow (e.g. "*/10 * * * * *" = every 10 s). Use it to drive dataops-runtime and dataops-claude.',
    'Fields: name, cronExpr, payloadType ("timestamp" | "date" | "str" | "num" | "bool" | "json"), payloadValue, outputTopic.',
    '',
    '## dataops-runtime  (1 input, 2 outputs: [row, error])',
    'While dict[triggerKey] is true, emits at most one row per `sampling` seconds with the runtime since the trigger went true, a label and selected fields.',
    'Fields: name, specScope, specKey, triggerKey (topic in the dict), labelKey (topic in the dict), fields (JSON STRING of [{"topic","alias"}]), sampling (seconds), tsFormat ("iso" | "epoch"), outputTopic.',
    '',
    '## dataops-claude  (1 input, 2 outputs: [specs, error])',
    'Reads samples from <sourceScope>.<sourceKey> (a wrapped dataops-in cache), asks Claude for per-topic specs, merges them into <specScope>.<specKey> for dataops-transform.',
    `Fields: name, apiConfig (always the placeholder string "${API_CONFIG_PLACEHOLDER}"), systemPrompt ("" = built-in), sourceScope, sourceKey, specScope, specKey (default "dataopsSpecs"), maxSampleRows (number).`,
    '',
    '# Output rules',
    '- Return a JSON array of node objects only.',
    '- Each node needs: a unique string "id", a "type", "x" and "y" coordinates (space nodes ~180px apart horizontally), and "wires" (array of arrays of target node ids, one array per output).',
    '- Wire nodes left-to-right to form the described pipeline; end each branch in a debug node.',
    '- Do NOT emit config nodes (dataops-claude-api) or tab nodes — only flow nodes.',
    '- Give every node a short human "name".',
    '- Output the array and nothing else.'
].join('\n');

module.exports = function(RED) {

    function DataOpsClaudeApiConfigNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name        = config.name || '';
        node.model       = (config.model || '').trim() || anthropic.DEFAULT_MODEL;
        node.baseUrl     = config.baseUrl || '';
        node.maxTokens   = parseInt(config.maxTokens, 10) || anthropic.DEFAULT_MAX_TOKENS;
        node.temperature = anthropic.parseTemperature(config.temperature);
        node.effort      = anthropic.parseEffort(config.effort);
        // Older configs have no `fallbacks` property → enable only for the Anthropic API;
        // third-party "Anthropic-compatible" gateways may reject the beta parameter.
        node.fallbacks   = config.fallbacks === undefined
            ? anthropic.isAnthropicBaseURL(node.baseUrl)
            : !!config.fallbacks;

        let client = null;
        node.hasApiKey = function() {
            return !!(node.credentials && node.credentials.apiKey);
        };

        /** Send one prompt with this config's settings. See lib/anthropic.complete. */
        node.complete = function(prompt) {
            if (!node.hasApiKey()) return Promise.reject(new Error('API key not configured'));
            if (!client) {
                client = anthropic.createClient({ apiKey: node.credentials.apiKey, baseUrl: node.baseUrl });
            }
            return anthropic.complete(client, {
                model: node.model,
                maxTokens: node.maxTokens,
                temperature: node.temperature,
                effort: node.effort,
                fallbacks: node.fallbacks
            }, prompt);
        };
    }

    RED.nodes.registerType('dataops-claude-api', DataOpsClaudeApiConfigNode, {
        credentials: {
            apiKey: { type: 'password' }
        }
    });

    // ---- Sidebar admin endpoints ----

    RED.httpAdmin.get('/dataops/claude/configs',
        RED.auth.needsPermission('flows.read'),
        function(req, res) {
            const configs = [];
            RED.nodes.eachNode(function(n) {
                if (n.type === 'dataops-claude-api') {
                    configs.push({ id: n.id, name: n.name || '(unnamed)' });
                }
            });
            res.json({ configs });
        });

    RED.httpAdmin.post('/dataops/claude/generate-flow',
        RED.auth.needsPermission('flows.write'),
        function(req, res) {
            const { configId, description } = req.body || {};
            if (!description || !String(description).trim()) {
                return res.status(400).json({ error: 'description is required' });
            }
            const configNode = RED.nodes.getNode(configId);
            if (!configNode || typeof configNode.complete !== 'function') {
                return res.status(400).json({ error: 'API config node not found (deploy it first)' });
            }
            if (!configNode.hasApiKey()) {
                return res.status(400).json({ error: 'API key not set on the selected config node' });
            }

            configNode.complete({
                systemPrompt: FLOW_SYSTEM_PROMPT,
                userPrompt: `Build a Node-RED flow for: ${String(description).trim()}`
            }).then(function(result) {
                const flow = parseFlowJson(result.text, configId);
                if (!flow) {
                    return res.status(502).json({ error: 'Claude did not return valid flow JSON', raw: result.text });
                }
                res.json({ flow, usage: result.usage, model: result.model });
            }).catch(function(err) {
                res.status(502).json({ error: anthropic.describeError(err) });
            });
        });
};

/**
 * Tolerant parse of a generated flow: accepts a bare or ```-fenced array.
 * Keeps only objects with an id and type, drops config/tab nodes, and
 * substitutes the API config id placeholder. Returns null if nothing usable.
 */
function parseFlowJson(text, configId) {
    let s = String(text || '').trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();
    let arr;
    try { arr = JSON.parse(s); } catch (_) { return null; }
    if (!Array.isArray(arr)) return null;
    const flow = arr.filter(n => n && typeof n === 'object'
        && typeof n.id === 'string' && typeof n.type === 'string'
        && n.type !== 'dataops-claude-api' && n.type !== 'tab');
    for (const n of flow) {
        if (n.type === 'dataops-claude') n.apiConfig = configId;
        delete n.z; // let the editor place nodes on the active tab
    }
    return flow.length ? flow : null;
}

module.exports.FLOW_SYSTEM_PROMPT = FLOW_SYSTEM_PROMPT;
module.exports.parseFlowJson = parseFlowJson;
