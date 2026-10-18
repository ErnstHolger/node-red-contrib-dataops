/**
 * dataops-transform — Apply a stored processing instruction to a message.
 *
 * Reads a per-topic spec dictionary from <specScope>.<specKey> (typically
 * populated by dataops-claude), evaluates the spec's JSONata expressions
 * against the incoming msg, coerces the value to the declared type, and emits
 * either (outputFormat):
 *   record — msg.payload = { name, type, timestamp, value, quality }   (default)
 *   value  — msg.payload = value, with msg.topic / timestamp / quality / type
 *
 * The dictionary key IS the canonical name — slashes preserved.
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
 *
 * Without a spec, fallbackMode decides: heuristic | passthrough | error.
 */
'use strict';

const { coerce, inferType } = require('../lib/coerce');
const { sanitizeKey } = require('../lib/ctxkey');
const { readDict } = require('../lib/context');
const { extractValue, getMsgKey } = require('../lib/values');
const jsonata = require('../lib/jsonata');

module.exports = function(RED) {
    function DataOpsTransformNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.specKey      = sanitizeKey(config.specKey) || 'dataopsSpecs';
        node.specScope    = config.specScope || 'global';
        node.keyField     = config.keyField || 'topic';
        node.fallbackMode = ['heuristic', 'passthrough', 'error'].includes(config.fallbackMode) ? config.fallbackMode : 'heuristic';
        // 'record' → msg.payload = {name, type, timestamp, value, quality}
        // 'value'  → msg.payload = value; topic/timestamp/quality/type as msg properties
        node.outputFormat = config.outputFormat === 'value' ? 'value' : 'record';

        // Compiled JSONata cache, invalidated when spec content changes.
        // Map<topic, { sig, value, timestamp, quality }>
        const compiled = new Map();

        function getOrCompile(topic, rawSpec) {
            const sig = JSON.stringify(rawSpec);
            const cached = compiled.get(topic);
            if (cached && cached.sig === sig) return cached;
            const entry = {
                sig,
                value:     jsonata.prepare(RED, node, rawSpec.value),
                timestamp: jsonata.prepare(RED, node, rawSpec.timestamp),
                quality:   jsonata.prepare(RED, node, rawSpec.quality)
            };
            compiled.set(topic, entry);
            return entry;
        }

        async function specTransform(msg, topic, rawSpec) {
            const c = getOrCompile(topic, rawSpec);
            const [rawValue, ts, q] = await Promise.all([
                c.value     ? jsonata.evaluate(RED, c.value, msg)     : msg.payload,
                c.timestamp ? jsonata.evaluate(RED, c.timestamp, msg) : undefined,
                c.quality   ? jsonata.evaluate(RED, c.quality, msg)   : undefined
            ]);
            const declaredType = (typeof rawSpec.type === 'string' && rawSpec.type) ? rawSpec.type : null;
            return {
                name:      String(topic),
                type:      declaredType || inferType(rawValue),
                timestamp: (ts !== undefined && ts !== null) ? ts : Date.now(),
                value:     declaredType ? coerce(rawValue, declaredType) : rawValue,
                quality:   (q !== undefined && q !== null) ? q : true
            };
        }

        function heuristicTransform(msg, topic) {
            const value = extractValue(msg.payload);
            const type = inferType(value);
            return {
                name:      (topic !== undefined && topic !== null) ? String(topic) : '',
                type,
                timestamp: (typeof msg.timestamp === 'number') ? msg.timestamp : Date.now(),
                value:     coerce(value, type),
                quality:   (msg.quality !== undefined) ? msg.quality : true
            };
        }

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                const topic = getMsgKey(RED, msg, node.keyField);
                const specs = readDict(node, node.specScope, node.specKey);
                const rawSpec = (topic !== undefined && topic !== null) ? specs[topic] : null;
                const hasSpec = rawSpec && typeof rawSpec === 'object' && !Array.isArray(rawSpec);

                let result, mode;
                if (hasSpec) {
                    result = await specTransform(msg, topic, rawSpec);
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

                const outMsg = node.outputFormat === 'value'
                    ? Object.assign({}, msg, {
                        topic: result.name || msg.topic, payload: result.value,
                        timestamp: result.timestamp, quality: result.quality, type: result.type, _spec: mode
                    })
                    : Object.assign({}, msg, { payload: result, _spec: mode });
                send([outMsg, null]);
                node.status({ fill: mode === 'spec' ? 'green' : 'yellow', shape: 'dot', text: `${mode}: ${topic}` });
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

        node.on('close', function(done) { compiled.clear(); done(); });

        node.status({ fill: 'green', shape: 'dot', text: 'ready' });
    }

    RED.nodes.registerType('dataops-transform', DataOpsTransformNode);
};
