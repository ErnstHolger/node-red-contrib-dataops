/**
 * dataops-in - Cache-in node: pushes messages into a context dictionary.
 *
 * Extracts a key from the message (default: msg.topic) and stores the full
 * msg.payload at <specScope>.<specKey>[key] as a dictionary of entries:
 *
 *     { payload, ts, metadata, previous }
 *
 * so dataops-claude (Source) and dataops-transform can consume it. The message
 * passes through unchanged.
 *
 * Optional bounds:
 *   maxEntries — LRU eviction by oldest ts when the dict exceeds the cap (0 = unbounded)
 *   ttl        — entries older than ttl ms are purged on a timer (0 = no expiry)
 */
const { sanitizeKey } = require('../lib/ctxkey');

module.exports = function(RED) {
    function DataOpsInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.keyField   = config.keyField || 'topic';
        // Scope + Spec Key define the context dictionary written to,
        // consistent with dataops-claude (Source) and dataops-transform.
        node.specScope  = config.specScope || 'global';
        node.specKey    = sanitizeKey(config.specKey);
        node.maxEntries = parseInt(config.maxEntries) || 0; // 0 = unbounded
        node.ttl        = parseInt(config.ttl) || 0;        // 0 = no expiry
        // storeMode: 'wrapped' = { payload, ts, metadata, previous } (for dataops-claude samples);
        //            'flat'    = store msg.payload as-is (clean cache of normalized records).
        node.storeMode  = config.storeMode || 'wrapped';

        function store() {
            return node.context()[node.specScope] || node.context().global;
        }

        function readDict() {
            const d = store().get(node.specKey);
            return (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
        }

        function setReady() {
            if (!node.specKey) node.status({ fill: "yellow", shape: "ring", text: "no spec key" });
            else node.status({ fill: "green", shape: "dot", text: "ready" });
        }
        setReady();

        // TTL purge timer
        let ttlInterval = null;
        if (node.ttl > 0) {
            ttlInterval = setInterval(() => {
                if (!node.specKey) return;
                const dict = readDict();
                const now = Date.now();
                let changed = false;
                for (const [k, e] of Object.entries(dict)) {
                    if (e && typeof e.ts === 'number' && now - e.ts > node.ttl) {
                        delete dict[k];
                        changed = true;
                    }
                }
                if (changed) store().set(node.specKey, dict);
            }, Math.min(node.ttl, 60000));
        }

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                if (!node.specKey) {
                    node.status({ fill: "yellow", shape: "ring", text: "no spec key" });
                    done(new Error("No Spec Key configured"));
                    return;
                }

                const prop = node.keyField.startsWith('msg.') ? node.keyField.substring(4) : node.keyField;
                const key = RED.util.getMessageProperty(msg, prop);

                if (!key || typeof key !== 'string') {
                    node.status({ fill: "yellow", shape: "ring", text: "missing key" });
                    done(new Error(`Key not found at msg.${prop}`));
                    return;
                }

                const dict = readDict();
                const ts = Date.now();
                const existing = dict[key];

                if (node.storeMode === 'flat') {
                    // Store the payload as-is — a clean cache of normalized records.
                    dict[key] = msg.payload;
                } else {
                    const metadata = { _msgid: msg._msgid, originalTopic: msg.topic };
                    dict[key] = {
                        payload: msg.payload,
                        ts: ts,
                        metadata: metadata,
                        previous: existing
                            ? { payload: existing.payload, ts: existing.ts, metadata: existing.metadata }
                            : { payload: msg.payload, ts: ts, metadata: metadata }
                    };
                }

                // LRU eviction — remove the oldest entry while over the cap.
                // Uses entry.ts in wrapped mode; falls back to insertion order in flat
                // mode (re-inserting an existing key below keeps it "fresh").
                if (node.maxEntries > 0) {
                    let keys = Object.keys(dict);
                    while (keys.length > node.maxEntries) {
                        let oldestKey = keys[0], oldestTs = Infinity, haveTs = false;
                        for (const k of keys) {
                            const t = dict[k] && typeof dict[k] === 'object' ? dict[k].ts : undefined;
                            if (typeof t === 'number') { haveTs = true; if (t < oldestTs) { oldestTs = t; oldestKey = k; } }
                        }
                        if (!haveTs) oldestKey = keys[0]; // flat mode: oldest inserted
                        delete dict[oldestKey];
                        keys = Object.keys(dict);
                    }
                }

                store().set(node.specKey, dict);

                const displayKey = key.length > 20 ? key.substring(0, 17) + '...' : key;
                node.status({ fill: "green", shape: "dot", text: displayKey });

                send(msg);
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });

        node.on('close', function(done) {
            if (ttlInterval) { clearInterval(ttlInterval); ttlInterval = null; }
            done();
        });
    }

    RED.nodes.registerType("dataops-in", DataOpsInNode);
};
