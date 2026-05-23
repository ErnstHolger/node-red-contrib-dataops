# Architecture — node-red-contrib-dataops

## Overview

DataOps is a Node-RED contrib package for building data pipeline workflows. The core idea: stream messages into a central cache, then build new output messages by either **combining** cached messages into wider records or **splitting** wide messages into narrower ones. Each output message carries routing metadata (`msg._table`) for downstream database nodes.

```
┌──────────┐    ┌─────────────────┐    ┌──────────────┐
│ dataops-in │───▶│  dataops-cache   │◀────│ dataops-in   │
└──────────┘    │  (config node)   │    └──────────────┘
                │  pub/sub hub     │
                └────────┬────────┘
                         │ subscribe
              ┌──────────┴──────────┐
              ▼                     ▼
      ┌──────────────┐      ┌──────────────┐
      │dataops-combine│      │ dataops-split │
      │ (join → wide) │      │ (wide → narrow)│
      └──────┬───────┘      └──────┬───────┘
             │ output              │ output(s)
             ▼                     ▼
      [database / downstream nodes]
```

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
- TTL: optional periodic cleanup of expired entries

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

---

### dataops-combine

**Role**: Join multiple cached messages into one wide message by matching a key field within a time window.

**Join algorithm**:
1. Subscribe to one or more cache keys (defined in `inputMappings`)
2. When any subscribed key updates (and trigger mode is `event`), attempt a combine:
   - Check all mapped keys have values in the cache
   - If a time window is set, verify `newestTs - oldestTs <= windowMs`
   - If a join key is set, verify the join key value is identical across all mapped payloads
   - If conditions met, build combined payload: `{ fieldName: cachedPayload, ... }`
3. Emit combined message on output 1

**Trigger modes**:

| Mode | Behavior |
|---|---|
| `event` | Fire whenever any subscribed cache entry updates and conditions pass |
| `interval` | Fire on a fixed interval (ms) or cron expression, using latest cached values |
| `external` | Fire only when a message arrives at the input port |

**Output message shape**:
```js
{
  topic: "dataops/combined",
  payload: {
    temperature: { device_id: "D1", value: 25.5, unit: "C" },
    humidity:    { device_id: "D1", value: 60.2, unit: "%" }
  },
  _table: "sensor_readings",
  trigger: "sensor/temperature",
  ts: 1717000000000,
  windowStart: 1716999990000,
  windowEnd:   1717000010000
}
```

**Key design decisions**:
- Join key values are compared as JSON strings (handles nested objects)
- No partial outputs — all mappings must have values or nothing is emitted
- Time window uses the oldest and newest timestamps across all inputs

---

### dataops-split

**Role**: Break a wide message into narrower ones.

**Mode A — Field Extraction**:
- Define up to 4 field groups, each mapping to one Node-RED output
- Each group specifies: comma-separated field names, output topic, and table name
- Fields present in the input payload are extracted into each output message
- Missing fields are silently skipped (output may have fewer fields than defined)

```
Input:  { temp: 25, humidity: 60, pressure: 1013, flow: 42 }

Group 1 (output 1): fields="temp, humidity"  → { temp: 25, humidity: 60 }
Group 2 (output 2): fields="pressure, flow"  → { pressure: 1013, flow: 42 }
```

**Mode B — Array Expansion**:
- Locates an array within the message at a configurable path (default: `msg.payload`)
- Emits one message per array element on output 1
- Optionally includes context fields from the parent payload on each child message

```
Input:  { device_id: "D1", readings: [{ts: "12:00", v: 25}, {ts: "12:01", v: 26}] }

Array path: "payload.readings"
Include context: "device_id"

Output 1: { payload: { device_id: "D1", ts: "12:00", v: 25 }, _splitIndex: 0 }
Output 2: { payload: { device_id: "D1", ts: "12:01", v: 26 }, _splitIndex: 1 }
```

---

## Data Flow Patterns

### Combine-then-split pipeline (narrow → wide → narrow)
```
[source A] → dataops-in →┐
                          ├→ dataops-cache → dataops-combine → dataops-split → [db tables]
[source B] → dataops-in →┘
```
This is the primary use case: collect related data from multiple sources, join them into wide records, then fan out to separate database tables.

### Direct split (wide → narrow)
```
[wide message source] → dataops-split → [db tables]
```
Use when messages already contain all fields but need to be separated for different tables.

### Interval-driven combine (time-series aggregation)
```
[sensor] → dataops-in → cache → dataops-combine (trigger: interval) → [db]
```
Use when you want to snapshot latest values periodically regardless of update frequency.

---

## Concurrency Model

- Single-threaded (Node.js event loop) — no locks needed
- All cache operations are synchronous on the in-memory Map
- Context sync is asynchronous (debounced setTimeout)
- Pub/sub dispatch is synchronous (EventEmitter.emit is synchronous)
- Subscription callbacks fire in order of registration

## Memory Model

- **Cache size**: Bounded by `maxEntries` with LRU eviction
- **TTL**: Optional, checked on a periodic interval (min 60s)
- **Reference counting**: `sharedInstances` tracks active references; last user cleans up
- **Context storage**: Cache serialized to global context as a plain object (Map entries → Object)

## Extension Points

To add a new node type:
1. Create `nodes/node-name.js` — implement runtime logic using `cacheConfig.subscribe()` or `cacheConfig.getValue()`
2. Create `nodes/node-name.html` — register with `category: 'data ops'`, define editor template and help
3. Register in `package.json` under `node-red.nodes`
