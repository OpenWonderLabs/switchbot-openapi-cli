# Agent Guide

This guide covers everything an LLM agent (Claude, GPT, Cursor, Zed, OpenClaw, a homegrown orchestrator…) needs to drive SwitchBot devices through the `switchbot` CLI **safely** and **reliably**, without the agent needing to guess at device-specific JSON payloads.

If you're a human looking for a tour, start with the [top-level README](../README.md). This file assumes you're writing code that *calls* the CLI or embeds the MCP server.

---

## Table of contents

- [Three integration surfaces](#three-integration-surfaces)
- [Surface 1: MCP server (recommended)](#surface-1-mcp-server-recommended)
- [Surface 2: Structured plans (`switchbot plan`)](#surface-2-structured-plans-switchbot-plan)
- [Surface 3: Direct JSON invocation](#surface-3-direct-json-invocation)
- [Catalog: the shared contract](#catalog-the-shared-contract)
- [Safety rails](#safety-rails)
- [Observability](#observability)
- [Performance and token budget](#performance-and-token-budget)

---

## Three integration surfaces

All three share the same catalog, HMAC client, retry/backoff, destructive-command guard, cache, and audit-log. Choose based on how your agent is hosted:

| Surface     | Use when…                                                                  | Entry point                                     |
|-------------|----------------------------------------------------------------------------|-------------------------------------------------|
| MCP server  | Your agent host speaks [MCP](https://modelcontextprotocol.io) (Claude Desktop, Cursor, Zed, Anthropic Agent SDK) | `switchbot mcp serve` (stdio) or `--port <n>`   |
| Plan runner | Your agent is already producing structured JSON and you want the CLI to validate + execute it | `switchbot plan run <file>` / stdin               |
| Direct CLI  | Your agent wraps subprocesses and parses their output                      | Any subcommand with `--json`                    |

---

## Surface 1: MCP server (recommended)

```bash
switchbot mcp serve              # stdio, for Claude Desktop / Cursor
switchbot mcp serve --port 8765  # http, for long-lived agent workers
```

### Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "switchbot": {
      "command": "switchbot",
      "args": ["mcp", "serve"],
      "env": {
        "SWITCHBOT_TOKEN": "...",
        "SWITCHBOT_SECRET": "..."
      }
    }
  }
}
```

### Available tools (9)

| Tool                   | Purpose                                                           | Destructive-guard?       |
|------------------------|-------------------------------------------------------------------|--------------------------|
| `list_devices`         | Enumerate physical devices + IR remotes                           | —                        |
| `get_device_status`    | Live status for one device                                        | —                        |
| `send_command`         | Dispatch a built-in or customize command                          | yes (`confirm: true` required) |
| `list_scenes`          | Enumerate saved manual scenes                                     | —                        |
| `run_scene`            | Execute a saved manual scene                                      | —                        |
| `search_catalog`       | Look up device type by name/alias                                  | —                        |
| `describe_device`      | Live status **plus** catalog-derived commands + suggested actions | —                        |
| `account_overview`     | Single cold-start snapshot — devices, scenes, quota, cache, MQTT state. Call this first in a new agent session to avoid multiple round-trips. | — |
| `get_device_history`   | Latest state + rolling history from disk — zero quota cost        | —                        |

The MCP server refuses destructive commands (Smart Lock `unlock`, Garage Door `open`, etc.) unless the tool call includes `confirm: true`. The allowed list is the `destructive: true` commands in the catalog — `switchbot schema export | jq '[.data.types[].commands[] | select(.destructive)]'` shows every one.

### `get_device_history` — zero-cost state lookup

Reads `~/.switchbot/device-history/<deviceId>.json` written by `events mqtt-tail`. Requires no API call and costs zero quota.

```json
// Without deviceId — list all devices with stored history
{ "tool": "get_device_history" }
// → { "devices": [{ "deviceId": "ABC123", "latest": { "t": "...", "payload": {...} } }] }

// With deviceId — latest + rolling history (default 20, max 100 entries)
{ "tool": "get_device_history", "deviceId": "ABC123", "limit": 5 }
// → { "deviceId": "ABC123", "latest": {...}, "history": [{...}, ...] }
```

**Workflow**: run `switchbot events mqtt-tail` in the background (e.g. with pm2) to keep the history files fresh; then call `get_device_history` from any MCP session without consuming REST quota.

#### Device-history directory layout

After `events mqtt-tail` runs on a device, `~/.switchbot/device-history/` contains up to three companion files per device:

| File | Description |
|------|-------------|
| `<deviceId>.jsonl` | Append-only, authoritative event log. Source of truth for `history range` and `history aggregate`. Rotated at ~50 MB (up to 3 segments). |
| `<deviceId>.json` | Latest 100-entry ring buffer. Written on every MQTT event. Read by MCP `get_device_history` for fast, zero-quota retrieval. |
| `__control.jsonl` | MQTT connection lifecycle events (heartbeat, connect, disconnect). Not a device log; used for diagnostics. |

The `.json` file is **not** the source of truth for historical queries — use `.jsonl` (via `history range` or `history aggregate`) when you need a complete, time-bounded record. The `.json` file is optimised for "what is the latest state?" lookups.

### MCP resource: `switchbot://events`

Read-only snapshot of recent MQTT shadow-update events from the ring buffer. Returns `{state, count, events[]}`.

Enabled when `SWITCHBOT_MQTT_HOST` / `SWITCHBOT_MQTT_USERNAME` / `SWITCHBOT_MQTT_PASSWORD` env vars are set; returns `{state:"disabled", count:0, events:[]}` otherwise. To enable real-time events, add those three env vars to the MCP server config alongside `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET`.

---

## Surface 2: Structured plans (`switchbot plan`)

Agents that prefer "emit JSON, let the CLI execute it" avoid the MCP dependency. The plan schema is fixed (versioned at `1.0`), so you can fine-tune prompts or tool definitions once and reuse them across models.

### The schema

```bash
switchbot plan schema > plan.schema.json
```

Give that file to your agent framework (OpenAI tool schema, Anthropic JSON mode, function-calling, etc.) and it will produce plans shaped like:

```json
{
  "version": "1.0",
  "description": "Evening wind-down",
  "steps": [
    { "type": "command", "deviceId": "STRIP1", "command": "setColorTemperature", "parameter": 2700 },
    { "type": "wait", "ms": 500 },
    { "type": "command", "deviceId": "BOT1",   "command": "turnOff" },
    { "type": "scene",   "sceneId": "T_BEDTIME" }
  ]
}
```

### Validate first, run later

```bash
cat plan.json | switchbot plan validate -           # exit 2 on schema error
cat plan.json | switchbot --dry-run plan run -      # preview — mutations skipped
cat plan.json | switchbot plan run - --yes          # allow destructive steps
cat plan.json | switchbot --json plan run -         # machine-readable outcome
```

### Run semantics

- Steps execute sequentially. A failed step stops the run (exit 1) unless you pass `--continue-on-error`.
- `wait` uses `setTimeout`; `ms` is capped at 600 000 so a malformed plan can't hang the agent.
- Destructive commands are **skipped** (not failed) without `--yes`, so an agent that omits the flag gets a clean "needs confirmation" summary.
- Every successful/failed step lands in `--audit-log` (see [Observability](#observability)).

---

## Surface 3: Direct JSON invocation

### `--json` vs `--format=json` — pick the right one

| Flag | Output | When to use |
|------|--------|-------------|
| `--json` | **Raw API payload** — exact JSON the SwitchBot API returned | `jq` pipelines, scripts that need the full response body |
| `--format=json` | **Projected row view** — CLI column model, `--fields` applies | When you only need specific fields; consistent shape across all commands |

`--json` and `--format=json` differ only in output shape — they share the same HTTP client and auth.

Errors follow the same envelope on both paths (stderr):

```json
{ "error": { "code": 152, "kind": "api", "message": "...", "hint": "...", "retryable": false } }
```

Error `kind` values: `api` (SwitchBot API error), `runtime` (network/auth failure), `usage` (bad flag or unknown field), `guard` (destructive command blocked without `confirm:true`).

```bash
switchbot --json devices list | jq '.deviceList[] | select(.deviceType=="Bot") | .deviceId'
switchbot --json devices describe <id>
switchbot --json --dry-run devices command <id> turnOff
switchbot --json scenes execute <sceneId>
```

### `--fields` — strict column filter

`--fields` projects output to a named subset of columns. Field names are the exact column headers a command outputs (listed in `--help`). Unknown names exit 2 immediately with the list of allowed names — there is no silent fallback.

```bash
# Allowed fields for each command are in its --help text:
switchbot devices list --help          # "Output columns: deviceId, deviceName, ..."
switchbot scenes list --help           # "Output columns: sceneId, sceneName"

# For `devices status`, fields are device-specific — discover them first:
switchbot devices status <id> --format yaml   # shows all field names for this device
switchbot devices status <id> --format tsv --fields power,battery

# --format=id only works on commands with a deviceId or sceneId column:
switchbot devices list --format id     # ✓ — deviceId column present
switchbot scenes list --format id      # ✓ — sceneId column present
switchbot devices status <id> --format id  # ✗ — exits 2 (no ID column in status output)
```

### `devices expand` — semantic parameter flags

Some device commands require a packed string parameter (e.g., AC `setAll` takes `"26,2,2,on"`). `devices expand` accepts named flags and builds the parameter for you:

```bash
# Air Conditioner — setAll
switchbot devices expand <acId> setAll --temp 26 --mode cool --fan low --power on

# Curtain / Roller Shade — setPosition
switchbot devices expand <curtainId> setPosition --position 50 --mode silent

# Blind Tilt — setPosition
switchbot devices expand <blindId> setPosition --direction up --angle 50

# Relay Switch — setMode
switchbot devices expand <relayId> setMode --channel 1 --mode edge
```

Use `switchbot devices expand --help` or `switchbot devices expand <id> <command> --help` for the full flag list per command.

---

## Catalog: the shared contract

Every device, command, and parameter the CLI knows about lives in the **catalog**. Dumping it gives you a prompt-ready description of the controllable surface area:

```bash
switchbot schema export > catalog.json
switchbot schema export --type 'Smart Lock' | jq '.types[0].commands'
```

Each command entry carries:

- `idempotent` — safe to retry
- `destructive` — requires explicit confirmation
- `parameter` / `exampleParams` — what the agent should fill in
- `commandType` (`command` vs `customize`) — built-in vs user-defined IR button

Use `switchbot doctor` to confirm the CLI is healthy before orchestrating anything non-trivial — it validates credentials, catalog size, cache state, clock drift, and quota file access.

---

## Safety rails

1. **Destructive-command guard**: Smart Lock `unlock`, Garage Door `open`, and anything else tagged `destructive: true` in the catalog **refuses to run** without `--yes` (or `confirm: true` in MCP, or explicit dev intent). There is no bypass flag for autonomous agents beyond `--yes` — that's by design.
2. **Dry-run**: Global `--dry-run` short-circuits every mutating HTTP request. GETs still execute. Command names are validated against the device catalog — unknown commands exit 2 when the device type has a known catalog entry, as do commands on read-only sensors. Use it for any "what would this do?" flow before letting the agent commit.
3. **Quota**: The SwitchBot API has a per-account daily quota. `--retry-on-429 <n>` and `--backoff <linear|exponential>` handle throttling; `~/.switchbot/quota.json` tracks daily counts.
4. **Audit log**: `--audit-log [path]` appends every mutating command (including dry-runs) to JSONL for post-hoc review.
5. **Non-zero exit codes are stable**: `0` success, `1` runtime error, `2` usage error (bad flag, invalid plan schema).

---

## Observability

```bash
switchbot --audit-log devices command <id> turnOff        # writes ~/.switchbot/audit.log
switchbot --audit-log=/tmp/agent.log plan run plan.json   # custom path
switchbot history show --limit 20                         # pretty-print recent entries
switchbot history replay 7                                # re-run entry #7
switchbot --json history show --limit 50 | jq '.entries[] | select(.result=="error")'
```

The audit format is JSONL with this shape:

```json
{ "t": "2026-04-18T10:00:00.000Z", "kind": "command", "deviceId": "BOT1",
  "command": "turnOn", "parameter": null, "commandType": "command",
  "dryRun": false, "result": "ok" }
```

Pair with `switchbot devices watch --interval=30s` for continuous state diffs (add `--include-unchanged` to emit every tick even when nothing changed), `switchbot events tail` to receive webhook pushes locally, or `switchbot events mqtt-tail` for real-time MQTT shadow updates.

#### Routing MQTT events to an OpenClaw agent

Run `mqtt-tail` once with `--sink openclaw` to replace the SwitchBot channel plugin entirely — no separate plugin installation required:

```bash
switchbot events mqtt-tail \
  --sink openclaw \
  --openclaw-token <token> \
  --openclaw-model my-home-agent

# Persist history at the same time:
switchbot events mqtt-tail \
  --sink file --sink-file ~/.switchbot/events.jsonl \
  --sink openclaw --openclaw-token <token> --openclaw-model home
```

OpenClaw exposes an OpenAI-compatible HTTP API at `http://localhost:18789/v1/chat/completions`. The sink formats each event as a short text message (e.g. `📱 Climate Panel: 27.5°C / 51%`) and POSTs it to the agent directly.

---

## Performance and token budget

Agent contexts are expensive; the CLI is designed to be frugal.

- `switchbot devices list --format=tsv --fields=deviceId,deviceName,type,cloud` — typical output ≤ 500 chars for a 20-device account (vs ~5 KB for the default JSON).
- `switchbot devices status --format=yaml` — compact key/value, no array noise.
- `switchbot schema export --type <t>` — bring only the relevant part of the catalog into context.
- `switchbot devices describe <id> --live` returns **both** the static catalog entry and live status in one call — prefer it over separate `status` + `commands <type>` calls.
- Use `--cache=5m` when polling the same device repeatedly in a session; it caches live status locally so you don't burn the daily quota.

If you're seeing token pressure, `switchbot doctor --json | jq .checks` will also show you how big the bundled catalog is, whether cache is active, and whether credentials round-trip cleanly.
