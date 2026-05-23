/**
 * dataops-split - Split wide messages into narrower ones
 *
 * Two modes:
 * - 'fields': Extract named fields from payload into separate output messages.
 *             Each field group maps to one output port (up to 4).
 * - 'array':  Expand an array within the payload into individual messages.
 *             One message per array element.
 */
module.exports = function(RED) {

    const MAX_OUTPUTS = 4;

    function DataOpsSplitNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.splitMode = config.splitMode || 'fields';
        node.fieldGroups = config.fieldGroups || [];
        node.arrayPath = config.arrayPath || 'payload';
        node.includeContext = config.includeContext || [];

        node.status({ fill: "green", shape: "dot", text: node.splitMode === 'fields' ? "field mode" : "array mode" });

        node.on('input', function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };
            done = done || function(err) { if (err) node.error(err, msg); };

            try {
                if (node.splitMode === 'fields') {
                    doFieldSplit(msg, send);
                } else {
                    doArraySplit(msg, send);
                }
                done();
            } catch (err) {
                node.status({ fill: "red", shape: "ring", text: "error" });
                done(err);
            }
        });

        function doFieldSplit(msg, send) {
            const payload = msg.payload;
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
                node.status({ fill: "yellow", shape: "ring", text: "payload not object" });
                return;
            }

            // Build output messages — one per field group
            const outputs = new Array(MAX_OUTPUTS).fill(null);
            let count = 0;

            for (let i = 0; i < Math.min(node.fieldGroups.length, MAX_OUTPUTS); i++) {
                const group = node.fieldGroups[i];
                if (!group.fields) continue;

                const fieldNames = group.fields.split(',').map(f => f.trim()).filter(Boolean);
                if (fieldNames.length === 0) continue;

                const extracted = {};
                for (const field of fieldNames) {
                    if (field in payload) {
                        extracted[field] = payload[field];
                    }
                }

                if (Object.keys(extracted).length === 0) continue;

                outputs[i] = {
                    topic: group.topic || msg.topic,
                    payload: extracted,
                    _table: group.table || undefined,
                    _splitSource: msg.topic
                };
                count++;
            }

            send(outputs);
            node.status({ fill: "green", shape: "dot", text: `split → ${count} outputs` });
        }

        function doArraySplit(msg, send) {
            // Locate the array using the configured path
            let arr;
            if (node.arrayPath === 'payload') {
                arr = msg.payload;
            } else {
                arr = RED.util.getMessageProperty(msg, node.arrayPath);
            }

            if (!Array.isArray(arr)) {
                node.status({ fill: "yellow", shape: "ring", text: "not an array" });
                return;
            }

            // Build context from parent fields
            let contextFields = {};
            if (node.includeContext && node.includeContext.length > 0) {
                const contextList = node.includeContext.split(',').map(f => f.trim()).filter(Boolean);
                for (const field of contextList) {
                    if (field in (msg.payload || {})) {
                        contextFields[field] = msg.payload[field];
                    }
                }
            }

            let count = 0;
            for (const element of arr) {
                const outputPayload = typeof element === 'object' && !Array.isArray(element)
                    ? Object.assign({}, contextFields, element)
                    : { value: element, ...contextFields };

                send({
                    topic: msg.topic,
                    payload: outputPayload,
                    _table: msg._table,
                    _splitIndex: count,
                    _splitSource: msg.topic
                });
                count++;
            }

            node.status({ fill: "green", shape: "dot", text: `expanded ${count} msgs` });
        }

        // Handle reconfiguration via input message
        // Dynamic table override supported via msg._table
    }

    RED.nodes.registerType("dataops-split", DataOpsSplitNode);
};
