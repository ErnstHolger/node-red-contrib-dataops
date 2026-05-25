# node-red-contrib-dataops

Node-RED contrib package for data operations — cache, split, combine, transform, and AI-assisted message normalization.

## Project Structure

```
nodes/
  dataops-cache.js/.html      - Config node: central message cache + event hub
  dataops-in.js/.html         - Push messages to cache
  dataops-combine.js/.html    - Buffer narrow records, emit wide flat dictionaries
  dataops-split.js/.html      - Explode wide payloads into narrow normalized records
  dataops-claude-api.js/.html - Config node: Anthropic API credentials + settings
  dataops-claude.js/.html     - Send cache samples to Claude, harvest per-topic specs
  dataops-transform.js/.html  - Apply per-topic JSONata specs to normalize messages
lib/
  toon.js                     - Token-Oriented Object Notation encoder/decoder
  coerce.js                   - Shared type coercion (used by split and transform)
  sqlite-store.js             - SQLite wrapper for Claude API call history
examples/
  dataops-example.json        - Demo flow: inject → cache → combine → split → debug
```

## Development Commands

### Local Development
- `npm run deploy` - Link to Node-RED via npm link
- `npm run deploy:patch` - Bump patch version + link
- `npm run deploy:minor` - Bump minor version + link
- `npm run deploy:major` - Bump major version + link

### Publishing to npm + Node-RED Flow Library
- `npm run publish:dry` - Test publish (no changes)
- `npm run publish:patch` - Bump patch + publish
- `npm run publish:minor` - Bump minor + publish
- `npm run publish:major` - Bump major + publish

After publish, resubmit at https://flows.nodered.org/add/node

### Testing
- `npm test` - Run Playwright tests (headless)
- `npm run test:headed` - Run tests with visible browser
- `npm run test:ui` - Run with Playwright UI

**Note:** Tests require Node-RED running on localhost:1880

## Node-RED Linking

The package is linked via `npm link` for local development.

After any code change:
1. Run deploy command (or changes are immediate via symlink)
2. Restart Node-RED to pick up changes

## Architecture

### Core Pipeline (4 nodes)

- **dataops-cache**: Central hub storing `Map<key, {payload, ts, metadata, previous}>` with EventEmitter for pub/sub. In-memory primary store with debounced sync to Node-RED context for sidebar visibility and persistence across restarts. LRU eviction, TTL, reference-counted cleanup. HTTP admin endpoints for clear/stats/keys.
- **dataops-in**: Publisher — extracts key from `msg.topic` (configurable), stores entire `msg.payload` in cache. Pass-through.
- **dataops-combine**: Collects narrow normalized records (`{name, type, timestamp, value, quality}`) into a buffer. Three trigger modes: event (on every input), interval (fixed rate), quorum (when all expected names arrive). Emits a wide flat dictionary with optional quality fields.
- **dataops-split**: Explodes a wide payload into N narrow normalized records. Configurable per-field JSON array with `{name, type, path}` and MQTT-style topic filter. Uses JSONata expressions for timestamp and quality. Produces canonical `{name, type, timestamp, value, quality}` records.

### AI Pipeline (3 nodes + lib)

- **dataops-claude-api**: Config node storing Anthropic API key (encrypted), model, base URL, max tokens, temperature.
- **dataops-claude**: Reads all cache entries, encodes them as TOON, sends to Claude with retry/backoff (3 attempts, exponential to 8s, 120s timeout). Parses TOON response into a spec dictionary (`{topic: {type, value, timestamp, quality}}`). Optionally merges into Node-RED context for downstream `dataops-transform` nodes. Records all API calls in SQLite history. Emits one message per topic on output 1.
- **dataops-transform**: Reads per-topic specs from Node-RED context, evaluates JSONata expressions against incoming messages, coerces values to declared types. Three fallback modes when no spec exists: heuristic (walks `payload.value.value` → `payload.value` → `payload.v` → `payload`), passthrough, error. Caches compiled JSONata expressions with invalidation on spec change.

### Shared Libraries

- **lib/toon.js**: Minimal tabular encoder/decoder. Format: `name[N]{col1,col2,...}:\n  <row>\n  ...`. Used for efficient LLM I/O.
- **lib/coerce.js**: Type coercion (number, integer, boolean, string, object) with aliases and boolean string parsing. `inferType()` for runtime type detection.
- **lib/sqlite-store.js**: Thin `better-sqlite3` wrapper with per-operation connections, WAL mode. Schema: `config_history` table tracking API calls.

## Key Design Patterns

- Config node (`dataops-cache`) pattern: shared `Map` + `EventEmitter` instances keyed by `node.id`, reference-counted for cleanup
- Config node (`dataops-claude-api`) pattern: credentials stored in Node-RED credential store (`apiKey` type password)
- Subscription pattern: `cache.subscribe(key, callback)` returns subscription ID, `cache.unsubscribe(id)` for cleanup
- Context sync: debounced (500ms) sync from in-memory Map to global context for persistence
- Spec dictionary: stored in Node-RED context (`global` or `flow`), keyed by topic, consumed by `dataops-transform`
- JSONata expression caching: compiled expressions cached per topic, invalidated on spec content change
- Node outputs: all worker nodes use 2 outputs (result + error)
- All nodes follow `(msg, send, done)` signature for Node-RED 1.0+ compatibility
- Status indicators: green (ready/active), yellow (warning/missing config), red (error), blue (API call in progress)

## Adding New Nodes

1. Create `nodes/node-name.js` (runtime logic)
2. Create `nodes/node-name.html` (editor UI + help)
3. Register in `package.json` under `node-red.nodes`
4. Run deploy command
5. Restart Node-RED

## License

Personal Use License — see LICENSE file
