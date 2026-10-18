/**
 * Context-dictionary access shared by every node, plus the editor's
 * "list keys" admin endpoint used by the dataops-runtime field picker.
 *
 * A context dictionary is a plain object stored at <scope>.<key> where scope is
 * 'global' or 'flow' and key has been passed through sanitizeKey().
 */
'use strict';

const { sanitizeKey } = require('./ctxkey');

function normScope(scope) {
    return scope === 'flow' ? 'flow' : 'global';
}

/** The Node-RED context store for a scope ('flow' | 'global'; anything else → global). */
function getStore(node, scope) {
    return node.context()[normScope(scope)];
}

function asDict(d) {
    return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null;
}

/** Read the dictionary at <scope>.<key>; returns {} when absent or not an object. */
function readDict(node, scope, key) {
    if (!key) return {};
    return asDict(getStore(node, scope).get(key)) || {};
}

/** Write the dictionary at <scope>.<key>. */
function writeDict(node, scope, key, dict) {
    getStore(node, scope).set(key, dict);
}

// Admin endpoint registration is per RED.httpAdmin instance (the test helper
// creates a fresh one per run), so guard with a WeakSet rather than a boolean.
const registered = new WeakSet();

/**
 * GET /dataops/context/keys?scope=global|flow&key=<specKey>&z=<flow id>
 *   → { keys: [...], note? }
 *
 * Node-RED exposes no direct context API to admin routes, so we borrow a live
 * node's context: any node for global scope, a node on flow `z` for flow scope.
 * The flow must therefore be deployed.
 */
function registerKeysEndpoint(RED) {
    if (!RED.httpAdmin || registered.has(RED.httpAdmin)) return;
    registered.add(RED.httpAdmin);

    RED.httpAdmin.get('/dataops/context/keys',
        RED.auth.needsPermission('flows.read'),
        function(req, res) {
            const scope = normScope(req.query.scope);
            const key = sanitizeKey(req.query.key);
            const z = req.query.z;
            if (!key) return res.json({ keys: [] });

            try {
                let live = null;
                RED.nodes.eachNode(function(n) {
                    if (live || !n.z) return;
                    if (scope === 'flow' && n.z !== z) return;
                    live = RED.nodes.getNode(n.id);
                });
                if (!live) {
                    return res.json({ keys: [], note: 'context not available (deploy the flow and ensure data has arrived)' });
                }
                const dict = asDict(live.context()[scope].get(key));
                if (!dict) return res.json({ keys: [], note: 'no dictionary found at this scope/key yet' });
                res.json({ keys: Object.keys(dict).sort() });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        });
}

module.exports = { getStore, readDict, writeDict, registerKeysEndpoint };
