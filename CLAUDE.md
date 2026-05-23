# node-red-contrib-dataops

Node-RED contrib package for data operations — cache, combine, and split messages for database workflows.

## Project Structure

```
nodes/
  dataops-cache.js/.html   - Config node: central message cache + event hub
  dataops-in.js/.html      - Push messages to cache
  dataops-combine.js/.html - Combine cached messages by key within time window
  dataops-split.js/.html   - Split wide messages via field extraction or array expansion
examples/
  dataops-example.json     - Demo flow: inject → cache → combine → split → debug
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

- **dataops-cache**: Central hub storing `Map<key, {payload, ts, metadata, previous}>` with EventEmitter for pub/sub. In-memory primary store with debounced sync to Node-RED context for sidebar visibility and persistence across restarts. LRU eviction, TTL, reference-counted cleanup.
- **dataops-in**: Publisher — extracts key from `msg.topic` (configurable), stores entire `msg.payload` in cache. Pass-through.
- **dataops-combine**: Subscriber — listens for topic updates, joins by a shared key field within a time window. Three trigger modes: event (on update), interval (fixed rate), external (on input message). Emits combined wide messages with `msg._table` for database routing.
- **dataops-split**: Two modes — field extraction (pick named fields per output, up to 4 outputs) and array expansion (one message per array element with optional context carry-over).

## Key Design Patterns

- Config node (`dataops-cache`) pattern: shared `Map` + `EventEmitter` instances keyed by `node.id`, reference-counted for cleanup
- Subscription pattern: `cache.subscribe(key, callback)` returns subscription ID, `cache.unsubscribe(id)` for cleanup
- Context sync: debounced (500ms) sync from in-memory Map to global context for persistence
- Node outputs: combine uses 2 outputs (result + error), split uses 4 outputs (one per field group)
- All nodes follow `(msg, send, done)` signature for Node-RED 1.0+ compatibility
- Status indicators: green (ready/active), yellow (warning/missing config), red (error)

## Adding New Nodes

1. Create `nodes/node-name.js` (runtime logic)
2. Create `nodes/node-name.html` (editor UI + help)
3. Register in `package.json` under `node-red.nodes`
4. Run deploy command
5. Restart Node-RED

## License

Personal Use License — see LICENSE file
