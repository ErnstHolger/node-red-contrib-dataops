# Architecture — node-red-contrib-dataops

## Overview

DataOps is a Node-RED contrib package for building data pipelines for industrial and IIoT data. Nodes share state through **context dictionaries**. A context dictionary is a plain object stored in Node-RED `global` or `flow` context at a configurable **Spec Key**. Two kinds of dictionary flow through a pipeline:

| Dictionary | Written by | Read by | Shape |
|---|---|---|---|
| **Cache** (samples or latest values) | `dataops-in` | `dataops-claude` (source), `dataops-runtime` | `{ <topic>: entry }` |
| **Spec** (per-topic normalization rules) | `dataops-claude` (or by hand) | `dataops-transform` | `{ <topic>: {type, value, timestamp, quality} }` |

Context is visible in the editor's Context sidebar and persists across restarts if a persistent context store is configured. Nodes have no other shared runtime state: no cache config node, no EventEmitter and no pub/sub.

```
                 ┌─────────────┐
 [mqtt/opcua] ──▶│ dataops-in  │── writes ──▶ cache dict (<scope>.<specKey>)
                 └─────────────┘                    │
                                     ┌──────────────┴──────┐
                                     ▼                     ▼
 [cron/inject] ──▶ ┌──────────────────┐        ┌─────────────────┐
                   │  dataops-claude  │        │ dataops-runtime │──▶ sampled rows
                   └────────┬─────────┘        └─────────────────┘
                            │ writes spec dict
                            ▼
 [live msgs] ──▶ ┌──────────────────┐
                 │dataops-transform │──▶ record or value ──▶ core join / debug / database
                 └──────────────────┘
```

`dataops-cron` is a trigger source with second resolution. It drives `dataops-runtime` and `dataops-claude` on a schedule. Merging and exploding messages is left to the core **join** and **split** nodes, and inspection to the core **debug** node. The package removed its own split, combine and table nodes in 2.0.

The one config node is **dataops-claude-api**. It holds the Claude API settings, owns the SDK client, and hosts the DataOps AI sidebar endpoints.

All nodes appear in the palette category **data ops**. Palette labels: `cache` (dataops-in), `transform`, `claude`, `cron`, `runtime`.

---

## Module Layout

```
nodes/          one .js (runtime) + .html (editor + help) per node
lib/
  values.js     payload heuristic, entry unwrapping, truthiness, field lists, trigger time
  context.js    read/write context dictionaries; /dataops/context/keys admin endpoint
  jsonata.js    compile with lenient $eval/$fromJSON/$toMillis; evaluate helpers
  anthropic.js  Claude client on @anthropic-ai/sdk (streaming, retries, refusal handling)
  coerce.js     coerce(value, type) / inferType(value)
  toon.js       TOON tabular encoder/decoder
  ctxkey.js     sanitizeKey()
resources/
  dataops-ui.js editor code for the runtime node's topic/alias picker, served by Node-RED
test/           node:test suites; nodes run in a real runtime via node-red-node-test-helper
examples/       importable flows (each is loaded by the test suite)
scripts/        dev-only helpers for a local Node-RED (not published)
```

Logic that more than one node needs lives in `lib/`. Nodes contain only their own behavior.

---

## Transform Output

`dataops-transform` emits one of two shapes, chosen by its **Output** setting.

**record** (default): `msg.payload` is the canonical record:

```js
{
  name:      "plant/HWS/Denis/temperature",
  type:      "number",        // number | integer | string | boolean | object
  timestamp: 1716636000000,   // epoch ms
  value:     25.4,            // coerced to declared type
  quality:   true             // boolean or string
}
```

**value**: `msg.payload = value`, with `msg.topic = name`, `msg.timestamp`, `msg.quality` and `msg.type`. This is the idiomatic Node-RED shape and feeds the core join node in key/value mode directly.

Both shapes are understood by `entryValue()` when cached with `dataops-in` (flat).

---

## Shared Conventions

**Context keys.** Every top-level key a user types (Spec Key, Source Key) goes through `sanitizeKey()`: it is trimmed and every character outside `[A-Za-z0-9_]` becomes `_`. Node-RED's `context.get/set` parses keys as property expressions, so `"my cache"` or `"plant.a"` would otherwise throw. Every node applies the same function, so they all resolve the same dictionary.

**Entry keys** inside a dictionary (topics such as `plant/HWS/temp`) are stored and looked up verbatim. This includes `dataops-runtime`'s Trigger and Label keys.

**Scope.** `lib/context.js` maps `'flow'` to flow context and anything else to global.

**Value heuristic.** `lib/values.extractValue` is the single implementation, used by transform (fallback) and runtime: `payload.value.value` (OPC UA Variant) → `payload.value` (Kepware / canonical record) → `payload.v` (Sparkplug B) → `payload`. `entryValue(entry)` first strips a wrapped `{payload, ts, …}` envelope.

**Message key.** `keyField` accepts `topic` or `msg.topic` in `dataops-in` and `dataops-transform`.

**Trigger time.** `dataops-runtime` takes time from the trigger message: `msg._epoch` (set by dataops-cron), then `msg.timestamp` (ISO or epoch), then now.

**Outputs.** Worker nodes have two outputs `[result, error]`. Errors go out as `{...msg, payload: {error, ...}, _error: true}` and are also reported through `done(err)`, so Catch nodes see them. `dataops-in` has one pass-through output, and `dataops-cron` has no input.

**Status colors.** Green = ready/ok, yellow = missing config or heuristic fallback, blue = API call in progress or runtime counting, red = error.

---

## Component Details

### dataops-in (palette: "cache")

**Role**: Write each `msg.payload` into the cache dictionary at `<specScope>.<specKey>`, keyed by `msg[keyField]` (default `topic`; numbers are stringified). The message passes through unchanged.

| `storeMode` | Entry stored | Use |
|---|---|---|
| `wrapped` (default) | `{ payload, ts, metadata: {_msgid, originalTopic}, previous }` | Raw ingest, used as the `dataops-claude` source. `previous` holds the prior entry. |
| `flat` | `msg.payload` as-is | Latest-value cache for `dataops-runtime` |

**Bounds**:
- `maxEntries` (0 = unbounded): true LRU. Each write deletes and re-inserts the key, so object insertion order equals recency, and the oldest keys are evicted. Integer-like keys are the exception, because JS objects always enumerate them first.
- `ttl` ms (0 = none): wrapped mode only. A timer running every `min(ttl, 60s)` purges entries whose `ts` is older than `ttl`. In flat mode the node shows a yellow "TTL ignored" status.

Each message does a read-modify-write of the whole dictionary. There is no debounce.

---

### dataops-transform

**Role**: Normalize each message using its topic's spec from `<specScope>.<specKey>` (default `dataopsSpecs`).

```js
{
  "plant/HWS/Denis/temp": {
    type:      "number",
    value:     "payload.value.value",
    timestamp: "$toMillis(payload.sourceTimestamp)",
    quality:   "payload.statusCode = 0",
    _meta:     { generated_at, model, format }    // added by dataops-claude, ignored here
  }
}
```

The dictionary key is the canonical `name`. `value`, `timestamp` and `quality` are JSONata expressions evaluated against the whole `msg` (compiled through `lib/jsonata`, so the lenient functions below apply). Missing expressions default to `msg.payload`, now and `true`, and the value is coerced to `type`.

**Compiled cache**: `Map<topic, {sig, value, timestamp, quality}>`, recompiled when `JSON.stringify(spec)` changes. Spec updates take effect without a redeploy.

**Fallback modes** (no spec for the topic):

| Mode | Behavior |
|---|---|
| `heuristic` (default) | `extractValue(payload)`, infer type, timestamp = numeric `msg.timestamp` or now, quality = `msg.quality` or `true` |
| `passthrough` | Original message to output 2 |
| `error` | Error to output 2 |

Output 1 is the original `msg` with the result in the configured shape (see [Transform Output](#transform-output)) and `_spec` = `"spec"` or `"heuristic"`.

---

### dataops-cron

**Role**: Schedule a trigger with a 6-field cron expression (`sec min hour dom mon dow`). Each field supports `*`, `a`, `a-b`, `a-b/n`, `*/n` and lists. Day-of-week `7` means Sunday. If both day-of-month and day-of-week are restricted, matching either one fires the trigger.

A 250 ms timer fires at most once per wall-clock second, with times anchored to the second boundary. An invalid expression puts a red status on the node and disables it.

Output 1: `{payload (per payloadType), timestamp: ISO, _epoch: ms, _cron, _tick, topic?}`. Output 2: payload-build errors, such as invalid JSON.

---

### dataops-runtime

**Role**: Emit sampled rows while a run flag is active, with the elapsed runtime.

1. `on = isTruthy(entryValue(dict[triggerKey]))`. The trigger key is used verbatim, and wrapped or canonical entries are unwrapped. Truthy values: `true`, non-zero numbers, `"true"`/`"1"`/`"yes"`/`"on"`.
2. A false → true transition records the start time.
3. While the flag is on, the node emits once `sampling` seconds have passed since the start, then at most once per `sampling` seconds. `0` means every input.
4. Row: `{timestamp, runtime: seconds since start, label: entryValue(dict[labelKey]), <alias>: value, ...}`, sent as `msg.payload = [row]` with `_runtime: {runtime, startedAt}`.

Times come from the trigger message. Run state is held in memory and resets on redeploy or when the flag goes off.

---

### dataops-claude-api (Config Node)

| Property | Default | Notes |
|---|---|---|
| `apiKey` (credential) | — | Encrypted by Node-RED |
| `model` | `claude-opus-5-5` | Saved configs keep their saved model |
| `effort` | model default | `output_config.effort`: low / medium / high / xhigh / max |
| `maxTokens` | 16384 | Includes thinking |
| `temperature` | not sent | Only sent when set. Current models reject sampling parameters with a 400. |
| `fallbacks` | on | Sends `fallbacks: "default"` with beta `server-side-fallback-2026-07-01` so a policy decline is retried server-side. Older configs without the property default to on. |
| `baseUrl` | Anthropic API | A legacy trailing `/v1` is stripped |

The node exposes `complete({systemPrompt, userPrompt})` and `hasApiKey()`. It creates the SDK client lazily on first use.

**DataOps AI sidebar**: a tab registered by the config node's `.html`. The user describes a pipeline, and the server calls Claude with `FLOW_SYSTEM_PROMPT`, which documents every node's fields and output count. The result is parsed tolerantly (bare or fenced array). Config and tab nodes and nodes without an id or type are dropped, `apiConfig` is set on `dataops-claude` nodes and `z` is removed. The user then imports the flow with `RED.view.importNodes(..., {generateIds: true})`.

| Endpoint | Permission | Purpose |
|---|---|---|
| `GET /dataops/claude/configs` | `flows.read` | List deployed config nodes |
| `POST /dataops/claude/generate-flow` | `flows.write` | `{configId, description}` → `{flow, usage, model}` |

---

### dataops-claude (palette: "claude")

**Role**: Turn cache samples into per-topic specs.

1. Read `<sourceScope>.<sourceKey>`. Wrapped entries contribute `{payload, ts, metadata}`, and bare values are accepted. If the source is empty and there is no custom prompt, the node errors without calling the API.
2. Encode up to `maxSampleRows` (default 250) as TOON `samples[N]{topic,ts,payload}`.
3. Build the user prompt, unless a non-empty string in `msg.payload` replaces it.
4. Call `apiConfig.complete(...)`. API errors and refusals go to output 2 with a readable reason.
5. Parse TOON `specs[M]{topic,type,value,timestamp,quality,unit,description}`, or fall back to a JSON object. `unit` and `description` are optional and stored for reference only. A parse failure reports truncation or missing answer text.
6. Merge into `<specScope>.<specKey>`. Topics missing from the response are kept, and each new spec gets `_meta: {generated_at, model, format}`.
**Default system prompt** (`DEFAULT_SYSTEM_PROMPT`, used when the System Prompt field is empty): Markdown sections Role → How your specs are used → Input → Output → Column rules (one lookup table per column) → Example → Checklist. The worked example is generated with `toon.encodeTable` from `EXAMPLE_SAMPLES` / `EXAMPLE_SPECS`, and a test runs every example spec through a real transform node, so the prompt can't teach a broken expression. The editor fetches the prompt from `GET /dataops/claude/default-prompt` (`flows.read`) for its **Load default** button.

7. Output 1 sends one message per spec: `{topic, payload: spec, _claude: {model, usage, duration_ms, cache_size, stop_reason}}`.

---

## Shared Libraries

### lib/anthropic.js

Built on the official `@anthropic-ai/sdk`.

- `createClient({apiKey, baseUrl, timeoutMs = 300000, maxRetries = 2})`. The SDK retries 408/409/429/5xx and connection errors.
- `complete(client, settings, {systemPrompt, userPrompt})` streams the response (`messages.stream(...).finalMessage()`, or `beta.messages.stream` when fallbacks are on). It throws on `stop_reason: "refusal"` and otherwise returns `{content, text, model, usage, stop_reason, stop_details}`, where `text` joins the text blocks.
- `buildParams()` adds optional fields only when set. `describeError()` produces readable messages for SDK error classes.

### lib/jsonata.js

`prepare(RED, node, expr)` compiles with `RED.util.prepareJSONataExpression` and binds:
- `$eval` / `$fromJSON`: tolerant JSON parse. Strings are parsed and anything else passes through. Claude sees object payloads as JSON strings in the TOON samples and often writes `$eval(payload)`.
- `$toMillis`: accepts a space separator and `+HHMM` offsets, falls back to `Date.parse`, passes numbers through, and returns `undefined` instead of throwing.

`evaluate()` returns a promise that rejects on evaluation errors.

### lib/values.js, lib/context.js

See [Shared Conventions](#shared-conventions). `context.registerKeysEndpoint(RED)` registers `GET /dataops/context/keys?scope=&key=&z=` (`flows.read`) once per admin app. It reaches context through a live node (any node for global scope, a node on flow `z` for flow scope), so the flow must be deployed.

### lib/toon.js

Minimal tabular format: `name[N]{col1,col2,...}:` followed by indented comma rows. Numbers, booleans and `null` are bare. Strings with commas, quotes or whitespace are quoted with backslash escapes. Objects and arrays are JSON-stringified into a quoted cell. The decoder strips one markdown fence, skips text before the header and treats an empty cell as `null`.

### lib/coerce.js

`coerce(value, type)` returns `null` instead of throwing. It handles number (double/float/real), integer (int/long/short, truncated), boolean (bool; true/false, 1/0, yes/no, on/off), string (text/char; objects are JSON-encoded) and object (json; strings are parsed). Unknown types pass the value through. `inferType(value)` returns the runtime type tag.

---

## Editor Code

`resources/dataops-ui.js` is served by Node-RED (1.3+) at `resources/node-red-contrib-dataops/dataops-ui.js` and included by `dataops-runtime.html`. `DataOpsUI.fieldPicker(node)` renders the topic/alias picker from `/dataops/context/keys`, keeps saved selections visible before a refresh, and stores `[{topic, alias}]` in the hidden `fields` input.

---

## Data Flow Patterns

### AI-assisted normalization
```
[sensors] → dataops-in (wrapped, key=rawCache)
[cron/inject] → dataops-claude (source=rawCache, spec=dataopsSpecs)
[live msgs] → dataops-transform (spec=dataopsSpecs) → [database]
```

### Batch/run tracking
```
[tags incl. run flag] → dataops-transform → dataops-in (flat, key=plant)
dataops-cron (* * * * * *) → dataops-runtime (trigger=line/1/running, label=line/1/batch, sampling=60)
```

### Heuristic-only normalization (no API key)
```
[messages] → dataops-transform (fallback=heuristic) → [database]
```

### Merge tags into one object (core join)
```
[messages] → dataops-transform (output=value) → join (key/value, count N) → [database]
```

---

## Concurrency & Memory

- Single-threaded event loop. `dataops-in` does a synchronous read-modify-write per message, so many writers to one key are safe with the in-memory context store.
- JSONata evaluation and Claude calls are async. A slow Claude call does not block transform.
- Unbounded structures: transform compiled cache (cleared on close) and cache dictionaries when `maxEntries` = 0.
- In-memory node state is lost on redeploy: cron tick count, runtime run state.

---

## Testing

`npm test` runs `node --test` over `test/*.test.js`:
- `lib.test.js`: pure functions in `lib/`, request building, refusal handling, prompt/field consistency, flow parsing, spec parsing.
- `nodes.test.js`: every node inside a real Node-RED runtime via `node-red-node-test-helper`. The `dataops-claude` tests stub the config node's `complete()`, so no API key is needed. Every flow in `examples/` must load.

Use a unique context key per test (`uniqueKey()`), because in-memory global context persists across loads within a run.
