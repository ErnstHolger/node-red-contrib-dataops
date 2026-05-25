/**
 * dataops-combine — Collect narrow normalized records, emit a flat wide dict.
 *
 * Input (expected): msg.payload = { name, type, timestamp, value, quality }
 * (the canonical record shape produced by dataops-transform or dataops-split).
 *
 * Internal buffer: Map<name, latest-record>.
 *
 * Trigger modes:
 *   event    — emit on every input (always-current snapshot)
 *   interval — emit every intervalMs (the latest snapshot)
 *   quorum   — emit when ALL expectedNames have appeared, then reset the buffer
 *
 * Output (output 1):
 *   { topic: outputTopic, payload: { <name1>: v1, <name2>: v2, ..., <tsField>: latestTs } }
 *
 * Quality fields can optionally be included as <name>_q if includeQuality is set.
 */
'use strict';

module.exports = function(RED) {

    function parseNamesList(raw) {
        if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
        if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
        return [];
    }

    function DataOpsCombineNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.expectedNames  = parseNamesList(config.expectedNames);
        node.triggerMode    = config.triggerMode || 'event';
        node.intervalMs     = parseInt(config.intervalMs) || 1000;
        node.outputTopic    = config.outputTopic || 'dataops/combined';
        node.tsField        = config.tsField || 'ts';
        node.includeQuality = !!config.includeQuality;

        // Buffer: Map<name, {value, type, timestamp, quality}>
        const buffer = new Map();
        let intervalTimer = null;

        function buildSnapshot() {
            const out = {};
            let latestTs = 0;
            for (const [name, rec] of buffer) {
                out[name] = rec.value;
                if (typeof rec.timestamp === 'number' && rec.timestamp > latestTs) latestTs = rec.timestamp;
                if (node.includeQuality) out[`${name}_q`] = rec.quality;
            }
            if (latestTs > 0) out[node.tsField] = latestTs;
            return out;
        }

        function emit(reason) {
            if (buffer.size === 0) return;
            const snapshot = buildSnapshot();
            const outMsg = {
                topic: node.outputTopic,
                payload: snapshot,
                _names: Array.from(buffer.keys()),
                _trigger: reason
            };
            try {
                node.send([outMsg, null]);
            } catch (err) {
                RED.log.error(`[dataops-combine] send: ${err.message}`);
            }
        }

        function quorumReady() {
            if (node.expectedNames.length === 0) return false;
            for (const n of node.expectedNames) {
                if (!buffer.has(n)) return false;
            }
            return true;
        }

        function updateStatus() {
            let text;
            if (node.triggerMode === 'quorum' && node.expectedNames.length > 0) {
                text = `${buffer.size}/${node.expectedNames.length} (${node.triggerMode})`;
            } else {
                text = `${buffer.size} names (${node.triggerMode})`;
            }
            node.status({ fill: 'green', shape: 'dot', text });
        }

        // Start interval timer once at construction
        if (node.triggerMode === 'interval' && node.intervalMs > 0) {
            intervalTimer = setInterval(() => emit('interval'), node.intervalMs);
        }

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                // Cmd-style trigger: msg.cmd === 'emit' forces an emit regardless of mode
                if (msg && msg.cmd === 'emit') {
                    emit('cmd');
                    updateStatus();
                    return done();
                }

                const p = msg && msg.payload;
                if (!p || typeof p !== 'object' || !p.name) {
                    send([null, Object.assign({}, msg, {
                        payload: { error: 'input payload missing required "name" field', original: p },
                        _error: true
                    })]);
                    return done();
                }

                buffer.set(String(p.name), {
                    value:     p.value,
                    type:      p.type || null,
                    timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
                    quality:   p.quality !== undefined ? p.quality : true
                });

                updateStatus();

                if (node.triggerMode === 'event') {
                    emit('event');
                } else if (node.triggerMode === 'quorum') {
                    if (quorumReady()) {
                        emit('quorum');
                        buffer.clear();
                        updateStatus();
                    }
                }
                // interval mode handled by timer
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, Object.assign({}, msg, {
                    payload: { error: err.message }, _error: true
                })]);
                done(err);
            }
        });

        node.on('close', function(done) {
            if (intervalTimer) {
                clearInterval(intervalTimer);
                intervalTimer = null;
            }
            buffer.clear();
            done();
        });

        updateStatus();
    }

    RED.nodes.registerType('dataops-combine', DataOpsCombineNode);
};
