/**
 * Update the simulation flow via Node-RED API to add trigger and name tags.
 *
 *   node update-sim-flow.js
 */
'use strict';

const NR = 'http://127.0.0.1:1880';
const TAB_ID = 'sim-tab';
const GEN_NODE_ID = 'sim-gen';

// Updated waveform generator function
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
    "// Trigger: changes every 10 min (600s), alternates between true and false.",
    "const triggerPeriod = 600;",
    "const triggerCycle = (now / 1000) % (2 * triggerPeriod);",
    "const trigger = triggerCycle < triggerPeriod;",
    "",
    "// Generate random ID when transitioning from false to true.",
    "const prevTrigger = context.get('prevTrigger');",
    "if (trigger && !prevTrigger) {",
    "    context.set('randomId', Math.random().toString(36).substring(2, 10));",
    "}",
    "context.set('prevTrigger', trigger);",
    "const randomId = context.get('randomId') || 'none';",
    "",
    "msgs.push({",
    "    topic: 'testtopic/sim/trigger',",
    "    payload: { value: trigger, timestamp: ts, quality: true }",
    "});",
    "msgs.push({",
    "    topic: 'testtopic/sim/name',",
    "    payload: { value: randomId, timestamp: ts, quality: true }",
    "});",
    "",
    "return [msgs];"
].join('\n');

async function main() {
    try {
        // Fetch current flows
        console.log('Fetching current flows...');
        const getRes = await fetch(NR + '/flows', {
            headers: { 'Accept': 'application/json' }
        });
        if (!getRes.ok) throw new Error('GET /flows failed: ' + getRes.status);
        const current = await getRes.json();
        console.log('Fetched', current.length, 'nodes');

        // Find and update the generator node
        const genNode = current.find(n => n.id === GEN_NODE_ID);
        if (!genNode) throw new Error('Generator node not found (id: ' + GEN_NODE_ID + ')');

        console.log('Updating generator node...');
        genNode.func = GEN_FUNC;

        // Post updated flows
        console.log('Posting updated flows...');
        const postRes = await fetch(NR + '/flows', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Node-RED-API-Version': 'v2',
                'Node-RED-Deployment-Type': 'full'
            },
            body: JSON.stringify({ flows: current })
        });

        if (!postRes.ok) {
            const txt = await postRes.text();
            throw new Error('POST /flows failed: ' + postRes.status + ' ' + txt);
        }

        const result = await postRes.text();
        console.log('Deployment successful:', result);
    } catch (err) {
        console.error('ERROR:', err.message);
        process.exit(1);
    }
}

main();
