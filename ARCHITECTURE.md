# Architecture — node-red-contrib-dataops

## Overview

DataOps is a Node-RED contrib package for building data pipeline workflows. The core idea: stream messages into a central cache, then normalize, split, and combine them using either configuration-driven rules or AI-generated processing specifications. All worker nodes operate on a **canonical narrow record shape** and can be chained to form complete pipelines.

```
┌──────────┐    ┌─────────────────┐    ┌──────────┐
│ dataops-in │──▶│  dataops-cache   │◀───│ dataops-in │
└──────────┘    │  (config node)   │    └──────────┘
                │  pub/sub hub     │
                └────────┬────────┘
                         │
              ┌──────────┴─────────────┐
              │                        │
              ▼                        ▼
      ┌──────────────┐        ┌─────────────────┐
      │dataops-claude │        │  dataops-split   │
      │ (AI spec gen) │        │ (wide → narrow)  │
      └──────┬───────┘        └────────┬────────┘
             │ context                  │ canonical
             │ (spec dict)              │ records
             ▼                          ▼
      ┌──────────────┐        ┌──────────────────┐
      │dataops-transform│      │  dataops-combine  │
      │ (apply specs)  │──────▶│ (narrow → wide)   │
      └──────────────┘        └────────┬──────────┘
                                       │
                                       ▼
                              [database / downstream]
```

Two config nodes support the pipeline:
- **dataops-cache** — shared in-memory cache + pub/sub event hub
- **dataops-claude-api** — Anthropic API credentials + model settings

---

## Canonical Record Shape

All worker nodes (split, transform, combine) share a common narrow record format:

```js
{
  name:      "plant/HWS/Denis/temperature",
  type:      "number",        // number | integer | string | boolean | object
  timestamp: 1716636000000,   // epoch ms
  value:     25.4,            // coerced to declared type
  quality:   true             // boolean or string
}
```

- **split** produces these from wide payloads (one per configured field)
- **transform** produces these by applying JSONata specs (one per input message)
- **combine** consumes these and assembles them into wide flat dictionaries

---

## Component Details

### dataops-cache (Config Node)

**Role**: Central hub — stores messages, dispatches update events.

**Data structure**: `Map<key, {payload, ts, metadata, previous}>`

- `key`: String cache key (typically `msg.topic`)
- `payload`: The full message payload (any JSON-serializable value)
- `ts`: Timestamp of last update (ms since epoch)
- `metadata`: Object with `_msgid` and `originalTopic`
- `previous`: Snapshot of the previous entry (for change detection)

**Storage layers**:
1. **In-memory Map** — primary store, O(1) access, used by all worker nodes at runtime
2. **Node-RED global context** — debounced sync (500ms), enables sidebar inspection and persistence across restarts

**Event system**: Node.js `EventEmitter` shared per cache instance, keyed by `node.id`. Exact-key subscriptions using `Map<key, Map<subId, callback>>`.

**Lifecycle**:
- On create: restore from context if in-memory cache is empty (e.g., after restart)
- On close: final sync to context, reference-counted cleanup of subscriptions and emitter
- TTL: optional periodic cleanup of expired entries (min 60s between checks)
- LRU eviction when exceeding `maxEntries` (removes oldest by timestamp)

**HTTP admin endpoints** (available in editor):
- `POST /dataops-cache/:id/clear` — clear all entries
- `GET /dataops-cache/:id/stats` — size, keys, subscription counts
- `GET /dataops-cache/:id/keys` — list of cached keys for autocomplete

---

### dataops-in

**Role**: Feed messages into the cache.

**Flow**: `input msg → extract key → cache.setValue(key, payload) → pass-through msg`

- Key extracted from any `msg` property via `RED.util.getMessageProperty` (default: `msg.topic`)
- Stores the full `msg.payload` as the value (objects, arrays, scalars — anything)
- Builds metadata from `msg._msgid` and `msg.topic`
- Passes the message through unchanged
- Status: green dot (ready), yellow ring (missing key), red ring (error/no cache)

---

### dataops-combine

**Role**: Collect narrow normalized records and emit wide flat dictionaries.

**Input**: `msg.payload = {name, type, timestamp, value, quality}` (canonical record shape)

**Internal buffer**: `Map<name, {value, type, timestamp, quality}>`

**Trigger modes**:

| Mode | Behavior |
|---|---|
| `event` | Emit on every input — always-current snapshot |
| `interval` | Emit every N milliseconds, using latest buffered values |
| `quorum` | Emit when all `expectedNames` have arrived, then clear buffer |

A message with `msg.cmd = 'emit'` forces an emit regardless of mode.

**Output message shape** (output 1):
```js
{
  topic: "dataops/combined",
  payload: {
    temperature: 25.5,
    humidity: 60.2,
    ts: 1716636002000         // latest timestamp across all records
  },
  _names: ["temperature", "humidity"],
  _trigger: "event"
}
```

When `includeQuality` is enabled, quality fields are included as `<name>_q`.

**Key design decisions**:
- Buffer stores only the latest value per name (not a sliding window)
- No partial outputs in quorum mode — all expected names must be present
- The `ts` field name is configurable via `tsField`
- Output 2 carries malformed input errors (missing `name` field)

---

### dataops-split

**Role**: Explode a wide payload into N narrow normalized records.

**Input**: A message with a wide payload object:
```js
{ topic: "plant/HWS/Denis", payload: { T: 25.4, H: 60.2, P: 1013, alarmActive: false } }
```

**Configuration**:
- `topicFilter` — MQTT-style filter (`+`, `#`); empty matches all topics
- `fields` — JSON array of `{name, type, path?}`; `path` defaults to `name`
- `timestampExpr` — JSONata expression; empty falls back to `msg.timestamp` or `Date.now()`
- `qualityExpr` — JSONata expression; empty falls back to `msg.quality` or `true`

**Output** (output 1): One message per field, shape:
```js
{
  topic: "plant/HWS/Denis/T",
  payload: { name: "T", type: "number", timestamp: 1716636000000, value: 25.4, quality: true },
  _split: { from: "plant/HWS/Denis", field: "T" }
}
```

**Key design decisions**:
- Fields are extracted by dot-path into `msg.payload` (not `msg` itself)
- Missing fields produce `undefined` value (coerced to `null` on type mismatch)
- Non-matching topics are dropped (or forwarded to output 2 if `passthroughNonMatch`)
- Type coercion uses the shared `lib/coerce.js` module
- JSONata expressions are prepared once at construction time

---

### dataops-claude-api (Config Node)

**Role**: Store Anthropic API credentials and model settings.

**Properties**: `apiKey` (encrypted password credential), `model`, `baseUrl`, `maxTokens`, `temperature`.

**Used by**: `dataops-claude` nodes.

---

### dataops-claude

**Role**: Send cache samples to Claude and harvest per-topic normalization specs.

**Workflow**:
1. Read all entries from the linked `dataops-cache`
2. Encode entries as TOON table: `samples[N]{topic,ts,payload}:`
3. Call the Anthropic Messages API with retry/backoff
4. Parse the TOON response into a spec dictionary: `{topic: {type, value, timestamp, quality}}`
5. Optionally merge into Node-RED context (`global` or `flow`) at configured key
6. Emit one message per topic on output 1

**API call details**:
- 3 retry attempts with exponential backoff (1s → 2s → 4s, capped at 8s)
- 120-second timeout per attempt via AbortController
- Retries on 429 and 5xx status codes
- Uses `anthropic-version: 2023-06-01` header

**Sampling**: If cache entries exceed `maxSampleRows` (default 250), only the first N are sent. The prompt includes a note about total vs sampled count.

**TOON encoding**: Cache entries are encoded as a minimal tabular format for token efficiency. Each row contains `topic`, `ts` (epoch ms), and `payload` (JSON-encoded for objects/arrays, bare for primitives).

**Response parsing**:
- Primary: TOON decode (expects `specs[M]{topic,type,value,timestamp,quality}:`)
- Fallback: JSON parse with markdown fence stripping (handles models that ignore TOON instructions)
- Diagnostics: detects truncated responses (`stop_reason === 'max_tokens'`), thinking-only responses

**Spec dictionary merge**: When `specContextKey` is set, the parsed specs are merged into the existing context dictionary (preserving entries for topics not in the current response). Each merged entry gets a `_meta` field with `generated_at`, `model`, and `format`.

**SQLite history**: Every API call is recorded in the `config_history` table: `node_id`, `timestamp`, `cache_size`, `model`, `system_prompt`, `user_prompt`, `response`, `input_tokens`, `output_tokens`, `duration_ms`.

**Default system prompt**: A 204-line prompt instructing Claude to generate JSONata expressions for IIoT payload normalization, with rules for OPC UA Variants, Kepware, and Sparkplug B formats.

---

### dataops-transform

**Role**: Apply per-topic processing instructions (JSONata expressions) to normalize incoming messages.

**Spec dictionary** (read from Node-RED context, typically populated by `dataops-claude`):
```js
{
  "plant/HWS/Denis/temp": {
    type:      "number",
    value:     "payload.value.value",
    timestamp: "$toMillis(payload.sourceTimestamp)",
    quality:   "payload.statusCode = 0"
  }
}
```

The topic (dictionary key) IS the canonical `name`. `value`, `timestamp`, and `quality` are JSONata expressions evaluated against the full `msg` object.

**Processing flow**:
1. Extract topic from `msg` using configured `keyField` (default: `msg.topic`)
2. Look up spec in context dictionary
3. If found: compile/cache JSONata expressions, evaluate against `msg`, coerce value to declared type
4. If not found: apply fallback mode

**Compiled expression cache**: `Map<topic, {sig, value, timestamp, quality}>` — expressions are cached after compilation and only recompiled when the raw spec content changes (tracked via JSON.stringify signature).

**Fallback modes**:

| Mode | Behavior |
|---|---|
| `heuristic` | Walk `payload.value.value` → `payload.value` → `payload.v` → `payload`; infer type; use `Date.now()` for timestamp; quality = `true` |
| `passthrough` | Forward original message to output 2 |
| `error` | Raise error to output 2 |

**Output** (output 1):
```js
{
  payload: { name: "plant/HWS/Denis/temp", type: "number", timestamp: 1716636000000, value: 25.4, quality: true },
  _spec: "spec"  // or "heuristic"
}
```

---

## Shared Libraries

### lib/toon.js — Token-Oriented Object Notation

Minimal tabular encoder/decoder for efficient LLM I/O.

**Format**:
```
name[N]{col1,col2,...}:
  <row1>
  <row2>
```

**Cell encoding**: Numbers, booleans, `null` are bare tokens. Strings containing commas, quotes, or whitespace are double-quoted with backslash escapes. Objects and arrays are JSON-stringified into quoted cells.

**Decoding**: Permissive parser — strips markdown fences, ignores surrounding text, case-insensitive column matching.

**API**: `encodeTable(name, columns, rows)`, `decodeTable(input)`, `rowsToObjects(decoded)`.

### lib/coerce.js — Type Coercion

Shared between `dataops-split` and `dataops-transform`.

**`coerce(value, type)`**: Returns value reshaped to declared type, or `null` on failure. Supported types with aliases:
- `number` / `double` / `float` / `real` — parsed via `Number()`, must be finite
- `integer` / `int` / `long` / `short` — parsed numerically, `Math.trunc` applied
- `boolean` / `bool` — accepts booleans, 0/1, and strings: true/false, 1/0, yes/no, on/off
- `string` / `text` / `char` — objects JSON-stringified, primitives via `String()`
- `object` / `json` — objects pass through, strings JSON-parsed

**`inferType(value)`**: Returns type tag from runtime value (`boolean`, `integer`, `number`, `string`, `object`, `null`).

### lib/sqlite-store.js — Claude API History

Thin wrapper around `better-sqlite3`.

**Schema**: `config_history` table with columns: `id`, `node_id`, `timestamp`, `cache_size`, `model`, `system_prompt`, `user_prompt`, `response`, `input_tokens`, `output_tokens`, `duration_ms`. Indexed on `node_id` and `timestamp`.

**Design**: Per-operation connections (open → execute → close) to avoid persistent-connection issues. WAL journal mode for concurrent-reader safety.

**API**: `constructor(dbPath)`, `insertRecord(record)`, `getRecords(nodeId, limit)`, `close()`.

---

## Data Flow Patterns

### AI-assisted normalization (the full pipeline)
```
[sensors] → dataops-in → cache → dataops-claude → context (spec dict)
                                              ↓
[messages] → dataops-transform → dataops-combine → [database]
```

1. Upstream sensors feed sample data into the cache
2. `dataops-claude` sends samples to Claude, harvests per-topic normalization specs
3. Specs are stored in Node-RED context as a dictionary
4. Live messages flow through `dataops-transform`, which applies the specs
5. Normalized records feed into `dataops-combine` for wide-record assembly

### Heuristic-only normalization (no API key)
```
[messages] → dataops-transform (heuristic fallback) → dataops-combine → [database]
```

Uses built-in payload-walking heuristics. Works for OPC UA Variants (`payload.value.value`), Kepware (`payload.value`), and Sparkplug B (`payload.v`).

### Direct split (wide → narrow)
```
[wide message source] → dataops-split → [downstream]
```

Messages already contain all fields. Split extracts each field into its own normalized record.

### Interval-driven combine (time-series snapshot)
```
[sensors] → dataops-transform → dataops-combine (trigger: interval) → [database]
```

Snapshot latest normalized values periodically, regardless of input rate.

### Claude spec refresh (scheduled re-generation)
```
[inject (cron)] → dataops-claude → context (updates spec dict)
```

Periodically re-run Claude to update specs as new data patterns emerge. Does not interrupt the transform pipeline.

---

## Concurrency Model

- Single-threaded (Node.js event loop) — no locks needed
- All cache operations are synchronous on the in-memory Map
- Context sync is asynchronous (debounced setTimeout)
- Pub/sub dispatch is synchronous (EventEmitter.emit is synchronous)
- Subscription callbacks fire in order of registration
- Claude API calls are async with AbortController timeouts
- JSONata expression evaluation is async (callback-based)

## Memory Model

- **Cache size**: Bounded by `maxEntries` with LRU eviction
- **TTL**: Optional, checked on a periodic interval (min 60s)
- **Reference counting**: `sharedInstances` tracks active references; last user cleans up
- **Context storage**: Cache serialized to global context as a plain object (Map entries → Object)
- **Combine buffer**: Unbounded `Map<name, record>` cleared on close or quorum emit
- **Transform expression cache**: Unbounded `Map<topic, compiled>` invalidated on spec change
- **SQLite**: Per-operation connections, WAL mode, not held open

## Extension Points

To add a new node type:
1. Create `nodes/node-name.js` — implement runtime logic
2. Create `nodes/node-name.html` — register with `category: 'data ops'`, define editor template and help
3. Register in `package.json` under `node-red.nodes`

To add a new shared library:
1. Create `lib/module-name.js`
2. Require it from worker nodes with `require('../lib/module-name')`
3. Document the API in this file
