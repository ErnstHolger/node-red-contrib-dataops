'use strict';

/**
 * Promise wrappers around node-red-node-test-helper for use with node:test.
 * Each test loads a flow into a real Node-RED runtime (in-memory context).
 */
const helper = require('node-red-node-test-helper');
helper.init(require.resolve('node-red'));

const NODES = {
    in:        require('../nodes/dataops-in'),
    transform: require('../nodes/dataops-transform'),
    cron:      require('../nodes/dataops-cron'),
    runtime:   require('../nodes/dataops-runtime'),
    claudeApi: require('../nodes/dataops-claude-api'),
    claude:    require('../nodes/dataops-claude')
};
const ALL = Object.values(NODES);

function start() { return new Promise((res, rej) => helper.startServer(e => e ? rej(e) : res())); }
function stop()  { return new Promise((res, rej) => helper.stopServer(e => e ? rej(e) : res())); }
async function unload() { await helper.unload(); }

function load(flow, credentials, nodes) {
    return new Promise((res, rej) => {
        try { helper.load(nodes || ALL, flow, credentials || {}, () => res()); }
        catch (e) { rej(e); }
    });
}

/** Resolve with the next message a helper node receives (rejects on timeout). */
function nextMessage(nodeId, timeoutMs = 2000) {
    const n = helper.getNode(nodeId);
    return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout waiting for ${nodeId}`)), timeoutMs);
        n.once('input', msg => { clearTimeout(t); res(msg); });
    });
}

/** Collect messages for a while. */
function collect(nodeId, ms = 100) {
    const n = helper.getNode(nodeId);
    const msgs = [];
    const h = msg => msgs.push(msg);
    n.on('input', h);
    return new Promise(res => setTimeout(() => { n.removeListener('input', h); res(msgs); }, ms));
}

/** Send a msg to a node and wait for its done() (errors → reject). */
function receive(nodeId, msg) {
    const n = helper.getNode(nodeId);
    n.receive(msg);
}

/** Read a global context value via a loaded node. */
function globalGet(nodeId, key) {
    return helper.getNode(nodeId).context().global.get(key);
}
function globalSet(nodeId, key, value) {
    helper.getNode(nodeId).context().global.set(key, value);
}

let seq = 0;
/** Unique context key per test so in-memory context never leaks between tests. */
function uniqueKey(prefix) { return `${prefix}_${process.pid}_${++seq}`; }

module.exports = { helper, NODES, ALL, start, stop, unload, load, nextMessage, collect, receive, globalGet, globalSet, uniqueKey };
