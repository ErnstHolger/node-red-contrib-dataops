/**
 * One-shot: append a waveform-simulation flow to the running Node-RED via the
 * admin API (lossless — fetches current flows, adds a new tab, POSTs the union).
 *
 *   node deploy-sim-flow.js
 */
'use strict';

const NR = 'http://127.0.0.1:1880';
const BROKER_ID = 'f8654e321ca3b9b8'; // existing HiveMQ broker
const TAB_ID = 'sim-tab';

// --- nodes for the new flow ---------------------------------------------

const TAB = {
    id: TAB_ID, type: 'tab', label: 'Simulation', disabled: false,
    info: 'Waveform simulators (sine, sawtooth, square, triangle).\nPeriod 1h, amplitude 100, sampled every 10s, published to testtopic/sim/* on HiveMQ.'
};

// 10s tick
const INJECT = {
    id: 'sim-tick', type: 'inject', z: TAB_ID, name: '10s tick',
    props: [{ p: 'payload' }],
    repeat: '10', crontab: '', once: true, onceDelay: 1,
    topic: '', payload: '', payloadType: 'date',
    x: 150, y: 200, wires: [['sim-gen']]
};

// waveform generator: computes all 4 from wall-clock epoch, emits 4 messages
const GEN_FUNC = [
    "// Period 1h, amplitude 100. Phase from wall-clock so curves are continuous.",
    "const A = 100, P = 3600;",
    "const now = Date.now();",
    "const t = (now / 1000) % P;     // seconds into the hour",
    "const x = t / P;                // 0..1",
    "",
    "const waves = {",
    "    sine:     A * Math.sin(2 * Math.PI * x),",
    "    sawtooth: A * (2 * x - 1),                 // -100 -> +100 ramp",
    "    square:   x < 0.5 ? A : -A,",
    "    triangle: A * (1 - 4 * Math.abs(x - 0.5))  // -100 .. +100 .. -100",
    "};",
    "",
    "const ts = new Date(now).toISOString();",
    "const msgs = Object.keys(waves).map(name => ({",
    "    topic: 'testtopic/sim/' + name,",
    "    payload: {",
    "        value: Math.round(waves[name] * 100) / 100,",
    "        timestamp: ts,",
    "        quality: true",
    "    }",
    "}));",
    "",
    "// Nested array: one inner array = a sequence of messages out of port 1.",
    "// (A flat array would be treated as one-per-output-port and drop all but the first.)",
    "return [msgs];"
].join('\n');

const GEN = {
    id: 'sim-gen', type: 'function', z: TAB_ID, name: 'waveforms',
    func: GEN_FUNC, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
    x: 320, y: 200, wires: [['sim-mqtt']]
};

// single mqtt out — topic comes from each msg.topic
const MQTT_OUT = {
    id: 'sim-mqtt', type: 'mqtt out', z: TAB_ID, name: 'UNS publish',
    topic: '', qos: '0', retain: 'true', respTopic: '', contentType: '',
    userProps: '', correl: '', expiry: '', broker: BROKER_ID,
    x: 530, y: 200, wires: []
};

// optional: a debug to see what's emitted
const DEBUG = {
    id: 'sim-debug', type: 'debug', z: TAB_ID, name: 'sim out',
    active: false, tosidebar: true, console: false, tostatus: false,
    complete: 'true', targetType: 'full', statusVal: '', statusType: 'auto',
    x: 530, y: 280, wires: []
};
// wire generator to debug as well
GEN.wires = [['sim-mqtt', 'sim-debug']];

// trigger/name generator: emits trigger (true/false every 10 min) and name (random ID on transition)
const TRIGGER_FUNC = [
    "const now = Date.now();",
    "const sec = Math.floor(now / 1000);",
    "const triggerPeriod = 600;  // 10 minutes",
    "const cycleSec = sec % (2 * triggerPeriod);  // 0..1199",
    "const trigger = cycleSec < triggerPeriod;",
    "",
    "// Detect false→true transition",
    "const prevSec = context.get('prevSec') || sec;",
    "const prevTrigger = context.get('prevTrigger');",
    "const wasTransition = (prevTrigger === false && trigger === true);",
    "",
    "if (wasTransition) {",
    "    context.set('randomId', Math.random().toString(36).substring(2, 10));",
    "}",
    "context.set('prevSec', sec);",
    "context.set('prevTrigger', trigger);",
    "const randomId = context.get('randomId') || 'none';",
    "",
    "const ts = new Date(now).toISOString();",
    "const msgs = [",
    "    {",
    "        topic: 'testtopic/sim/trigger',",
    "        payload: { value: trigger, timestamp: ts, quality: true }",
    "    },",
    "    {",
    "        topic: 'testtopic/sim/name',",
    "        payload: { value: randomId, timestamp: ts, quality: true }",
    "    }",
    "];",
    "return [msgs];"
].join('\n');

const TRIGGER_GEN = {
    id: 'sim-trigger-gen', type: 'function', z: TAB_ID, name: 'trigger/name',
    func: TRIGGER_FUNC, outputs: 1, noerr: 0, initialize: '', finalize: '', libs: [],
    x: 320, y: 280, wires: [['sim-mqtt']]
};

// wire inject to trigger generator as well
INJECT.wires = [['sim-gen', 'sim-trigger-gen']];

const NEW_NODES = [TAB, INJECT, GEN, TRIGGER_GEN, MQTT_OUT, DEBUG];

// --- deploy --------------------------------------------------------------

async function main() {
    const getRes = await fetch(NR + '/flows', { headers: { 'Accept': 'application/json' } });
    if (!getRes.ok) throw new Error('GET /flows failed: ' + getRes.status);
    const current = await getRes.json();
    console.log('current nodes:', current.length);

    // Upsert: drop any prior copies of our nodes (by id), then append fresh ones.
    const ourIds = new Set(NEW_NODES.map(n => n.id));
    const kept = current.filter(n => !ourIds.has(n.id) && n.z !== TAB_ID);
    const removed = current.length - kept.length;
    const combined = kept.concat(NEW_NODES);
    console.log(removed ? `replacing ${removed} existing sim node(s)` : 'adding new sim flow');
    console.log('posting', combined.length, 'nodes');

    const postRes = await fetch(NR + '/flows', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Node-RED-API-Version': 'v2',
            'Node-RED-Deployment-Type': 'full'
        },
        body: JSON.stringify({ flows: combined })
    });
    const txt = await postRes.text();
    if (!postRes.ok) throw new Error('POST /flows failed: ' + postRes.status + ' ' + txt);
    console.log('deployed OK:', txt);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
