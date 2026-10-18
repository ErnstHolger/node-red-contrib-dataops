'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { coerce, inferType } = require('../lib/coerce');
const toon = require('../lib/toon');
const { sanitizeKey } = require('../lib/ctxkey');
const values = require('../lib/values');
const { toMillis, fromJSON } = require('../lib/jsonata');
const anthropic = require('../lib/anthropic');
const claudeApiModule = require('../nodes/dataops-claude-api');
const claudeModule = require('../nodes/dataops-claude');

test('coerce handles aliases and failures', () => {
    assert.equal(coerce('3.5', 'double'), 3.5);
    assert.equal(coerce('3.9', 'int'), 3);
    assert.equal(coerce('abc', 'number'), null);
    assert.equal(coerce('on', 'bool'), true);
    assert.equal(coerce('off', 'boolean'), false);
    assert.equal(coerce({ a: 1 }, 'string'), '{"a":1}');
    assert.deepEqual(coerce('{"a":1}', 'json'), { a: 1 });
    assert.equal(coerce(undefined, 'number'), null);
    assert.equal(inferType(2), 'integer');
    assert.equal(inferType(2.5), 'number');
});

test('toon round-trips tables with quoting and JSON cells', () => {
    const enc = toon.encodeTable('samples', ['topic', 'ts', 'payload'], [
        { topic: 'plant/a, b', ts: 1, payload: { value: 2 } },
        { topic: 'plant/c', ts: 2, payload: true }
    ]);
    const dec = toon.decodeTable('```toon\n' + enc + '\n```');
    assert.equal(dec.count, 2);
    const rows = toon.rowsToObjects(dec);
    assert.equal(rows[0].topic, 'plant/a, b');
    assert.deepEqual(JSON.parse(rows[0].payload), { value: 2 });
    assert.equal(rows[1].payload, true);
});

test('sanitizeKey makes context-safe keys', () => {
    assert.equal(sanitizeKey('my cache'), 'my_cache');
    assert.equal(sanitizeKey('plant.a/b'), 'plant_a_b');
    assert.equal(sanitizeKey(null), '');
});

test('extractValue walks OPC UA / Kepware / Sparkplug / scalar payloads', () => {
    assert.equal(values.extractValue({ value: { value: 1 } }), 1);
    assert.equal(values.extractValue({ value: 2 }), 2);
    assert.equal(values.extractValue({ v: 3 }), 3);
    assert.equal(values.extractValue(4), 4);
    assert.deepEqual(values.extractValue([1, 2]), [1, 2]);
});


test('entryValue unwraps wrapped and flat entries', () => {
    const wrapped = { payload: { value: { value: 7 } }, ts: 1, metadata: {} };
    assert.equal(values.entryValue(wrapped), 7);
    const record = { name: 'x', type: 'integer', timestamp: 1, value: '9', quality: true };
    assert.equal(values.entryValue(record), '9');
    assert.equal(values.entryValue(undefined), null);
});

test('isTruthy treats run flags sensibly', () => {
    for (const v of [true, 1, '1', 'true', 'ON', 'yes']) assert.equal(values.isTruthy(v), true, String(v));
    for (const v of [false, 0, '0', 'false', 'off', '', null, undefined, NaN]) assert.equal(values.isTruthy(v), false, String(v));
});

test('parseFields accepts JSON and migrates legacy keys', () => {
    assert.deepEqual(values.parseFields('[{"topic":"a/b","alias":"ab"},{"topic":"c"}]'),
        [{ topic: 'a/b', alias: 'ab' }, { topic: 'c', alias: 'c' }]);
    assert.deepEqual(values.parseFields('[]', 'x, y'), [{ topic: 'x', alias: 'x' }, { topic: 'y', alias: 'y' }]);
    assert.deepEqual(values.parseFields('not json', ''), []);
});

test('triggerDate prefers _epoch, then timestamp, then now', () => {
    assert.equal(values.triggerDate({ _epoch: 1000, timestamp: '2020-01-01T00:00:00Z' }).getTime(), 1000);
    assert.equal(values.triggerDate({ timestamp: '2020-01-01T00:00:00Z' }).getTime(), Date.UTC(2020, 0, 1));
    assert.ok(Math.abs(values.triggerDate({ timestamp: 'garbage' }).getTime() - Date.now()) < 1000);
});

test('lenient $toMillis / $fromJSON', () => {
    assert.equal(toMillis('2026-05-30 20:54:56.056+0100'), Date.parse('2026-05-30T20:54:56.056+01:00'));
    assert.equal(toMillis(123), 123);
    assert.equal(toMillis('nope'), undefined);
    assert.deepEqual(fromJSON('{"a":1}'), { a: 1 });
    const obj = { a: 1 };
    assert.equal(fromJSON(obj), obj);
});

test('anthropic.buildParams only sends optional params when set', () => {
    const p = anthropic.buildParams({ model: '', maxTokens: 0 }, { systemPrompt: ' ', userPrompt: 'hi' });
    assert.equal(p.model, anthropic.DEFAULT_MODEL);
    assert.equal(p.max_tokens, anthropic.DEFAULT_MAX_TOKENS);
    assert.equal('system' in p, false);
    assert.equal('temperature' in p, false);
    assert.equal('output_config' in p, false);
    assert.equal('fallbacks' in p, false);

    const q = anthropic.buildParams(
        { model: 'claude-sonnet-4-6', maxTokens: 100, temperature: '0.2', effort: 'HIGH', fallbacks: true },
        { systemPrompt: 'sys', userPrompt: 'hi' });
    assert.equal(q.system, 'sys');
    assert.equal(q.temperature, 0.2);
    assert.deepEqual(q.output_config, { effort: 'high' });
    assert.equal(q.fallbacks, 'default');
    assert.deepEqual(q.betas, ['server-side-fallback-2026-07-01']);
});

test('anthropic.normalizeBaseURL strips legacy /v1 suffix', () => {
    assert.equal(anthropic.normalizeBaseURL('https://api.anthropic.com/v1/'), 'https://api.anthropic.com');
    assert.equal(anthropic.normalizeBaseURL('https://proxy.local/anthropic'), 'https://proxy.local/anthropic');
    assert.equal(anthropic.normalizeBaseURL(''), undefined);
    assert.equal(anthropic.isAnthropicBaseURL(''), true);
    assert.equal(anthropic.isAnthropicBaseURL('https://api.anthropic.com/v1'), true);
    assert.equal(anthropic.isAnthropicBaseURL('https://api.deepseek.com/anthropic'), false);
});

test('anthropic.complete raises on refusal and joins text blocks', async () => {
    const fakeClient = (message) => ({
        messages: { stream: () => ({ finalMessage: async () => message }) },
        beta: { messages: { stream: () => ({ finalMessage: async () => message }) } }
    });
    const ok = await anthropic.complete(fakeClient({
        model: 'm', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 },
        content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }]
    }), {}, { userPrompt: 'x' });
    assert.equal(ok.text, 'a\nb');
    assert.deepEqual(ok.usage, { input_tokens: 1, output_tokens: 2 });

    await assert.rejects(anthropic.complete(fakeClient({
        model: 'm', stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: {}, content: []
    }), { fallbacks: true }, { userPrompt: 'x' }), /declined.*cyber/);
});

test('flow generator prompt matches node field names', () => {
    const p = claudeApiModule.FLOW_SYSTEM_PROMPT;
    assert.doesNotMatch(p, /dataops-(split|combine|table)|questdb/i);
    assert.match(p, /storeMode/);
    assert.match(p, /outputFormat/);
    // Every registered node type (except the config node) must be described.
    const registered = Object.keys(require('../package.json')['node-red'].nodes).filter(t => t !== 'dataops-claude-api');
    for (const t of registered) assert.match(p, new RegExp(`## ${t}\\b`), t);
});

test('parseFlowJson filters config/tab nodes and substitutes apiConfig', () => {
    const flow = claudeApiModule.parseFlowJson('```json\n' + JSON.stringify([
        { id: 'a', type: 'dataops-claude', apiConfig: '__API_CONFIG_ID__', z: 'tab1', wires: [[], []] },
        { id: 'b', type: 'dataops-claude-api' },
        { id: 't', type: 'tab' },
        { type: 'debug' }
    ]) + '\n```', 'cfg1');
    assert.equal(flow.length, 1);
    assert.equal(flow[0].apiConfig, 'cfg1');
    assert.equal('z' in flow[0], false);
    assert.equal(claudeApiModule.parseFlowJson('not json', 'x'), null);
});

test('default prompt is structured and its example round-trips', () => {
    const p = claudeModule.DEFAULT_SYSTEM_PROMPT;
    for (const h of ['# Role', '# How your specs are used', '# Input', '# Output', '# Column rules',
        '## 1. type', '## 2. value', '## 3. timestamp', '## 4. quality', '## 5. unit', '## 6. description',
        '# Example', '# Before you answer, check']) {
        assert.ok(p.includes(h), `missing section ${h}`);
    }
    assert.match(p, /specs\[M\]\{topic,type,value,timestamp,quality,unit,description\}/);
    // The example output in the prompt parses back to exactly EXAMPLE_SPECS.
    const out = p.slice(p.indexOf('Output:', p.indexOf('# Example')));
    const { dict } = claudeModule.parseSpecResponse(out);
    for (const s of claudeModule.EXAMPLE_SPECS) {
        const got = dict[s.topic];
        assert.ok(got, s.topic);
        for (const k of ['type', 'value', 'timestamp', 'unit', 'description']) assert.equal(got[k], s[k], `${s.topic}.${k}`);
        assert.equal(String(got.quality), s.quality, `${s.topic}.quality`);
    }
});

test('parseSpecResponse keeps optional unit/description columns', () => {
    const { dict } = claudeModule.parseSpecResponse(
        'specs[2]{topic,type,value,timestamp,quality,unit,description}:\n' +
        '  a/p,number,payload.value,$millis(),true,bar,"Line pressure"\n' +
        '  a/b,boolean,payload.v,$millis(),true,,');
    assert.equal(dict['a/p'].unit, 'bar');
    assert.equal(dict['a/p'].description, 'Line pressure');
    assert.equal('unit' in dict['a/b'], false);
    assert.equal('description' in dict['a/b'], false);
});

test('parseSpecResponse reads TOON and JSON fallback', () => {
    const t = claudeModule.parseSpecResponse('specs[1]{topic,type,value,timestamp,quality}:\n  "a/b",number,payload.value,$millis(),true');
    assert.equal(t.format, 'toon');
    assert.deepEqual(t.dict['a/b'], { type: 'number', value: 'payload.value', timestamp: '$millis()', quality: true });
    const j = claudeModule.parseSpecResponse('```json\n{"x":{"type":"string","value":"payload"}}\n```');
    assert.equal(j.format, 'json-fallback');
    assert.throws(() => claudeModule.parseSpecResponse('hello'), /Could not parse/);
});


