/**
 * dataops-combine - Combine multiple cached messages into one wide message
 *
 * Key-based join within a time window. Triggered by cache updates (event),
 * a fixed interval, or an external message.
 */
module.exports = function(RED) {

    function DataOpsCombineNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.cacheConfig = RED.nodes.getNode(config.cache);
        node.inputMappings = config.inputMappings || [];
        node.joinKey = config.joinKey || '';
        node.windowMs = parseInt(config.windowMs) || 0;
        node.outputTopic = config.outputTopic || 'dataops/combined';
        node.table = config.table || '';
        node.triggerMode = config.triggerMode || 'event';
        node.intervalMs = parseInt(config.intervalMs) || 60000;
        node.cronExpr = config.cronExpr || '';

        const subscriptionIds = [];

        if (!node.cacheConfig) {
            node.status({ fill: "red", shape: "ring", text: "no cache" });
            return;
        }

        if (node.inputMappings.length === 0) {
            node.status({ fill: "yellow", shape: "ring", text: "no inputs" });
            return;
        }

        // Track latest values per mapping
        const latestEntries = new Map();

        // Subscribe to each mapped topic
        for (const mapping of node.inputMappings) {
            const topic = mapping.topic;
            if (!topic) continue;

            const subId = node.cacheConfig.subscribe(topic, (key, entry) => {
                latestEntries.set(topic, {
                    payload: entry.payload,
                    ts: entry.ts,
                    metadata: entry.metadata
                });

                if (node.triggerMode === 'event') {
                    tryCombine(key, entry.ts);
                }
            });
            subscriptionIds.push(subId);
        }

        // Interval trigger
        let intervalHandle = null;
        if (node.triggerMode === 'interval') {
            intervalHandle = setInterval(() => {
                tryCombine('_interval', Date.now());
            }, node.intervalMs);
        }

        /**
         * Attempt to combine cached messages.
         * All inputs must be present and their timestamps must fall within the window.
         * Join key values must match across outputs.
         */
        function tryCombine(triggerKey, triggerTs) {
            if (latestEntries.size === 0) return;

            // Check all inputs have values
            const values = {};
            let allPresent = true;
            let oldestTs = Infinity;
            let newestTs = 0;

            for (const mapping of node.inputMappings) {
                const entry = latestEntries.get(mapping.topic);
                if (!entry) {
                    allPresent = false;
                    break;
                }
                values[mapping.name] = entry.payload;
                if (entry.ts < oldestTs) oldestTs = entry.ts;
                if (entry.ts > newestTs) newestTs = entry.ts;
            }

            if (!allPresent) return;

            // Check time window
            if (node.windowMs > 0 && (newestTs - oldestTs) > node.windowMs) {
                return;
            }

            // Check join key match
            if (node.joinKey) {
                const joinValues = new Set();
                for (const [, entry] of latestEntries) {
                    const val = node.joinKey.split('.').reduce((o, k) => o && o[k], entry.payload);
                    joinValues.add(JSON.stringify(val));
                }
                if (joinValues.size > 1) return;
            }

            // Build combined payload
            const combined = {};
            for (const mapping of node.inputMappings) {
                combined[mapping.name] = values[mapping.name];
            }

            const msg = {
                topic: node.outputTopic,
                payload: combined,
                _table: node.table || undefined,
                trigger: triggerKey,
                ts: triggerTs,
                windowStart: oldestTs,
                windowEnd: newestTs
            };

            node.send([msg, null]);
            node.status({ fill: "green", shape: "dot", text: `combined @ ${new Date().toISOString().slice(11, 19)}` });
        }

        // Handle external trigger via input port
        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            if (node.triggerMode === 'external') {
                tryCombine(msg.topic || '_external', msg.timestamp || Date.now());
                done();
                return;
            }

            // Allow dynamic table override
            if (msg._table && typeof msg._table === 'string') {
                node.table = msg._table;
            }

            // Force combine
            if (msg.payload === 'combine' || msg.topic === 'combine') {
                tryCombine('_manual', msg.timestamp || Date.now());
            }

            done();
        });

        node.on('close', function(done) {
            if (intervalHandle) {
                clearInterval(intervalHandle);
            }
            for (const subId of subscriptionIds) {
                if (node.cacheConfig) {
                    node.cacheConfig.unsubscribe(subId);
                }
            }
            subscriptionIds.length = 0;
            done();
        });

        node.status({ fill: "green", shape: "dot", text: `ready (${node.triggerMode})` });
    }

    RED.nodes.registerType("dataops-combine", DataOpsCombineNode);
};
