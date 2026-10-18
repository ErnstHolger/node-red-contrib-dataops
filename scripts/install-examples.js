/**
 * Install every flow in examples/ into a running Node-RED as its own tab,
 * via the admin API (POST /flow per tab — existing flows are not redeployed).
 *
 *   node scripts/install-examples.js [--url http://127.0.0.1:1880] [--enabled] [--api-config <id>]
 *
 * - Tabs are labelled "DataOps: <example>"; re-running replaces them (PUT /flow/:id)
 *   and removes "DataOps: …" tabs whose example file no longer exists.
 * - Node ids are regenerated so examples never collide with existing nodes.
 * - Tabs are created DISABLED unless --enabled (several examples repeat every
 *   1–5 s and would flood the debug sidebar). Enable one at a time in the editor.
 * - dataops-claude nodes are pointed at an existing dataops-claude-api config
 *   (--api-config, else the first one found); example config nodes are dropped.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const BASE = opt('--url', 'http://127.0.0.1:1880').replace(/\/+$/, '');
const ENABLED = args.includes('--enabled');
const TOKEN = process.env.NODE_RED_TOKEN;
const EXAMPLES = path.join(__dirname, '..', 'examples');

const headers = Object.assign({ 'Content-Type': 'application/json', 'Node-RED-API-Version': 'v2' },
    TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {});

async function api(method, url, body) {
    const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
    return text ? JSON.parse(text) : null;
}

const newId = () => crypto.randomBytes(8).toString('hex');

function label(file) {
    return 'DataOps: ' + file.replace(/^dataops-/, '').replace(/\.json$/, '').replace(/-/g, ' ');
}

/** Regenerate ids, rewire, drop config nodes, attach the API config. */
function prepare(flow, apiConfigId) {
    const ids = new Map();
    const nodes = flow.filter(n => n.type !== 'dataops-claude-api' && n.type !== 'tab');
    for (const n of nodes) ids.set(n.id, newId());
    return nodes.map(n => {
        const c = Object.assign({}, n, { id: ids.get(n.id) });
        delete c.z;
        if (Array.isArray(c.wires)) c.wires = c.wires.map(port => port.map(w => ids.get(w)).filter(Boolean));
        if (c.type === 'dataops-claude') c.apiConfig = apiConfigId || '';
        return c;
    });
}

(async () => {
    const v2 = await api('GET', '/flows');
    const all = Array.isArray(v2) ? v2 : v2.flows;

    const apiConfig = opt('--api-config') || (all.find(n => n.type === 'dataops-claude-api') || {}).id;
    const existingTabs = new Map(all.filter(n => n.type === 'tab').map(n => [n.label, n.id]));

    const files = fs.readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).sort();

    // Remove "DataOps: …" tabs whose example file no longer exists.
    const wanted = new Set(files.map(label));
    for (const [tabLabel, tabId] of existingTabs) {
        if (tabLabel.startsWith('DataOps: ') && !wanted.has(tabLabel)) {
            await api('DELETE', `/flow/${tabId}`);
            existingTabs.delete(tabLabel);
            console.log(`removed   ${tabLabel}`);
        }
    }

    for (const file of files) {
        const flow = JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), 'utf8'));
        const nodes = prepare(flow, apiConfig);
        const info = (flow.find(n => n.type === 'comment' && n.info) || {}).info || '';
        const tab = { label: label(file), disabled: !ENABLED, info, nodes, configs: [] };

        const existing = existingTabs.get(tab.label);
        if (existing) {
            await api('PUT', `/flow/${existing}`, Object.assign({ id: existing }, tab));
            console.log(`replaced  ${tab.label}  (${nodes.length} nodes)`);
        } else {
            const r = await api('POST', '/flow', tab);
            console.log(`installed ${tab.label}  (${nodes.length} nodes) → ${r.id}`);
        }
    }
    if (!apiConfig) console.log('note: no dataops-claude-api config found; set one on the claude example');
})().catch(err => { console.error(err.message); process.exit(1); });
