/**
 * dataops-split — Explode a wide message into N narrow normalized records.
 *
 * Input: msg with a wide payload, e.g.
 *   { topic: "plant/HWS/Denis", payload: { T: 25.4, H: 60.2, P: 1013, alarmActive: false } }
 *
 * Configuration:
 *   topicFilter  — MQTT-style filter (+, #), empty = all
 *   fields       — JSON array: [{name, type, path?}]; path defaults to name
 *   timestampExpr — JSONata, e.g. "payload.ts" or "$millis()"; empty → msg.timestamp || Date.now()
 *   qualityExpr   — JSONata, e.g. "payload.statusCode = 0" or "true"; empty → msg.quality || true
 *
 * Output (output 1, one msg per field):
 *   { topic: "<input-topic>/<name>",
 *     payload: { name, type, timestamp, value, quality } }
 *
 * Non-matching messages: dropped, or forwarded to output 2 if passthroughNonMatch.
 */
'use strict';

const { coerce, inferType } = require('../lib/coerce');

module.exports = function(RED) {

    function topicMatches(topic, filter) {
        if (!filter) return true;
        if (filter === '#') return true;
        if (filter === topic) return true;
        const fParts = filter.split('/');
        const tParts = (topic || '').split('/');
        for (let i = 0; i < fParts.length; i++) {
            if (fParts[i] === '#') return true;
            if (i >= tParts.length) return false;
            if (fParts[i] === '+') continue;
            if (fParts[i] !== tParts[i]) return false;
        }
        return fParts.length === tParts.length;
    }

    function getPath(obj, dotPath) {
        if (!dotPath) return obj;
        if (obj === null || obj === undefined) return undefined;
        const parts = dotPath.split('.');
        let cur = obj;
        for (const p of parts) {
            if (cur === null || cur === undefined) return undefined;
            cur = cur[p];
        }
        return cur;
    }

    function parseFieldsConfig(raw) {
        let arr = raw;
        if (typeof arr === 'string' && arr.trim()) {
            try { arr = JSON.parse(arr); } catch (_) { return []; }
        }
        if (!Array.isArray(arr)) return [];
        return arr
            .filter(f => f && typeof f === 'object' && f.name)
            .map(f => ({
                name: String(f.name),
                type: f.type ? String(f.type) : null,
                path: f.path ? String(f.path) : String(f.name)
            }));
    }

    function DataOpsSplitNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.topicFilter         = config.topicFilter || '';
        node.fields              = parseFieldsConfig(config.fields);
        node.timestampExpr       = config.timestampExpr || '';
        node.qualityExpr         = config.qualityExpr || '';
        node.passthroughNonMatch = !!config.passthroughNonMatch;

        let preparedTs = null;
        let preparedQ  = null;
        try { if (node.timestampExpr) preparedTs = RED.util.prepareJSONataExpression(node.timestampExpr, node); }
        catch (e) { node.warn(`timestamp expression: ${e.message}`); }
        try { if (node.qualityExpr) preparedQ = RED.util.prepareJSONataExpression(node.qualityExpr, node); }
        catch (e) { node.warn(`quality expression: ${e.message}`); }

        function evalOr(prepared, msg, fallback) {
            return new Promise((resolve) => {
                if (!prepared) return resolve(fallback);
                RED.util.evaluateJSONataExpression(prepared, msg, (err, result) => {
                    if (err || result === undefined || result === null) resolve(fallback);
                    else resolve(result);
                });
            });
        }

        node.on('input', async function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                if (!topicMatches(msg.topic, node.topicFilter)) {
                    if (node.passthroughNonMatch) send([null, msg]);
                    return done();
                }
                if (node.fields.length === 0) {
                    node.status({ fill: 'yellow', shape: 'ring', text: 'no fields configured' });
                    send([null, msg]);
                    return done();
                }

                const tsFallback   = (typeof msg.timestamp === 'number') ? msg.timestamp : Date.now();
                const qualFallback = (msg.quality !== undefined) ? msg.quality : true;
                const [ts, qual] = await Promise.all([
                    evalOr(preparedTs, msg, tsFallback),
                    evalOr(preparedQ,  msg, qualFallback)
                ]);

                const out = [];
                for (const f of node.fields) {
                    const raw = getPath(msg.payload, f.path);
                    const value = f.type ? coerce(raw, f.type) : raw;
                    const type  = f.type || inferType(raw);
                    const outTopic = msg.topic ? `${msg.topic}/${f.name}` : f.name;
                    out.push({
                        topic: outTopic,
                        payload: {
                            name:      f.name,
                            type:      type,
                            timestamp: ts,
                            value:     value,
                            quality:   qual
                        },
                        _split: { from: msg.topic || null, field: f.name }
                    });
                }
                send([out, null]);
                node.status({
                    fill: 'green', shape: 'dot',
                    text: `${out.length} → ${msg.topic || ''}/*`
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

        node.status({ fill: 'green', shape: 'dot', text: `${node.fields.length} fields` });
    }

    RED.nodes.registerType('dataops-split', DataOpsSplitNode);
};
