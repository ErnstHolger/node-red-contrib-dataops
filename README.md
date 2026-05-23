# node-red-contrib-dataops

Node-RED nodes for data operations — stream messages into a cache, then **combine** or **split** them for database workflows.

## Installation

```bash
npm install node-red-contrib-dataops
```

Or via the Node-RED palette manager: search for `node-red-contrib-dataops`.

## Nodes

### dataops-cache (config node)
Central message cache and event hub. Stores full message payloads keyed by topic with pub/sub for reactive updates. Supports LRU eviction and optional TTL expiry.

### dataops-in
Pushes incoming messages into the cache. The full `msg.payload` is stored, keyed by the configured field (default: `msg.topic`). Messages pass through unchanged.

### dataops-combine
Subscribes to multiple cache keys and combines them into wide messages.

- **Key-based join**: Messages must share a common field value (e.g., `order_id`)
- **Time window**: Optional max time span across combined messages
- **Trigger modes**: Event (on cache update), Interval (fixed rate or cron), External (on input message)
- Sets `msg._table` for database routing

### dataops-split
Splits wide messages into narrower ones.

- **Field extraction**: Define groups of fields, each routed to its own output with topic and table (up to 4 outputs)
- **Array expansion**: Expand an array into individual messages, optionally including parent context fields

## Quick Start

1. Add a **dataops-cache** config node
2. Feed data in with **dataops-in** (select the cache in its config)
3. Use **dataops-combine** to merge related messages by key within a time window
4. Use **dataops-split** to break wide messages apart into per-table outputs
5. Route outputs to database nodes using `msg._table`

## Example Flow

See `examples/dataops-example.json` — demonstrates:

- Two inject nodes feeding temperature and humidity into the cache
- A combine node joining them by `device_id` within a 5-second window
- A split node breaking the combined result into individual sensor readings

## Common Patterns

### Narrow → Wide → Narrow (Combine then split)
```
[source A] → dataops-in →┐
                          ├→ cache → combine → split → [db tables]
[source B] → dataops-in →┘
```
Collect related data from multiple sources, join into wide records, then fan out to separate database tables.

### Wide → Narrow (Direct split)
```
[wide message source] → split → [db tables]
```
Messages already contain all fields but need separating for different tables.

### Interval-driven snapshot
```
[sensor] → dataops-in → cache → combine (trigger: interval) → [db]
```
Snapshot latest values periodically regardless of update frequency.

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
  dataops-cache.js/.html   - Config node: central cache + event hub
  dataops-in.js/.html      - Push messages to cache
  dataops-combine.js/.html - Combine by key within time window
  dataops-split.js/.html   - Split via field extraction or array expansion
examples/
  dataops-example.json     - Demo flow
```

## License

Personal Use License — see [LICENSE](LICENSE)
