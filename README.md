# node-red-contrib-dataops

Node-RED nodes for data operations — stream messages into a cache, normalize them with AI assistance, then **split**, **transform**, or **combine** them for database workflows.

## Installation

```bash
npm install node-red-contrib-dataops
```

Or via the Node-RED palette manager: search for `node-red-contrib-dataops`.

**Requires Node.js >= 18 and Node-RED >= 2.0.**

### Optional: Claude AI integration

To use the AI-assisted normalization pipeline, install `better-sqlite3` (bundled as a dependency) and configure an Anthropic API key in a `dataops-claude-api` config node.

## Nodes

### dataops-cache (config node)
Central message cache and event hub. Stores full message payloads keyed by topic with pub/sub for reactive updates. Supports LRU eviction and optional TTL expiry. Exposes HTTP admin endpoints for inspection and clearing.

### dataops-in
Pushes incoming messages into the cache. The full `msg.payload` is stored, keyed by the configured field (default: `msg.topic`). Messages pass through unchanged.

### dataops-combine
Collects narrow normalized records and emits wide flat dictionaries.

- **Input**: `{name, type, timestamp, value, quality}` (canonical record shape)
- **Trigger modes**: Event (on every input), Interval (fixed-rate snapshots), Quorum (when all expected names arrive)
- Optional quality fields as `<name>_q` in output
- Force-emit via `msg.cmd = 'emit'`

### dataops-split
Explodes a wide payload into narrow normalized records.

- **Per-field extraction**: JSON array of `{name, type, path}` definitions
- **MQTT-style topic filter**: `+` (single segment), `#` (multi-level wildcard)
- **JSONata expressions** for timestamp and quality
- **Type coercion**: number, integer, string, boolean, object with aliases
- Outputs canonical `{name, type, timestamp, value, quality}` records

### dataops-claude-api (config node)
Stores Anthropic API credentials (encrypted) and model settings shared by `dataops-claude` nodes. Supports custom base URLs for proxies and compatible APIs.

### dataops-claude
Sends cache samples to Claude for AI-assisted per-topic normalization spec generation.

- Reads all entries from a `dataops-cache`, encodes as TOON for token efficiency
- Calls the Anthropic Messages API with retry/backoff (3 attempts, 120s timeout)
- Parses TOON response into a spec dictionary: `{topic: {type, value, timestamp, quality}}`
- Optionally merges specs into Node-RED context for downstream `dataops-transform` nodes
- Records all API calls in SQLite history with token usage and duration
- Emits one message per topic on output 1

### dataops-transform
Applies per-topic JSONata processing instructions to normalize incoming messages.

- Reads spec dictionary from Node-RED context (populated by `dataops-claude` or manually)
- Evaluates JSONata expressions for `value`, `timestamp`, `quality` against each message
- Coerces values to declared types
- **Heuristic fallback**: walks `payload.value.value` → `payload.value` → `payload.v` → `payload` when no spec exists
- Caches compiled JSONata expressions for performance
- Outputs canonical `{name, type, timestamp, value, quality}` records

## Quick Start

1. Add a **dataops-cache** config node
2. Feed data in with **dataops-in** (select the cache in its config)
3. Choose your pipeline:

### Pipeline A: Direct split (wide → narrow)
```
[wide msg source] → dataops-split → [downstream]
```
Configure fields to extract, use type coercion for clean output.

### Pipeline B: AI-assisted normalization (any → canonical)
```
[sensors] → dataops-in → cache → dataops-claude → context
                                              ↓
[messages] → dataops-transform → dataops-combine → [database]
```
Claude generates per-topic normalization specs; transform applies them to live data; combine assembles wide records.

### Pipeline C: Heuristic transform (no API key needed)
```
[messages] → dataops-transform (heuristic fallback) → dataops-combine → [database]
```
Uses built-in payload-walking heuristics — works out of the box for OPC UA, Kepware, and Sparkplug B payloads.

## Example Flows

| File | Description |
|---|---|
| `examples/dataops-example.json` | Basic pipeline: inject → cache → combine → split |
| `examples/dataops-claude-pipeline.json` | AI pipeline: cache → claude → transform → combine |
| `examples/dataops-transform-heuristic.json` | Heuristic-only: transform → combine (no API needed) |
| `examples/dataops-split-pipeline.json` | Direct split: wide messages → narrow records |

Import any example via Node-RED's Import menu.

## Canonical Record Shape

All pipeline nodes share a common record shape that flows from split/transform through combine:

```js
{
  name:      "plant/HWS/Denis/temperature",
  type:      "number",
  timestamp: 1716636000000,
  value:     25.4,
  quality:   true
}
```

This is the narrow (normalized) form. The combine node assembles these into wide flat dictionaries.

## Development

```bash
npm run deploy        # npm link to Node-RED
npm run deploy:patch  # bump patch + link
npm run deploy:minor  # bump minor + link
npm run deploy:major  # bump major + link
npm test              # run Playwright tests
```

After code changes, restart Node-RED to pick up changes.

### Publishing

```bash
npm run publish:dry    # test publish (no changes)
npm run publish:patch  # bump patch + publish
npm run publish:minor  # bump minor + publish
npm run publish:major  # bump major + publish
```

After publish, resubmit at [flows.nodered.org/add/node](https://flows.nodered.org/add/node).

### Adding New Nodes

1. Create `nodes/node-name.js` (runtime logic)
2. Create `nodes/node-name.html` (editor UI + help)
3. Register in `package.json` under `node-red.nodes`
4. Run `npm run deploy` and restart Node-RED

## Project Structure

```
nodes/
  dataops-cache.js/.html      - Config node: central cache + event hub
  dataops-in.js/.html         - Push messages to cache
  dataops-combine.js/.html    - Buffer narrow records, emit wide flat dicts
  dataops-split.js/.html      - Explode wide payloads into narrow records
  dataops-claude-api.js/.html - Config node: Anthropic API credentials
  dataops-claude.js/.html     - AI-assisted spec generation from cache
  dataops-transform.js/.html  - Apply per-topic JSONata specs to messages
lib/
  toon.js                     - Token-Oriented Object Notation
  coerce.js                   - Shared type coercion
  sqlite-store.js             - Claude API call history
examples/
  *.json                      - Importable demo flows
```

## License

Personal Use License — see [LICENSE](LICENSE)
