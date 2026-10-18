/**
 * dataops-in ("cache") — write each msg.payload into a context dictionary.
 *
 * Extracts a key from the message (default: msg.topic) and stores the payload
 * at <specScope>.<specKey>[key]. Store modes:
 *
 *   wrapped — { payload, ts, metadata, previous }   (dataops-claude source)
 *   flat    — msg.payload as-is                     (latest-value cache for
 *                                                    dataops-runtime)
 *
 * Optional bounds:
 *   maxEntries — LRU eviction when the dict exceeds the cap (0 = unbounded).
 *                Every write moves the key to the most-recent position.
 *   ttl        — entries older than ttl ms are purged on a timer (0 = none;
 *                wrapped mode only — flat entries carry no timestamp).
 *
 * The message passes through unchanged on the single output.
 */
'use strict';

const { sanitizeKey } = require('../lib/ctxkey');
const { readDict, writeDict } = require('../lib/context');
const { getMsgKey } = require('../lib/values');

module.exports = function(RED) {
    function DataOpsInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.keyField   = config.keyField || 'topic';
        node.specScope  = config.specScope || 'global';
        node.specKey    = sanitizeKey(config.specKey);
        node.maxEntries = Math.max(0, parseInt(config.maxEntries, 10) || 0);
        node.ttl        = Math.max(0, parseInt(config.ttl, 10) || 0);
        node.storeMode  = config.storeMode === 'flat' ? 'flat' : 'wrapped';

        function setReady() {
            if (!node.specKey) node.status({ fill: 'yellow', shape: 'ring', text: 'no spec key' });
            else if (node.ttl > 0 && node.storeMode === 'flat') node.status({ fill: 'yellow', shape: 'ring', text: 'TTL ignored in flat mode' });
            else node.status({ fill: 'green', shape: 'dot', text: 'ready' });
        }
        setReady();

        let ttlTimer = null;
        if (node.ttl > 0 && node.storeMode === 'wrapped' && node.specKey) {
            ttlTimer = setInterval(() => {
                const dict = readDict(node, node.specScope, node.specKey);
                const now = Date.now();
                let changed = false;
                for (const [k, e] of Object.entries(dict)) {
                    if (e && typeof e.ts === 'number' && now - e.ts > node.ttl) {
                        delete dict[k];
                        changed = true;
                    }
                }
                if (changed) writeDict(node, node.specScope, node.specKey, dict);
            }, Math.min(node.ttl, 60000));
        }

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                if (!node.specKey) {
                    node.status({ fill: 'yellow', shape: 'ring', text: 'no spec key' });
                    return done(new Error('No Spec Key configured'));
                }

                const rawKey = getMsgKey(RED, msg, node.keyField);
                if (rawKey === undefined || rawKey === null || rawKey === '' || typeof rawKey === 'object') {
                    node.status({ fill: 'yellow', shape: 'ring', text: 'missing key' });
                    return done(new Error(`Key not found at msg.${String(node.keyField).replace(/^msg\./, '')}`));
                }
                const key = String(rawKey);

                const dict = readDict(node, node.specScope, node.specKey);
                const existing = dict[key];
                // Delete first so re-inserting moves the key to the end (LRU order).
                delete dict[key];

                if (node.storeMode === 'flat') {
                    dict[key] = msg.payload;
                } else {
                    const ts = Date.now();
                    const metadata = { _msgid: msg._msgid, originalTopic: msg.topic };
                    dict[key] = {
                        payload: msg.payload,
                        ts,
                        metadata,
                        previous: existing && typeof existing === 'object'
                            ? { payload: existing.payload, ts: existing.ts, metadata: existing.metadata }
                            : { payload: msg.payload, ts, metadata }
                    };
                }

                // LRU eviction: insertion order == recency because of the delete above
                // (except integer-like keys, which JS objects always enumerate first).
                if (node.maxEntries > 0) {
                    const keys = Object.keys(dict);
                    for (let i = 0; i < keys.length - node.maxEntries; i++) delete dict[keys[i]];
                }

                writeDict(node, node.specScope, node.specKey, dict);

                const displayKey = key.length > 20 ? key.substring(0, 17) + '...' : key;
                node.status({ fill: 'green', shape: 'dot', text: displayKey });

                send(msg);
                done();
            } catch (err) {
                node.status({ fill: 'red', shape: 'ring', text: 'error' });
                done(err);
            }
        });

        node.on('close', function(done) {
            if (ttlTimer) { clearInterval(ttlTimer); ttlTimer = null; }
            done();
        });
    }

    RED.nodes.registerType('dataops-in', DataOpsInNode);
};
