/**
 * dataops-table — Build a data table from a context dictionary.
 *
 * On ANY incoming message (e.g. from dataops-cron or any node), reads the
 * dictionary at <specScope>.<specKey> (the dict dataops-in writes) and emits a
 * table:
 *
 *   - one row by default: { timestamp: <trigger time>, <key1>: v1, <key2>: v2, ... }
 *   - columns = a configured, ordered key list (plus the timestamp column first)
 *   - each value is the extracted scalar (payload.value.value → .value → .v → payload)
 *   - missing keys → null
 *
 * Output format is configurable:
 *   - "objects" : msg.payload = [ { timestamp, k1, k2, ... } ]
 *   - "table"   : msg.payload = { columns: [...], rows: [ [...] ] }
 *
 * Pass-through trigger: fires on every input. 2 outputs [table, error].
 */
'use strict';

const { sanitizeKey } = require('../lib/ctxkey');
const { inferType, coerce } = require('../lib/coerce');

module.exports = function(RED) {

    function parseKeyList(raw) {
        if (Array.isArray(raw)) return raw.filter(Boolean).map(String);
        if (typeof raw === 'string') return raw.split(',').map(s => s.trim()).filter(Boolean);
        return [];
    }

    // Selected columns as [{topic, alias}]. Prefers the JSON `fields` config;
    // falls back to migrating a legacy comma `keys` string (alias = topic).
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
        // Legacy: comma list of topics, alias = topic.
        return parseKeyList(legacyKeys).map(t => ({ topic: t, alias: t }));
    }

    // Extract a scalar from a stored entry's payload (same heuristic as dataops-transform).
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

    // Map a shape `type` to a node-red-contrib-questdb column type.
    //   integer/int/long/short → long, number/double/float/real → double, boolean → boolean, string/object → string.
    function questdbColType(type) {
        const t = (type || '').toLowerCase();
        if (t === 'integer' || t === 'int' || t === 'long' || t === 'short') return 'long';
        if (t === 'boolean' || t === 'bool') return 'boolean';
        if (t === 'number' || t === 'double' || t === 'float' || t === 'real') return 'double';
        return 'string';
    }
    // Coerce a value to the chosen QuestDB column type (string-encode objects).
    function questdbColValue(value, colType) {
        if (colType === 'long')    return Math.trunc(Number(value));
        if (colType === 'double')  return Number(value);
        if (colType === 'boolean') return (value === true) || value === 'true' || value === 1;
        return (typeof value === 'object') ? JSON.stringify(value) : String(value);
    }

    function DataOpsTableNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.specScope     = config.specScope || 'global';
        node.specKey       = sanitizeKey(config.specKey);
        node.fields        = parseFields(config.fields, config.keys); // [{topic, alias}]
        node.tsFormat      = config.tsFormat || 'iso';      // 'iso' | 'epoch'
        node.outputTopic   = config.outputTopic || '';
        node.questdb       = !!config.questdb;              // format output for node-red-contrib-questdb

        function status() {
            if (!node.specKey) { node.status({ fill: 'yellow', shape: 'ring', text: 'no spec key' }); return; }
            if (node.fields.length === 0) { node.status({ fill: 'yellow', shape: 'ring', text: 'no keys' }); return; }
            node.status({ fill: 'green', shape: 'dot', text: `${node.fields.length} fields` });
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
                if (!node.specKey)            throw new Error('No Spec Key configured');
                if (node.fields.length === 0) throw new Error('No keys configured');

                const dict = readDict();

                // Timestamp from the trigger message when present (e.g. the cron node
                // emits msg.timestamp as ISO and msg._epoch as ms), else fall back to now.
                let triggerDate = null;
                if (typeof msg._epoch === 'number') {
                    triggerDate = new Date(msg._epoch);
                } else if (msg.timestamp !== undefined && msg.timestamp !== null) {
                    const d = new Date(msg.timestamp); // accepts ISO string or epoch number
                    if (!isNaN(d.getTime())) triggerDate = d;
                }
                const now = triggerDate || new Date();
                const ts = node.tsFormat === 'epoch' ? now.getTime() : now.toISOString();

                // One JSON object per configured field: { name, timestamp, value, type }.
                // name = alias (fallback topic). type = stored record's `type` if present, else inferred.
                const rows = node.fields.map(function(f) {
                    const entry = dict[f.topic];
                    let value = null, type = null;
                    if (entry !== undefined && entry !== null) {
                        // Tolerate both shapes: wrapped { payload, ts, ... } and flat (bare record/value).
                        const src = (entry && typeof entry === 'object' && 'payload' in entry) ? entry.payload : entry;
                        value = extractValue(src);
                        const storedType = (src && typeof src === 'object' && typeof src.type === 'string' && src.type) ? src.type : null;
                        type = storedType || inferType(value);
                        // Coerce value to declared type
                        if (type) value = coerce(value, type);
                    }
                    return { name: f.alias || f.topic, timestamp: ts, value: value, type: type };
                });

                let payload = rows;
                let questdbTable = null;
                if (node.questdb) {
                    // Structured payload for node-red-contrib-questdb:
                    //   msg.topic = <table>, msg.payload = { columns: {name:{value,type}}, timestamp: ms }
                    // table = output Topic → msg.topic → node name → 'dataops'.
                    questdbTable = node.outputTopic || msg.topic || node.name || 'dataops';
                    const columns = {};
                    for (const r of rows) {
                        if (r.value === null || r.value === undefined) continue; // omit nulls
                        const colType = questdbColType(r.type);
                        columns[r.name] = { value: questdbColValue(r.value, colType), type: colType };
                    }
                    if (Object.keys(columns).length === 0) throw new Error('QuestDB: no non-null values to write');
                    payload = { columns: columns, timestamp: now.getTime() }; // epoch ms; node converts to µs
                }

                const outMsg = Object.assign({}, msg, {
                    payload: payload,
                    _shape: { rows: rows.length, questdb: node.questdb }
                });
                // In QuestDB mode the table name MUST be on msg.topic (the questdb node reads it).
                if (node.questdb) outMsg.topic = questdbTable;
                else if (node.outputTopic) outMsg.topic = node.outputTopic;

                send([outMsg, null]);
                node.status({ fill: 'green', shape: 'dot', text: `${rows.length} ${node.questdb ? 'QuestDB' : 'row' + (rows.length === 1 ? '' : 's')} @ ${now.toTimeString().slice(0, 8)}` });
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                send([null, Object.assign({}, msg, { payload: { error: err.message }, _error: true })]);
                done(err);
            }
        });

        node.on('close', function(done) { done(); });
    }

    RED.nodes.registerType('dataops-table', DataOpsTableNode);

    // ---- Picker endpoint: list the top-level keys of <scope>.<specKey> ----
    // Query params: scope ("global"|"flow"), key (spec key), z (flow/tab id, for flow scope).
    RED.httpAdmin.get('/dataops/table/keys',
        RED.auth.needsPermission('flows.read'),
        function(req, res) {
            const scope = req.query.scope === 'flow' ? 'flow' : 'global';
            const key = sanitizeKey(req.query.key);
            const z = req.query.z;
            if (!key) return res.json({ keys: [] });

            try {
                let ctx;
                if (scope === 'global') {
                    // Global context is reachable via any node's context().global.
                    let anyNode = null;
                    RED.nodes.eachNode(function(n) { if (!anyNode && n.z) anyNode = RED.nodes.getNode(n.id); });
                    ctx = anyNode ? anyNode.context().global : null;
                } else {
                    // Flow context: need a live node on that flow.
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
