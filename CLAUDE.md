# node-red-contrib-dataops

Node-RED contrib package for industrial data pipelines: context-dictionary cache, AI/heuristic normalization, second-resolution cron, run-time tracking.

Scope (2.0): split, combine and table were removed because core Node-RED split/join/debug cover them. Do not re-add equivalents, and keep QuestDB-specific output out of this package. See [CHANGELOG.md](CHANGELOG.md).

Full internals: [ARCHITECTURE.md](ARCHITECTURE.md). User docs: [README.md](README.md).

## Project Structure

```
nodes/
  dataops-in.js/.html         - "cache": write msg.payload into a context dict (wrapped | flat)
  dataops-transform.js/.html  - Apply per-topic JSONata specs → record or value output
  dataops-cron.js/.html       - 6-field cron trigger (second resolution)
  dataops-runtime.js/.html    - Run-flag runtime tracking, sampled rows
  dataops-claude.js/.html     - Cache samples → Claude → spec dict
  dataops-claude-api.js/.html - Config node (owns SDK client, complete()) + DataOps AI sidebar
lib/
  values.js                   - extractValue heuristic, entry unwrap, isTruthy, parseFields, triggerDate
  context.js                  - readDict/writeDict, /dataops/context/keys endpoint
  jsonata.js                  - prepare (lenient $eval/$fromJSON/$toMillis), evaluate
  anthropic.js                - @anthropic-ai/sdk client: streaming, retries, refusal → error
  coerce.js / toon.js / ctxkey.js
resources/dataops-ui.js       - Runtime editor field picker (served at resources/node-red-contrib-dataops/)
test/                         - node:test; nodes run in a real runtime via node-red-node-test-helper
examples/                     - Importable flows (all loaded by the test suite)
scripts/                      - Dev-only helpers for a local Node-RED (simulation tab); not published
```

## Commands

- `npm run examples:install`: add every example as a disabled "DataOps: …" tab in the Node-RED at :1880 (re-run replaces them; `-- --enabled` to start them enabled).
- `npm test`: the full suite. It needs no Node-RED instance and no API key. Run it after every change.
- `npm run deploy` / `deploy:patch|minor|major`: (bump +) `npm link` into Node-RED, then restart Node-RED.
- Release: bump `version` in package.json, commit, push tag `v<version>`. `publish.yml` runs `npm test`, checks tag = version, skips versions already on npm, and publishes via npm trusted publishing (OIDC; no NPM_TOKEN). Dist-tag: `-beta` → `beta`, `-rc` → `next`, else `latest`. Then refresh https://flows.nodered.org/add/node.
- Local publish needs a 2FA security key on the npm account (npm no longer accepts new TOTP). The `files` whitelist in package.json limits what ships.

## Architecture in brief

- **No shared runtime objects.** Nodes communicate through **context dictionaries** at `<scope>.<specKey>`.
  - Cache dict, written by `dataops-in`: `{topic: {payload, ts, metadata, previous}}` (wrapped) or `{topic: payload}` (flat). Read by claude and runtime.
  - Spec dict, written by `dataops-claude`: `{topic: {type, value, timestamp, quality, _meta}}`. Read by transform (default key `dataopsSpecs`).
- **Transform output** (`outputFormat`): `record` (default) → `msg.payload = {name, type, timestamp, value, quality}`; `value` → `msg.payload = value` plus `msg.topic/timestamp/quality/type` (feeds core join key/value).
- **Claude**: entries → TOON `samples[N]{topic,ts,payload}` → `apiConfig.complete()` → TOON `specs[M]{...}` (JSON fallback) → merged into spec dict.
- **DataOps AI sidebar** → `POST /dataops/claude/generate-flow` → `FLOW_SYSTEM_PROMPT` in `dataops-claude-api.js`.

## Conventions

- Shared logic goes in `lib/`. Never copy the value heuristic, context access, JSONata setup or field parsing into a node.
- Top-level context keys go through `sanitizeKey()`. Entry keys (topics, including runtime trigger/label keys) are used verbatim.
- Worker nodes have 2 outputs `[result, error]`. Errors go out as `{...msg, payload: {error}, _error: true}` plus `done(err)`. `dataops-in` has 1 output, and `dataops-cron` has no input.
- Handlers use the `(msg, send, done)` signature with 0.x fallbacks.
- Status: green ok, yellow missing config/heuristic, blue busy, red error. Palette category `'data ops'`.
- Claude API: the default model is `claude-opus-5-5`. Never send `temperature` unless the user set it (current models 400). `fallbacks: "default"` is on by default. All requests go through `lib/anthropic.js`.
- Tests: use `uniqueKey()` for context keys. Stub `helper.getNode(cfgId).complete` instead of calling the API.

## Adding or changing a node

1. `nodes/<name>.js` + `nodes/<name>.html` (editor template + help). Register it in `package.json` → `node-red.nodes`.
2. **Update `FLOW_SYSTEM_PROMPT`** in `dataops-claude-api.js` (fields and output count). `test/lib.test.js` checks that every node is listed.
3. Add tests to `test/nodes.test.js`, and an example if useful (examples are load-tested).
4. Update README.md and ARCHITECTURE.md.
5. `npm test`, then `npm run deploy` and restart Node-RED.

## License

MIT, see [LICENSE](LICENSE)
