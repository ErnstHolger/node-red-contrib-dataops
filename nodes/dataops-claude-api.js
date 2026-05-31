/**
 * dataops-claude-api — Config node storing Anthropic API settings.
 *
 * Also hosts the "DataOps AI" sidebar's admin HTTP endpoints:
 *   GET  /dataops/claude/configs        — list available API config nodes
 *   POST /dataops/claude/generate-flow  — describe → Claude → importable flow JSON
 */
'use strict';

const { callAnthropicAPI } = require('../lib/anthropic');

// System prompt teaching Claude to emit flows using ONLY this package's nodes.
const FLOW_SYSTEM_PROMPT = [
    '# Role',
    'You generate Node-RED flows (a JSON array of node objects) that build data pipelines using the node-red-contrib-dataops package. Output ONLY valid Node-RED flow JSON — an array — with no prose and no markdown fences.',
    '',
    '# Available node types (use ONLY these, plus core "inject" and "debug")',
    '',
    '## dataops-in',
    'Writes incoming msg.payload into a context dictionary at <specScope>.<specKey>, keyed by Key Field.',
    'Fields: name, specScope ("global"|"flow"), specKey (string), keyField (default "topic"), maxEntries (number, 0=unbounded), ttl (number ms, 0=none).',
    '',
    '## dataops-combine',
    'Buffers narrow {name,type,timestamp,value,quality} records and emits a wide flat dict. 2 outputs [combined, error].',
    'Fields: name, triggerMode ("event"|"interval"|"quorum"), intervalMs (number), expectedNames (comma string), outputTopic, tsField (default "ts"), includeQuality (bool).',
    '',
    '## dataops-split',
    'Explodes a wide payload into N narrow canonical records. 2 outputs [records, error].',
    'Fields: name, autoDetect (bool), fields (JSON array of {name,type,path}), topicFilter, tsExpr (JSONata), qualityExpr (JSONata).',
    '',
    '## dataops-transform',
    'Applies per-topic JSONata specs to normalize messages. 2 outputs [transformed, error].',
    'Fields: name, specScope ("global"|"flow"), specKey (default "dataopsSpecs"), keyField (default "topic"), fallbackMode ("heuristic"|"passthrough"|"error").',
    '',
    '## dataops-claude',
    'Reads source samples from <sourceScope>.<sourceKey>, asks Claude for specs, writes to <specScope>.<specKey>. Needs an apiConfig. 2 outputs [result, error].',
    'Fields: name, apiConfig (config node id), systemPrompt, sourceScope, sourceKey, specScope, specKey, maxSampleRows (number).',
    '',
    '## dataops-cron',
    'Cron-style timer trigger (6 fields: sec min hour dom mon dow). No inputs, 2 outputs [tick, error].',
    'Fields: name, cronExpr (e.g. "0 * * * * *"), payloadType ("timestamp"|"date"|"str"|"num"|"bool"|"json"), payloadValue, outputTopic.',
    '',
    '# Output rules',
    '- Return a JSON array of node objects only.',
    '- Each node needs: a unique string "id", a "type", "x" and "y" coordinates (space nodes ~180px apart horizontally), and "wires" (array of arrays of target node ids).',
    '- Wire nodes left-to-right to form the described pipeline. inject/cron feed dataops-in; dataops-* nodes chain; end in a debug node.',
    '- For any dataops-claude node, set "apiConfig" to the exact placeholder string "__API_CONFIG_ID__" (the server substitutes the real id).',
    '- Do NOT emit config nodes (dataops-claude-api) — only flow nodes.',
    '- Give every node a short human "name".',
    '- Output the array and nothing else.'
].join('\n');

module.exports = function(RED) {

    function DataOpsClaudeApiConfigNode(config) {
        RED.nodes.createNode(this, config);

        this.name = config.name || '';
        this.model = config.model || 'claude-sonnet-4-6';
        this.baseUrl = (config.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
        this.maxTokens = parseInt(config.maxTokens) || 16384;
        this.temperature = parseFloat(config.temperature);
        if (isNaN(this.temperature)) this.temperature = 0.7;
    }

    RED.nodes.registerType('dataops-claude-api', DataOpsClaudeApiConfigNode, {
        credentials: {
            apiKey: { type: 'password' }
        }
    });

    // ---- Sidebar admin endpoints (registered once per module load) ----

    // List available dataops-claude-api config nodes for the picker.
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

    // Describe a pipeline → Claude → importable flow JSON.
    RED.httpAdmin.post('/dataops/claude/generate-flow',
        RED.auth.needsPermission('flows.write'),
        function(req, res) {
            const { configId, description } = req.body || {};
            if (!description || !String(description).trim()) {
                return res.status(400).json({ error: 'description is required' });
            }
            const configNode = RED.nodes.getNode(configId);
            if (!configNode) {
                return res.status(400).json({ error: 'API config node not found (deploy it first)' });
            }
            const apiKey = configNode.credentials && configNode.credentials.apiKey;
            if (!apiKey) {
                return res.status(400).json({ error: 'API key not set on the selected config node' });
            }

            callAnthropicAPI({
                apiKey,
                baseUrl: configNode.baseUrl,
                model: configNode.model,
                maxTokens: configNode.maxTokens,
                temperature: configNode.temperature,
                systemPrompt: FLOW_SYSTEM_PROMPT,
                userPrompt: `Build a Node-RED flow for: ${description}`
            }).then(function(result) {
                const flow = parseFlowJson(result.text);
                if (!flow) {
                    return res.status(502).json({
                        error: 'Claude did not return valid flow JSON',
                        raw: result.text
                    });
                }
                // Substitute the chosen API config id into any dataops-claude nodes.
                for (const node of flow) {
                    if (node && node.apiConfig === '__API_CONFIG_ID__') node.apiConfig = configId;
                }
                res.json({ flow, usage: result.usage, model: result.model });
            }).catch(function(err) {
                res.status(502).json({ error: err.message });
            });
        });

    // Tolerant parse: accept a bare array or a ```-fenced array.
    function parseFlowJson(text) {
        let s = String(text).trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fence) s = fence[1].trim();
        try {
            const obj = JSON.parse(s);
            return Array.isArray(obj) ? obj : null;
        } catch (_) {
            return null;
        }
    }
};
