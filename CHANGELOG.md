# Changelog

## 2.0.0

### Breaking changes

Three nodes were removed. Core Node-RED (5.x) covers what they did. Flows that still use them show the nodes as *unknown* after upgrading.

| Removed | Replace with |
|---|---|
| `dataops-split` | Core **split** node, or a **change**/**function** node that maps fields into `dataops-transform`. |
| `dataops-combine` | Core **join** node in key/value mode. Set `dataops-transform` → *Output* to **value** so `msg.topic` is the key and `msg.payload` the value. |
| `dataops-table` | Core **debug** node to inspect cached values. Read `global.<key>` with a **change** or **function** node on a **dataops-cron** tick to build rows for a database. |

QuestDB output was part of `dataops-table` and is gone with it.

The examples `dataops-example`, `dataops-split-pipeline`, `dataops-transform-heuristic` and `dataops-questdb-snapshot` were removed. `dataops-claude-pipeline` now ends at transform.

### Added

- `dataops-claude` has a rewritten, structured built-in prompt: lookup tables for value, timestamp (epoch s/ms/µs, date strings) and quality (OPC UA status codes, OPC DA, quality text), plus a worked example that is tested against transform. The editor gains **Load default** and **Reset to built-in** buttons. Specs now also carry an optional `unit` and `description`.
- `dataops-transform` has a new **Output** option. `record` (default, unchanged) emits `msg.payload = {name, type, timestamp, value, quality}`. `value` emits `msg.payload = value` with `msg.topic`, `msg.timestamp`, `msg.quality` and `msg.type`.

### Also in this release (since 1.3.0-beta.1)

- **Claude API:**
  - Uses the official `@anthropic-ai/sdk`, with streaming and retries.
  - New configs default to `claude-opus-5-5`, with optional Effort.
  - Temperature is sent only when set.
  - Server-side refusal fallback is on by default for the Anthropic API.
- **dataops-runtime:** trigger and label topics are used verbatim (topics like `line/1/running` work), values are unwrapped, and *Sampling* is a true rate limit.
- **dataops-in:** flat-mode LRU eviction is now least-recently-written.
- **dataops-claude:** an empty source no longer triggers an API call, and errors and refusals go to output 2.
- **Tests:** a `node:test` suite runs every node in a real Node-RED runtime.
