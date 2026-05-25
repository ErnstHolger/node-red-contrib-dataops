/**
 * dataops-cache - Config node providing central message cache and event bus
 *
 * Stores Map<key, {payload, ts, metadata}> for full message payloads.
 * Adapted from event-cache — uses in-memory primary store with debounced
 * sync to Node-RED context for sidebar visibility and persistence.
 */
module.exports = function(RED) {
    const EventEmitter = require('events');

    const sharedInstances = new Map();

    function DataOpsCacheNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.name = config.name || '';
        node.maxEntries = parseInt(config.maxEntries) || 10000;
        node.ttl = parseInt(config.ttl) || 0;

        // Context key = the configured name as the user typed it (with light
        // sanitization for valid dot-notation access). Falls back to node.id
        // when blank so an unnamed cache still has a stable, unique location.
        const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_]/g, '_');
        const contextKey = sanitize(node.name || node.id);
        const legacyContextKey = `dataopsCache_${sanitize(node.name || 'DataOps Cache')}`;
        const globalContext = node.context().global;

        const instanceKey = node.id;
        if (!sharedInstances.has(instanceKey)) {
            sharedInstances.set(instanceKey, {
                emitter: new EventEmitter(),
                subscriptions: new Map(),
                users: 0,
                subscriptionCounter: 0,
                cache: new Map(),
                entryCount: 0
            });
        }

        const instance = sharedInstances.get(instanceKey);
        instance.users++;
        instance.emitter.setMaxListeners(200);

        const cache = instance.cache;

        // Restore from context if cache is empty (e.g. after restart).
        // Also migrates data from the pre-rename legacy key (dataopsCache_*).
        if (cache.size === 0) {
            let stored = globalContext.get(contextKey);
            if (!stored && legacyContextKey !== contextKey) {
                const legacy = globalContext.get(legacyContextKey);
                if (legacy && typeof legacy === 'object' && Object.keys(legacy).length > 0) {
                    stored = legacy;
                    globalContext.set(contextKey, legacy);
                    globalContext.set(legacyContextKey, undefined);
                    RED.log.info(`[dataops-cache] migrated ${Object.keys(legacy).length} entries from global.${legacyContextKey} → global.${contextKey}`);
                }
            }
            if (stored && typeof stored === 'object') {
                for (const [key, entry] of Object.entries(stored)) {
                    cache.set(key, entry);
                }
            }
        }
        instance.entryCount = cache.size;

        // Debounced sync to context store
        let syncPending = false;
        const SYNC_INTERVAL = 500;

        function syncToContext() {
            if (!syncPending) return;
            syncPending = false;
            const obj = {};
            for (const [key, entry] of cache) {
                obj[key] = entry;
            }
            globalContext.set(contextKey, obj);
        }

        function scheduleSyncToContext() {
            if (!syncPending) {
                syncPending = true;
                setTimeout(syncToContext, SYNC_INTERVAL);
            }
        }

        // TTL cleanup
        let ttlInterval = null;
        if (node.ttl > 0) {
            ttlInterval = setInterval(() => {
                const now = Date.now();
                let changed = false;
                for (const [key, entry] of cache) {
                    if (now - entry.ts > node.ttl) {
                        cache.delete(key);
                        changed = true;
                    }
                }
                if (changed) {
                    instance.entryCount = cache.size;
                    scheduleSyncToContext();
                }
            }, Math.min(node.ttl, 60000));
        }

        /**
         * Set a full message payload in the cache.
         */
        node.setValue = function(key, payload, metadata) {
            const existing = cache.get(key);
            const ts = Date.now();

            const entry = {
                payload: payload,
                ts: ts,
                metadata: metadata || {},
                previous: existing
                    ? { payload: existing.payload, ts: existing.ts, metadata: existing.metadata }
                    : { payload: payload, ts: ts, metadata: metadata || {} }
            };

            cache.set(key, entry);

            // LRU eviction — remove oldest
            if (cache.size > node.maxEntries) {
                let oldestKey = null;
                let oldestTs = Infinity;
                for (const [k, e] of cache) {
                    if (e.ts < oldestTs) {
                        oldestTs = e.ts;
                        oldestKey = k;
                    }
                }
                if (oldestKey !== null) {
                    cache.delete(oldestKey);
                }
            }

            instance.entryCount = cache.size;
            scheduleSyncToContext();
            instance.emitter.emit('update', key, entry);
        };

        /**
         * Get a cached entry by key.
         */
        node.getValue = function(key) {
            return cache.get(key);
        };

        /**
         * Get the previous value for a key.
         */
        node.getPrevious = function(key) {
            const entry = cache.get(key);
            return entry ? entry.previous : undefined;
        };

        /**
         * Subscribe to updates for a specific key.
         * @returns {string} Subscription ID for unsubscribe
         */
        node.subscribe = function(key, callback) {
            const subId = `sub_${++instance.subscriptionCounter}`;

            if (!instance.subscriptions.has(key)) {
                instance.subscriptions.set(key, new Map());
            }
            instance.subscriptions.get(key).set(subId, callback);

            return subId;
        };

        /**
         * Unsubscribe from updates.
         */
        node.unsubscribe = function(subscriptionId) {
            for (const [key, subs] of instance.subscriptions) {
                if (subs.delete(subscriptionId)) {
                    if (subs.size === 0) {
                        instance.subscriptions.delete(key);
                    }
                    return;
                }
            }
        };

        /**
         * Get all keys in cache.
         */
        node.getKeys = function() {
            return Array.from(cache.keys());
        };

        /**
         * Get the number of entries.
         */
        node.size = function() {
            return cache.size;
        };

        /**
         * Clear all entries.
         */
        node.clear = function() {
            cache.clear();
            globalContext.set(contextKey, {});
        };

        // Internal: dispatch updates to matching subscriptions
        const updateHandler = (key, entry) => {
            const subs = instance.subscriptions.get(key);
            if (subs) {
                for (const [, callback] of subs) {
                    try {
                        callback(key, entry);
                    } catch (err) {
                        RED.log.error(`[dataops-cache] Subscription callback error: ${err.message}`);
                    }
                }
            }
        };
        instance.emitter.on('update', updateHandler);

        node.on('close', function(done) {
            if (ttlInterval) {
                clearInterval(ttlInterval);
            }

            syncPending = true;
            syncToContext();

            instance.users--;
            if (instance.users <= 0) {
                instance.subscriptions.clear();
                instance.emitter.removeAllListeners();
                sharedInstances.delete(instanceKey);
            }
            done();
        });
    }

    RED.nodes.registerType("dataops-cache", DataOpsCacheNode);

    // HTTP Admin endpoints
    RED.httpAdmin.post("/dataops-cache/:id/clear", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node && node.clear) {
            node.clear();
            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    });

    RED.httpAdmin.get("/dataops-cache/:id/stats", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node) {
            const instance = sharedInstances.get(node.id);
            let subCount = 0;
            if (instance) {
                for (const subs of instance.subscriptions.values()) {
                    subCount += subs.size;
                }
            }
            res.json({
                size: node.size(),
                keys: node.getKeys(),
                maxEntries: node.maxEntries,
                ttl: node.ttl,
                subscriptions: {
                    count: subCount,
                    keys: instance ? instance.subscriptions.size : 0
                }
            });
        } else {
            res.sendStatus(404);
        }
    });

    RED.httpAdmin.get("/dataops-cache/:id/keys", function(req, res) {
        const node = RED.nodes.getNode(req.params.id);
        if (node) {
            res.json(node.getKeys());
        } else {
            res.json([]);
        }
    });
};
