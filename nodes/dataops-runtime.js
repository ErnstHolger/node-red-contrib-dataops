/**
 * dataops-runtime — Sampled rows with runtime tracking while a trigger tag is active.
 *
 * On any incoming message (e.g. from dataops-cron), reads the dictionary at
 * <specScope>.<specKey> (written by dataops-in, either store mode):
 *
 *   1. trigger = isTruthy(value of dict[triggerKey])
 *   2. on a false→true transition, the rising-edge time is recorded
 *   3. while true, emit a row once `sampling` seconds have passed since the
 *      rising edge, then at most once per `sampling` seconds
 *      (sampling = 0 → every input)
 *
 * Row: { timestamp, runtime: <seconds since rising edge>, label: <dict[labelKey]>, <alias>: value, ... }
 * sent as msg.payload = [row] with msg._runtime = { runtime, startedAt }.
 *
 * Trigger/label keys are dictionary entry keys (topics) and are used verbatim.
 * Timestamps come from the trigger message (msg._epoch / msg.timestamp) when present.
 * Edge state is held in memory and resets on redeploy.
 *
 * 2 outputs [row, error].
 */
'use strict';

const { sanitizeKey } = require('../lib/ctxkey');
const { readDict, registerKeysEndpoint } = require('../lib/context');
const { parseFields, entryValue, isTruthy, triggerDate, formatTs } = require('../lib/values');

module.exports = function(RED) {

    function DataOpsRuntimeNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.specScope   = config.specScope || 'global';
        node.specKey     = sanitizeKey(config.specKey);
        node.triggerKey  = (config.triggerKey || '').trim();
        node.labelKey    = (config.labelKey || '').trim();
        node.fields      = parseFields(config.fields, config.keys);
        node.sampling    = Math.max(0, Number(config.sampling) || 0);
        node.tsFormat    = config.tsFormat === 'epoch' ? 'epoch' : 'iso';
        node.outputTopic = config.outputTopic || '';

        let risingEdge = null; // Date of the last false→true transition
        let lastEmit = null;   // Date of the last emitted row in this run
        let active = false;

        function setReady() {
            if (!node.specKey) node.status({ fill: 'yellow', shape: 'ring', text: 'no spec key' });
            else if (!node.triggerKey) node.status({ fill: 'yellow', shape: 'ring', text: 'no trigger key' });
            else node.status({ fill: 'green', shape: 'ring', text: `idle (${node.fields.length} fields, ${node.sampling}s)` });
        }
        setReady();

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                if (!node.specKey)    throw new Error('No Spec Key configured');
                if (!node.triggerKey) throw new Error('No Trigger Key configured');

                const dict = readDict(node, node.specScope, node.specKey);
                const now = triggerDate(msg);
                const on = isTruthy(entryValue(dict[node.triggerKey]));

                if (!on) {
                    if (active) setReady();
                    active = false;
                    risingEdge = null;
                    lastEmit = null;
                    return done();
                }
                if (!active) {
                    active = true;
                    risingEdge = now;
                    lastEmit = null;
                }

                const since = (lastEmit || risingEdge).getTime();
                if (now.getTime() - since < node.sampling * 1000) {
                    node.status({ fill: 'blue', shape: 'dot', text: `running ${Math.round((now - risingEdge) / 1000)}s` });
                    return done();
                }
                lastEmit = now;

                const runtime = (now.getTime() - risingEdge.getTime()) / 1000;
                const row = {
                    timestamp: formatTs(now, node.tsFormat),
                    runtime,
                    label: node.labelKey ? entryValue(dict[node.labelKey]) : null
                };
                for (const f of node.fields) row[f.alias] = entryValue(dict[f.topic]);

                const outMsg = Object.assign({}, msg, {
                    payload: [row],
                    _runtime: { runtime, startedAt: risingEdge.toISOString() }
                });
                if (node.outputTopic) outMsg.topic = node.outputTopic;

                send([outMsg, null]);
                node.status({ fill: 'green', shape: 'dot', text: `emitted @ ${now.toTimeString().slice(0, 8)} (${Math.round(runtime)}s)` });
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, Object.assign({}, msg, { payload: { error: err.message }, _error: true })]);
                done(err);
            }
        });
    }

    RED.nodes.registerType('dataops-runtime', DataOpsRuntimeNode);
    registerKeysEndpoint(RED);
};
