/**
 * dataops-in - Input node that pushes messages to the DataOps cache
 *
 * Extracts a key from the message (default: msg.topic) and stores
 * the full msg.payload in the cache. Passes the message through.
 */
module.exports = function(RED) {
    function DataOpsInNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.cacheConfig = RED.nodes.getNode(config.cache);
        node.keyField = config.keyField || 'topic';

        if (!node.cacheConfig) {
            node.status({ fill: "red", shape: "ring", text: "no cache" });
            return;
        }

        node.status({ fill: "green", shape: "dot", text: "ready" });

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                let key;
                if (node.keyField.startsWith('msg.')) {
                    key = RED.util.getMessageProperty(msg, node.keyField.substring(4));
                } else {
                    key = RED.util.getMessageProperty(msg, node.keyField);
                }

                if (!key || typeof key !== 'string') {
                    node.status({ fill: "yellow", shape: "ring", text: "missing key" });
                    done(new Error(`Key not found at msg.${node.keyField}`));
                    return;
                }

                const metadata = {
                    _msgid: msg._msgid,
                    originalTopic: msg.topic
                };

                node.cacheConfig.setValue(key, msg.payload, metadata);

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
            done();
        });
    }

    RED.nodes.registerType("dataops-in", DataOpsInNode);
};
