/**
 * dataops-transform — Apply a stored processing instruction to a message.
 *
 * Reads a per-topic spec dictionary from a Node-RED context store
 * (typically populated by dataops-claude), evaluates the JSONata
 * expressions in the spec against the incoming msg, coerces the value
 * to the declared type, and emits a normalized record with payload =
 * { name, type, timestamp, value, quality }.
 *
 * The topic key in the spec dictionary IS the canonical name — no
 * separate name field is stored. Slashes are preserved.
 *
 * Spec dictionary shape:
 *   {
 *     "<topic>": {
 *       "type":      "<number|integer|string|boolean|object>",
 *       "value":     "<jsonata expression>",
 *       "timestamp": "<jsonata expression>",
 *       "quality":   "<jsonata expression>"
 *     },
 *     ...
 *   }
 */
'use strict';

const { coerce, inferType } = require('../lib/coerce');

module.exports = function(RED) {
    function DataOpsTransformNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.specKey      = config.specKey      || 'dataopsSpecs';
        node.specScope    = config.specScope    || 'global';
        node.keyField     = config.keyField     || 'topic';
        node.fallbackMode = config.fallbackMode || 'heuristic';

        // Compiled JSONata cache, invalidated when spec content changes.
        // Map<topic, { sig, value, timestamp, quality }>
        const compiled = new Map();

        function prepare(expr) {
            if (expr === undefined || expr === null || expr === '') return null;
            const exprStr = typeof expr === 'string' ? expr : JSON.stringify(expr);
            return RED.util.prepareJSONataExpression(exprStr, node);
        }

        function evalExpr(prepared, msg) {
            return new Promise((resolve, reject) => {
                RED.util.evaluateJSONataExpression(prepared, msg, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
        }

        function readSpecs() {
            const ctx = node.context()[node.specScope];
            if (!ctx) return {};
            const dict = ctx.get(node.specKey);
            return (dict && typeof dict === 'object' && !Array.isArray(dict)) ? dict : {};
        }

        function getOrCompile(topic, rawSpec) {
            const sig = JSON.stringify(rawSpec);
            const cached = compiled.get(topic);
            if (cached && cached.sig === sig) return cached;
            const entry = {
                sig:       sig,
                value:     prepare(rawSpec.value),
                timestamp: prepare(rawSpec.timestamp),
                quality:   prepare(rawSpec.quality)
            };
            compiled.set(topic, entry);
            return entry;
        }

        function heuristicTransform(msg, topic) {
            const p = msg.payload;
            let value = p;
            if (p !== null && p !== undefined && typeof p === 'object' && !Array.isArray(p)) {
                if (p.value !== undefined && p.value !== null && typeof p.value === 'object' && 'value' in p.value) {
                    value = p.value.value;             // OPC UA Variant
                } else if ('value' in p) {
                    value = p.value;                   // Kepware / generic
                } else if ('v' in p) {
                    value = p.v;                       // Sparkplug / compact
                }
            }
            return {
                name:      (topic !== undefined && topic !== null) ? String(topic) : '',
                type:      inferType(value),
                timestamp: (typeof msg.timestamp === 'number') ? msg.timestamp : Date.now(),
                value:     value,
                quality:   (msg.quality !== undefined) ? msg.quality : true
            };
        }

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                const topic = RED.util.getMessageProperty(msg, node.keyField);
                const specs = readSpecs();
                const rawSpec = (topic !== undefined && topic !== null) ? specs[topic] : null;

                let result;
                let mode;

                if (rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec)) {
                    const c = getOrCompile(topic, rawSpec);
                    const [rawValue, ts, q] = await Promise.all([
                        c.value     ? evalExpr(c.value, msg)     : Promise.resolve(msg.payload),
                        c.timestamp ? evalExpr(c.timestamp, msg) : Promise.resolve(Date.now()),
                        c.quality   ? evalExpr(c.quality, msg)   : Promise.resolve(true)
                    ]);
                    const timestamp = (ts !== undefined && ts !== null) ? ts : Date.now();
                    const quality   = (q  !== undefined && q  !== null) ? q  : true;
                    const declaredType = (typeof rawSpec.type === 'string' && rawSpec.type) ? rawSpec.type : null;
                    const value = declaredType ? coerce(rawValue, declaredType) : rawValue;
                    const type  = declaredType || inferType(rawValue);
                    result = {
                        name: String(topic),
                        type: type,
                        timestamp: timestamp,
                        value: value,
                        quality: quality
                    };
                    mode = 'spec';
                } else if (node.fallbackMode === 'heuristic') {
                    result = heuristicTransform(msg, topic);
                    mode = 'heuristic';
                } else if (node.fallbackMode === 'passthrough') {
                    node.status({ fill: 'yellow', shape: 'ring', text: `no spec: ${topic}` });
                    send([null, msg]);
                    return done();
                } else {
                    throw new Error(`No spec for topic '${topic}'`);
                }

                const out = Object.assign({}, msg, { payload: result, _spec: mode });
                send([out, null]);
                node.status({
                    fill:  (mode === 'spec') ? 'green' : 'yellow',
                    shape: 'dot',
                    text:  `${mode}: ${topic}`
                });
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, Object.assign({}, msg, {
                    payload: { error: err.message, original: msg.payload },
                    _error: true
                })]);
                done(err);
            }
        });

        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
    }

    RED.nodes.registerType('dataops-transform', DataOpsTransformNode);
};
