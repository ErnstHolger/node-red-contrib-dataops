# node-red-contrib-dataops

Node-RED nodes for industrial data pipelines. Cache incoming tags in a context dictionary, normalize them with AI-generated or heuristic rules, schedule work to the second, and track machine or batch run times.

## Installation

```bash
npm install node-red-contrib-dataops
```

Or use the Node-RED palette manager and search for `node-red-contrib-dataops`.

**Requires Node.js >= 18 and Node-RED >= 2.0.** The Claude nodes are optional and need an Anthropic API key. Everything else works without one.

> **Upgrading from 1.x?** Version 2.0 removes `dataops-split`, `dataops-combine` and `dataops-table`. See [CHANGELOG.md](CHANGELOG.md) for replacements.

## How it fits together

Nodes share data through **context dictionaries**: plain objects in Node-RED `global` or `flow` context, at a key you choose (the *Spec Key*). You can inspect them in the editor's Context sidebar.

- `dataops-in` writes a **cache** dictionary: `{ <topic>: latest value or sample }`.
- `dataops-claude` reads the cache and writes a **spec** dictionary: `{ <topic>: JSONata rules }`.
- `dataops-transform` reads specs, and `dataops-runtime` reads the cache.

Keys are sanitized (`my cache` → `my_cache`), so the same name typed into different nodes always lines up.

To merge or explode messages, use the core **join** and **split** nodes. To inspect output, use the core **debug** node.

## Nodes

All nodes are in the **data ops** palette category.

### cache (`dataops-in`)
Stores `msg.payload` in a context dictionary keyed by `msg.topic` (configurable). The message passes through unchanged.
- **wrapped** mode stores `{payload, ts, metadata, previous}`. Use it as the sample source for `dataops-claude`.
- **flat** mode stores the payload as-is, as a clean latest-value cache for `runtime`.
- Optional **Max Entries** (LRU eviction) and **TTL** (wrapped mode only).

### transform (`dataops-transform`)
Normalizes each message with its topic's spec from the spec dictionary:
```js
{ "plant/HWS/temp": { type: "number", value: "payload.value.value",
                      timestamp: "$toMillis(payload.sourceTimestamp)", quality: "payload.statusCode = 0" } }
```
- `value`, `timestamp` and `quality` are JSONata expressions evaluated against `msg`. The value is coerced to `type`.
- `$toMillis` accepts common device timestamp formats, and `$eval`/`$fromJSON` work on parsed objects.
- Without a spec, the **heuristic** fallback walks `payload.value.value` → `payload.value` → `payload.v` → `payload`. That covers OPC UA, Kepware and Sparkplug B payloads with no setup. The other fallbacks are **passthrough** and **error**.
- **Output** is configurable:
  - **record** (default): `msg.payload = {name, type, timestamp, value, quality}`.
  - **value**: `msg.payload` is the value, with `msg.topic`, `msg.timestamp`, `msg.quality` and `msg.type` set. This form works directly with core `join` (key/value mode).
- Spec changes take effect on the next message, with no redeploy.

### cron (`dataops-cron`)
Fires on a 6-field cron schedule (`sec min hour dom mon dow`), for example `*/10 * * * * *` for every 10 seconds. Core inject can only schedule to the minute. Output times fall exactly on the second, and `msg.timestamp` (ISO) and `msg._epoch` carry the tick time. The payload can be a timestamp, date, string, number, boolean or JSON.

### runtime (`dataops-runtime`)
For batch and run tracking. While a run-flag topic in the cache is true, it emits a row at most once per *sampling* seconds. Each row has:
- `timestamp`
- `runtime`: seconds since the flag went true
- `label`: optional, e.g. a batch id
- the fields you selected

Trigger and label are topics such as `line/1/running`. Wrapped or normalized entries are unwrapped automatically.

### claude (`dataops-claude`)
Sends cache samples to Claude and writes the per-topic normalization specs it returns into the spec dictionary for `transform`.
- **Built-in prompt**: used when the System Prompt box is empty. It's a structured rulebook covering payload styles (OPC UA, Kepware, Sparkplug B, nested and array JSON), timestamps (date strings, epoch s/ms/µs) and quality (OPC UA status codes, OPC DA numeric quality, quality text), with a worked example. **Load default** copies it into the box to read or customize, and **Reset to built-in** clears it.
- Each spec also gets a `unit` and a short `description` for reference. Transform ignores both.
- Samples are encoded as TOON, a compact table format, to save tokens. Existing specs for other topics are kept.
- Uses the official Anthropic SDK with streaming and automatic retries. API errors, refusals and truncated replies are reported on output 2.
- An empty source dictionary is reported as an error, without an API call.
- A string in `msg.payload` overrides the generated prompt.

### Claude API config (`dataops-claude-api`)
Holds the Anthropic API key (encrypted) and request settings:
- **Model**: default `claude-opus-5-5`.
- **Effort**: optional thinking depth.
- **Max tokens**: default 16384.
- **Refusal fallback**: on by default for the Anthropic API; retries a policy decline on a fallback model, server-side.
- **Base URL**: only needed for a proxy or gateway.
- **Temperature**: optional and sent only when set. Leave it empty for current models, which reject it.

**DataOps AI sidebar**: once a config node is deployed, open the *DataOps AI* sidebar tab, describe a pipeline in plain English, and import the generated flow onto the canvas.

## Quick Start

### Heuristic normalization (no API key)
```
[mqtt in] → transform (heuristic) → debug
```

### AI-assisted normalization
```
[mqtt in] → cache (wrapped, key: rawCache)
[inject]  → claude (source: rawCache, spec: dataopsSpecs)
[mqtt in] → transform (spec: dataopsSpecs) → [database]
```

### Merge normalized tags into one object
```
[mqtt in] → transform (output: value) → join (key/value, count N) → [database]
```

### Batch runtime tracking
```
[mqtt in] → transform → cache (flat, key: line1)
cron (* * * * * *) → runtime (trigger: line/1/running, label: line/1/batch, sampling: 60) → [database]
```

## Example Flows

| File | Description |
|---|---|
| `examples/dataops-claude-pipeline.json` | AI: sensor injects → wrapped cache → claude generates specs → transform applies them |
| `examples/dataops-manual-specs.json` | Hand-written spec dictionary (no API key): lenient `$toMillis`, bad OPC UA status → quality false, string → integer, unknown topic → error output |
| `examples/dataops-runtime-tracking.json` | Simulated line (60 s run / 30 s stop) → cache; cron every 1 s → runtime rows with batch label every 10 s |
| `examples/dataops-cron-schedules.json` | Five common 6-field cron expressions with different payload types |
| `examples/dataops-cache-modes.json` | Wrapped (TTL 30 s) vs flat (max 3, LRU) caches side by side, with a button to inspect both |

Import them with **Import → Examples → node-red-contrib-dataops** in the editor, or import a file from `examples/`. Each flow has a comment node explaining what to click and what to look for.

**Tip:** heuristic mode infers each value's type separately, so a float reading of `1013.0` comes out as `integer`. When downstream types must stay stable (such as database columns), declare the types in a spec dictionary.

## Development

```bash
npm run deploy            # npm link into Node-RED
npm run deploy:patch      # bump patch + link
npm test                  # unit + node tests (node:test, no Node-RED instance or API key needed)
npm run examples:install  # add the examples as disabled tabs in the Node-RED at :1880
```

Restart Node-RED after code changes. See [ARCHITECTURE.md](ARCHITECTURE.md) for internals.

### Publishing

1. Bump `version` in `package.json` and commit.
2. Push a matching tag: `git tag v2.1.0 && git push origin v2.1.0`.

`.github/workflows/publish.yml` then runs the tests, checks the tag matches `package.json`, and publishes to npm through **trusted publishing** (no token, no 2FA prompt). The dist-tag follows the version: `-beta` → `beta`, `-rc` → `next`, otherwise `latest`. A version that's already on npm is skipped.

One-time setup on npmjs.com: package **Settings → Trusted Publisher → GitHub Actions**, repository `ErnstHolger/node-red-contrib-dataops`, workflow `publish.yml`.

After a release, refresh the Flow Library entry at [flows.nodered.org/add/node](https://flows.nodered.org/add/node).

## License

MIT, see [LICENSE](LICENSE)
