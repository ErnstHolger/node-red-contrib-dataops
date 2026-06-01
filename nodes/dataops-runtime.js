/**
 * dataops-runtime — Build a sampled data table from a context dictionary with trigger and runtime tracking.
 *
 * On any incoming message, reads the dictionary at <specScope>.<specKey> and checks if:
 * 1. dict[triggerKey] is truthy
 * 2. (now >= last_true_time + sampling_seconds)
 *
 * If both conditions are met, emits a row with:
 * - timestamp: trigger time (ISO or epoch)
 * - runtime: seconds elapsed since last true transition
 * - label: value from dict[labelKey]
 * - other fields: selected data fields from the dictionary
 *
 * Pass-through trigger: fires on every input. 2 outputs [table, error].
 */
'use strict';

const { sanitizeKey } = require('../lib/ctxkey');
const { inferType } = require('../lib/coerce');

module.exports = function(RED) {

    function parseFields(fieldsRaw, legacyKeys) {
        let arr = fieldsRaw;
        if (typeof arr === 'string' && arr.trim()) {
            try { arr = JSON.parse(arr); } catch (_) { arr = null; }
        }
        if (Array.isArray(arr)) {
            return arr
                .filter(f => f && (typeof f === 'object') && f.topic)
                .map(f => ({ topic: String(f.topic), alias: f.alias ? String(f.alias) : String(f.topic) }));
        }
        return [];
    }

    function extractValue(payload) {
        if (payload === null || payload === undefined) return null;
        if (typeof payload !== 'object') return payload;
        if (payload.value && typeof payload.value === 'object' && 'value' in payload.value) {
            return payload.value.value;
        }
        if ('value' in payload) return payload.value;
        if ('v' in payload) return payload.v;
        return payload;
    }

    function isTruthy(val) {
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val !== 0;
        if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
        return !!val;
    }

    function DataOpsRuntimeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.specScope       = config.specScope || 'global';
        node.specKey         = sanitizeKey(config.specKey);
        node.triggerKey      = sanitizeKey(config.triggerKey);
        node.labelKey        = sanitizeKey(config.labelKey);
        node.fields          = parseFields(config.fields, config.keys);
        node.sampling        = Math.max(0, Number(config.sampling) || 0);
        node.tsFormat        = config.tsFormat || 'iso';
        node.outputTopic     = config.outputTopic || '';

        let lastTrueTime = null;
        let lastTriggerState = false;

        function status() {
            if (!node.specKey) { node.status({ fill: 'yellow', shape: 'ring', text: 'no spec key' }); return; }
            if (!node.triggerKey) { node.status({ fill: 'yellow', shape: 'ring', text: 'no trigger key' }); return; }
            if (node.fields.length === 0) { node.status({ fill: 'yellow', shape: 'ring', text: 'no fields' }); return; }
            node.status({ fill: 'green', shape: 'dot', text: `${node.fields.length} fields, ${node.sampling}s sample` });
        }
        status();

        function readDict() {
            const ctx = node.context()[node.specScope] || node.context().global;
            const d = ctx.get(node.specKey);
            return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
        }

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                if (!node.specKey) throw new Error('No Spec Key configured');
                if (!node.triggerKey) throw new Error('No Trigger Key configured');
                if (node.fields.length === 0) throw new Error('No fields configured');

                const dict = readDict();
                const now = new Date();
                const triggerValue = dict[node.triggerKey];
                const currentState = isTruthy(triggerValue);

                // Detect false-to-true transition
                if (currentState && !lastTriggerState) {
                    lastTrueTime = now;
                }
                lastTriggerState = currentState;

                // Check if we should emit: trigger is true AND sampling interval has passed
                let shouldEmit = false;
                if (currentState && lastTrueTime !== null) {
                    const elapsedMs = now.getTime() - lastTrueTime.getTime();
                    const elapsedSec = elapsedMs / 1000;
                    shouldEmit = elapsedSec >= node.sampling;
                }

                if (!shouldEmit) {
                    send([null, null]);
                    done();
                    return;
                }

                // Build the row with timestamp, runtime, label, and data fields
                const runtimeSec = (now.getTime() - lastTrueTime.getTime()) / 1000;
                const ts = node.tsFormat === 'epoch' ? now.getTime() : now.toISOString();
                const labelValue = extractValue(dict[node.labelKey]);

                const row = {
                    timestamp: ts,
                    runtime: runtimeSec,
                    label: labelValue
                };

                // Add the configured fields
                node.fields.forEach(f => {
                    const entry = dict[f.topic];
                    let value = null;
                    if (entry !== undefined && entry !== null) {
                        const src = (entry && typeof entry === 'object' && 'payload' in entry) ? entry.payload : entry;
                        value = extractValue(src);
                    }
                    row[f.alias || f.topic] = value;
                });

                const outMsg = Object.assign({}, msg, {
                    payload: [row],
                    _runtime: { runtime: runtimeSec, lastTrueTime: lastTrueTime.toISOString() }
                });
                if (node.outputTopic) outMsg.topic = node.outputTopic;

                send([outMsg, null]);
                node.status({ fill: 'green', shape: 'dot', text: `emitted @ ${now.toTimeString().slice(0, 8)}` });
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, Object.assign({}, msg, { payload: { error: err.message }, _error: true })]);
                done(err);
            }
        });

        node.on('close', function(done) { done(); });
    }

    RED.nodes.registerType('dataops-runtime', DataOpsRuntimeNode);

    // ---- Picker endpoint: list the top-level keys of <scope>.<specKey> ----
    RED.httpAdmin.get('/dataops/runtime/keys',
        RED.auth.needsPermission('flows.read'),
        function(req, res) {
            const scope = req.query.scope === 'flow' ? 'flow' : 'global';
            const key = sanitizeKey(req.query.key);
            const z = req.query.z;
            if (!key) return res.json({ keys: [] });

            try {
                let ctx;
                if (scope === 'global') {
                    let anyNode = null;
                    RED.nodes.eachNode(function(n) { if (!anyNode && n.z) anyNode = RED.nodes.getNode(n.id); });
                    ctx = anyNode ? anyNode.context().global : null;
                } else {
                    let flowNode = null;
                    RED.nodes.eachNode(function(n) {
                        if (!flowNode && n.z === z) { const ln = RED.nodes.getNode(n.id); if (ln) flowNode = ln; }
                    });
                    ctx = flowNode ? flowNode.context().flow : null;
                }
                if (!ctx) return res.json({ keys: [], note: 'context not available (deploy the flow and ensure data has arrived)' });

                const dict = ctx.get(key);
                if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
                    return res.json({ keys: [], note: 'no dictionary found at this scope/key yet' });
                }
                res.json({ keys: Object.keys(dict) });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
};
