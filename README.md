# node-red-contrib-dataops

Node-RED nodes for data operations — cache, combine, and split messages for database workflows.

## Nodes

### dataops-cache (config node)
Central message cache and event hub. Stores full message payloads keyed by topic, with pub/sub for reactive updates.

### dataops-in
Pushes incoming messages into the cache. The full `msg.payload` is stored, keyed by the configured field (default: `msg.topic`). Messages pass through unchanged.

### dataops-combine
Subscribes to multiple cache keys and combines them into wide messages.

- **Key-based join**: Messages must share a common field value (e.g., `order_id`)
- **Time window**: Optional max time span across combined messages
- **Trigger modes**: Event (on cache update), Interval (fixed rate), External (on input message)
- Output carries `msg._table` for database routing

### dataops-split
Splits wide messages into narrower ones.

- **Field extraction**: Define groups of fields, each routed to its own output with a topic and table
- **Array expansion**: Expand an array into individual messages, optionally including parent context fields

## Quick Start

1. Add a **dataops-cache** config node
2. Feed data in with **dataops-in** (select the cache in its config)
3. Use **dataops-combine** to merge related messages by key
4. Use **dataops-split** to break wide messages apart
5. Route outputs to database nodes using `msg._table`

## Example Flow

See `examples/dataops-example.json` — demonstrates:
- Two inject nodes feeding temperature and humidity into the cache
- A combine node joining them by `device_id` within a 5-second window
- A split node breaking the combined result into individual sensor readings

## Development

```
npm run deploy        # npm link to Node-RED
npm run deploy:patch  # bump patch + link
npm test              # run Playwright tests
```

## License

Personal Use License — see LICENSE file
