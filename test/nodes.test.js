'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./_helper');

test.before(h.start);
test.after(h.stop);
test.afterEach(h.unload);

const out = (id, extra) => Object.assign({ id, type: 'helper' }, extra);

test('dataops-in (wrapped) stores payload with previous', async () => {
    const key = h.uniqueKey('in');
    await h.load([
        { id: 'n1', type: 'dataops-in', specScope: 'global', specKey: key, wires: [['o']] },
        out('o')
    ]);
    const passed = h.nextMessage('o');
    h.receive('n1', { topic: 'plant/a', payload: 1 });
    await passed;
    h.receive('n1', { topic: 'plant/a', payload: 2 });
    await h.nextMessage('o');
    const entry = h.globalGet('n1', key)['plant/a'];
    assert.equal(entry.payload, 2);
    assert.equal(entry.previous.payload, 1);
    assert.equal(entry.metadata.originalTopic, 'plant/a');
});

test('dataops-in (flat) LRU evicts least-recently written key', async () => {
    const key = h.uniqueKey('lru');
    await h.load([
        { id: 'n1', type: 'dataops-in', specScope: 'global', specKey: key, storeMode: 'flat', maxEntries: 2, wires: [['o']] },
        out('o')
    ]);
    for (const [topic, payload] of [['a', 1], ['b', 2], ['a', 3], ['c', 4]]) {
        const p = h.nextMessage('o');
        h.receive('n1', { topic, payload });
        await p;
    }
    // 'a' was rewritten after 'b', so 'b' is the one evicted.
    assert.deepEqual(h.globalGet('n1', key), { a: 3, c: 4 });
});

test('dataops-transform applies specs, lenient $toMillis, and heuristic fallback', async () => {
    const key = h.uniqueKey('specs');
    await h.load([
        { id: 't', type: 'dataops-transform', specScope: 'global', specKey: key, keyField: 'msg.topic', fallbackMode: 'heuristic', wires: [['o'], ['e']] },
        out('o'), out('e')
    ]);
    h.globalSet('t', key, {
        'plant/temp': { type: 'integer', value: '$eval(payload).value.value', timestamp: '$toMillis(payload.ts)', quality: 'payload.statusCode = 0' }
    });

    let p = h.nextMessage('o');
    h.receive('t', { topic: 'plant/temp', payload: { value: { value: '25.7' }, ts: '2026-05-30 20:54:56.056+0100', statusCode: 0 } });
    let msg = await p;
    assert.equal(msg._spec, 'spec');
    assert.deepEqual(msg.payload, {
        name: 'plant/temp', type: 'integer', value: 25,
        timestamp: Date.parse('2026-05-30T20:54:56.056+01:00'), quality: true
    });

    p = h.nextMessage('o');
    h.receive('t', { topic: 'other', payload: { v: 1.5 } });
    msg = await p;
    assert.equal(msg._spec, 'heuristic');
    assert.equal(msg.payload.value, 1.5);
    assert.equal(msg.payload.type, 'number');
});

test('dataops-transform value output puts the value in payload', async () => {
    const key = h.uniqueKey('specs');
    await h.load([
        { id: 't', type: 'dataops-transform', specKey: key, fallbackMode: 'heuristic', outputFormat: 'value', wires: [['o'], ['e']] },
        out('o'), out('e')
    ]);
    h.globalSet('t', key, { 'plant/p': { type: 'number', value: 'payload.value', timestamp: 'payload.ts', quality: 'payload.q' } });
    let p = h.nextMessage('o');
    h.receive('t', { topic: 'plant/p', payload: { value: '3.5', ts: 99, q: false } });
    let msg = await p;
    assert.equal(msg.payload, 3.5);
    assert.equal(msg.topic, 'plant/p');
    assert.equal(msg.timestamp, 99);
    assert.equal(msg.quality, false);
    assert.equal(msg.type, 'number');
    assert.equal(msg._spec, 'spec');

    p = h.nextMessage('o');
    h.receive('t', { topic: 'other', payload: { v: 7 } });
    msg = await p;
    assert.equal(msg.payload, 7);
    assert.equal(msg.type, 'integer');
    assert.equal(msg._spec, 'heuristic');
});

test('dataops-transform passthrough sends unknown topics to output 2', async () => {
    await h.load([
        { id: 't', type: 'dataops-transform', specKey: h.uniqueKey('s'), fallbackMode: 'passthrough', wires: [['o'], ['e']] },
        out('o'), out('e')
    ]);
    const p = h.nextMessage('e');
    h.receive('t', { topic: 'x', payload: 1 });
    assert.equal((await p).payload, 1);
});





test('dataops-runtime: slash topics, unwrapped trigger, sampling rate limit', async () => {
    const key = h.uniqueKey('rt');
    await h.load([
        { id: 'r', type: 'dataops-runtime', specKey: key, triggerKey: 'line/1/running', labelKey: 'line/1/batch',
          fields: JSON.stringify([{ topic: 'line/1/speed', alias: 'speed' }]), sampling: '10', tsFormat: 'epoch', wires: [['o'], ['e']] },
        out('o'), out('e')
    ]);
    const setRun = (on) => h.globalSet('r', key, {
        'line/1/running': { name: 'line/1/running', type: 'boolean', timestamp: 0, value: on, quality: true }, // canonical record
        'line/1/batch':   { payload: 'B-42', ts: 0, metadata: {} },                                          // wrapped scalar
        'line/1/speed':   12.5
    });

    setRun(false);
    const rows = h.collect('o', 200);
    const t0 = 1_000_000;
    h.receive('r', { _epoch: t0 });                 // off
    setRun(true);
    h.receive('r', { _epoch: t0 + 1000 });          // rising edge, 0 s
    h.receive('r', { _epoch: t0 + 6000 });          // 5 s  — too early
    h.receive('r', { _epoch: t0 + 11000 });         // 10 s — emit
    h.receive('r', { _epoch: t0 + 15000 });         // 4 s since last emit — skip
    h.receive('r', { _epoch: t0 + 21000 });         // 10 s since last emit — emit
    setRun(false);
    h.receive('r', { _epoch: t0 + 22000 });         // off — reset
    const got = await rows;

    assert.equal(got.length, 2);
    assert.deepEqual(got[0].payload, [{ timestamp: t0 + 11000, runtime: 10, label: 'B-42', speed: 12.5 }]);
    assert.equal(got[1].payload[0].runtime, 20);
});

test('dataops-claude merges parsed specs into the destination dictionary', async () => {
    const src = h.uniqueKey('src'), dst = h.uniqueKey('dst');
    await h.load([
        { id: 'cfg', type: 'dataops-claude-api', name: 'test' },
        { id: 'c', type: 'dataops-claude', apiConfig: 'cfg', sourceScope: 'global', sourceKey: src,
          specScope: 'global', specKey: dst, maxSampleRows: 10, wires: [['o'], ['e']] },
        out('o'), out('e')
    ], { cfg: { apiKey: 'sk-test' } });

    let seenPrompt = null;
    h.helper.getNode('cfg').complete = async (prompt) => {
        seenPrompt = prompt;
        return {
            content: [{ type: 'text', text: '' }], model: 'claude-test', stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
            text: 'specs[1]{topic,type,value,timestamp,quality}:\n  "plant/a",number,payload.value,$millis(),true'
        };
    };
    h.globalSet('c', dst, { 'plant/old': { type: 'string', value: 'payload' } });

    // Empty source → error, no API call.
    let e = h.nextMessage('e');
    h.receive('c', { payload: '' });
    assert.match((await e).payload.error, /is empty/);
    assert.equal(seenPrompt, null);

    h.globalSet('c', src, { 'plant/a': { payload: { value: 3 }, ts: 1, metadata: { originalTopic: 'plant/a' } } });
    const o = h.nextMessage('o');
    h.receive('c', { payload: '' });
    const msg = await o;
    assert.equal(msg.topic, 'plant/a');
    assert.match(seenPrompt.userPrompt, /samples\[1\]\{topic,ts,payload\}/);
    const merged = h.globalGet('c', dst);
    assert.ok(merged['plant/old'], 'existing specs are preserved');
    assert.equal(merged['plant/a'].value, 'payload.value');
    assert.equal(merged['plant/a']._meta.model, 'claude-test');
});

test('dataops-claude reports API errors on output 2', async () => {
    const src = h.uniqueKey('src');
    await h.load([
        { id: 'cfg', type: 'dataops-claude-api' },
        { id: 'c', type: 'dataops-claude', apiConfig: 'cfg', sourceKey: src, specKey: 'x', wires: [['o'], ['e']] },
        out('o'), out('e')
    ], { cfg: { apiKey: 'sk-test' } });
    h.helper.getNode('cfg').complete = async () => { throw new Error('boom'); };
    h.globalSet('c', src, { a: 1 });
    const e = h.nextMessage('e');
    h.receive('c', {});
    assert.equal((await e).payload.error, 'boom');
});

test('default prompt example specs produce the documented results in transform', async () => {
    const claudeModule = require('../nodes/dataops-claude');
    const p = claudeModule.DEFAULT_SYSTEM_PROMPT;
    const { dict: specs } = claudeModule.parseSpecResponse(p.slice(p.indexOf('Output:', p.indexOf('# Example'))));
    const key = h.uniqueKey('promptSpecs');
    await h.load([
        { id: 't', type: 'dataops-transform', specKey: key, fallbackMode: 'error', wires: [['o'], ['e']] },
        out('o'), out('e')
    ]);
    h.globalSet('t', key, specs);

    const results = {};
    for (const s of claudeModule.EXAMPLE_SAMPLES) {
        const msgP = h.nextMessage('o');
        h.receive('t', { topic: s.topic, payload: s.payload });
        results[s.topic] = (await msgP).payload;
    }
    const now = Date.now();
    const near = (t) => Math.abs(t - now) < 5000;

    const temp = results['plant/boiler/temp'];
    assert.deepEqual([temp.value, temp.type, temp.quality], [182.4, 'number', true]);
    assert.equal(temp.timestamp, Date.parse('2026-05-30T20:54:56.056+01:00'));

    const pressure = results['plant/boiler/pressure'];
    assert.deepEqual([pressure.value, pressure.quality], [12.7, true]);
    assert.ok(near(pressure.timestamp));

    const pump = results['plant/pump/running'];
    assert.deepEqual([pump.value, pump.type, pump.timestamp], [true, 'boolean', 1780000000000]);

    const count = results['plant/line/count'];
    assert.deepEqual([count.value, count.type, count.quality], [4711, 'integer', true]);

    const level = results['plant/tank/level'];
    assert.deepEqual([level.value, level.quality], [61.4, false], 'BadSensorFailure status → quality false');
});

test('GET /dataops/claude/default-prompt serves the built-in prompt', async () => {
    await h.load([{ id: 'cfg', type: 'dataops-claude-api' }, { id: 'c', type: 'dataops-claude', apiConfig: 'cfg', wires: [[], []] }]);
    const res = await h.helper.request().get('/dataops/claude/default-prompt').expect(200);
    assert.equal(res.body.prompt, require('../nodes/dataops-claude').DEFAULT_SYSTEM_PROMPT);
});

test('dataops-cron rejects bad expressions', async () => {
    await h.load([{ id: 'k', type: 'dataops-cron', cronExpr: '* * *', wires: [[], []] }]);
    assert.ok(h.helper.getNode('k'), 'node exists (disabled with red status)');
});

// ---- Example flows --------------------------------------------------------

const EXAMPLES_DIR = path.join(__dirname, '..', 'examples');
const CORE = [
    require('@node-red/nodes/core/common/20-inject.js'),
    require('@node-red/nodes/core/common/21-debug.js'),
    require('@node-red/nodes/core/common/90-comment.js'),
    require('@node-red/nodes/core/function/10-function.js'),
    require('@node-red/nodes/core/function/15-change.js')
];

/**
 * Load an example as the editor's Import would (on a tab), with timers off.
 * Debug nodes become helper nodes so tests can observe what they receive.
 */
async function loadExample(file, { debugAsHelper = false } = {}) {
    const flow = JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'))
        .map(n => Object.assign({}, n,
            n.type === 'dataops-claude-api' ? {} : { z: 'tab' },
            n.type === 'inject' ? { repeat: '', once: false } : {},
            n.type === 'dataops-cron' ? { cronExpr: '0 0 0 1 1 *' } : {},
            debugAsHelper && n.type === 'debug' ? { type: 'helper' } : {}));
    await h.load([{ id: 'tab', type: 'tab' }].concat(flow), {}, h.ALL.concat(CORE));
    return flow;
}

/** Fire an inject node as if its button were clicked. */
const click = (id) => h.helper.getNode(id).receive({});

test('example flows load with all nodes resolvable', async () => {
    for (const f of fs.readdirSync(EXAMPLES_DIR).filter(f => f.endsWith('.json'))) {
        const flow = await loadExample(f);
        for (const n of flow) {
            assert.ok(h.helper.getNode(n.id), `${f}: node ${n.id} (${n.type}) failed to load`);
            if (n.type === 'dataops-in') assert.ok(n.specKey, `${f}: ${n.id} has no specKey`);
            for (const w of (n.wires || []).flat()) {
                assert.ok(flow.some(m => m.id === w), `${f}: ${n.id} wires to missing node ${w}`);
            }
        }
        await h.unload();
    }
});

test('example: manual specs normalize the sample injects', async () => {
    await loadExample('dataops-manual-specs.json', { debugAsHelper: true });
    click('ms-load');
    await new Promise(r => setTimeout(r, 50));

    const rec = async (injectId) => { const p = h.nextMessage('ms-dbg'); click(injectId); return (await p).payload; };
    assert.deepEqual(await rec('ms-temp-ok'), {
        name: 'plant/boiler/temp', type: 'number', value: 182.4,
        timestamp: Date.parse('2026-05-30T20:54:56.056+01:00'), quality: true
    });
    assert.equal((await rec('ms-temp-bad')).quality, false);
    assert.deepEqual(await rec('ms-state'), {
        name: 'plant/boiler/state', type: 'boolean', value: true, timestamp: 1780000000000, quality: true
    });
    const level = await rec('ms-level');
    assert.equal(level.value, 42);
    assert.equal(level.type, 'integer');

    const err = h.nextMessage('ms-err');
    click('ms-unknown');
    assert.match((await err).payload.error, /No spec for topic 'plant\/boiler\/unknown'/);
});

test('example: cache modes show wrapped entries and flat LRU eviction', async () => {
    await loadExample('dataops-cache-modes.json', { debugAsHelper: true });
    for (const id of ['cm-s1', 'cm-s2', 'cm-s3', 'cm-s1', 'cm-s4']) {
        click(id);
        await new Promise(r => setTimeout(r, 10));
    }
    const p = h.nextMessage('cm-dbg');
    click('cm-show');
    const { wrapped, flat } = (await p).payload;
    assert.deepEqual(Object.keys(wrapped).sort(), ['sensor/1', 'sensor/2', 'sensor/3', 'sensor/4']);
    assert.ok(wrapped['sensor/1'].previous, 'wrapped entries keep the previous value');
    // max 3: sensor/2 is the least-recently written once sensor/1 was re-sent.
    assert.deepEqual(Object.keys(flat), ['sensor/3', 'sensor/1', 'sensor/4']);
});

