# Agent Guide

This guide covers everything an LLM agent (Claude, GPT, Cursor, Zed, a homegrown orchestrator…) needs to drive SwitchBot devices through the `switchbot` CLI **safely** and **reliably**, without the agent needing to guess at device-specific JSON payloads.

If you're a human looking for a tour, start with the [top-level README](../README.md). This file assumes you're writing code that *calls* the CLI or embeds the MCP server.

> **Skill packaging.** This CLI is the authoritative machine-readable surface.
> The conversational skill that wraps it (Claude Desktop / third-party agent
> entry points) is tracked as Phase 3B and published out of a separate repo
> — the skill has no private contract with the CLI, only the documented
> surfaces below (`mcp serve`, `agent-bootstrap`, `schema export`,
> `capabilities --json`). To detect CLI ↔ agent-bootstrap schema drift before
> a session starts, run
> `switchbot doctor --json | jq '.checks[] | select(.name=="catalog-schema")'`
> — any status other than `ok` means the skill and CLI have diverged and
> should be upgraded in lockstep.

---

## Table of contents

- [Three integration surfaces](#three-integration-surfaces)
- [Surface 1: MCP server (recommended)](#surface-1-mcp-server-recommended)
- [Surface 2: Structured plans (`switchbot plan`)](#surface-2-structured-plans-switchbot-plan)
- [Surface 3: Direct JSON invocation](#surface-3-direct-json-invocation)
- [Catalog: the shared contract](#catalog-the-shared-contract)
- [Safety rails](#safety-rails)
- [Policy awareness](#policy-awareness)
- [Autonomous rule authoring (L3)](#autonomous-rule-authoring-l3)
- [Observability](#observability)
- [Performance and token budget](#performance-and-token-budget)

---

## Three integration surfaces

All three share the same catalog, HMAC client, retry/backoff, destructive-command guard, cache, and audit-log. Choose based on how your agent is hosted:

- **MCP server**
  Use when your agent host speaks [MCP](https://modelcontextprotocol.io)
  (Claude Desktop, Cursor, Zed, Anthropic Agent SDK).
  Entry point: `switchbot mcp serve` (stdio) or `--port <n>`.
- **Plan runner**
  Use when your agent already produces structured JSON and you want the CLI
  to validate and execute it.
  Entry point: `switchbot plan run <file>` or stdin.
- **Direct CLI**
  Use when your agent wraps subprocesses and parses output directly.
  Entry point: any subcommand with `--json`.

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

### Available tools (21)

| Tool | Purpose | Safety tier |
| --- | --- | --- |
| `list_devices` | Enumerate physical devices + IR remotes | read |
| `get_device_status` | Live status for one device | read |
| `send_command` | Dispatch a built-in or customize command | action (destructive needs `confirm: true`) |
| `list_scenes` | Enumerate saved manual scenes | read |
| `run_scene` | Execute a saved manual scene | action |
| `search_catalog` | Look up device type by name/alias | read |
| `describe_device` | Catalog-derived capabilities + optional live status | read |
| `account_overview` | Cold-start snapshot (devices/scenes/quota/cache/MQTT) | read |
| `get_device_history` | Latest state + ring history from disk | read |
| `query_device_history` | Time-range query over JSONL history | read |
| `aggregate_device_history` | Bucketed statistics over history | read |
| `policy_validate` | Validate policy.yaml | read |
| `policy_new` | Scaffold a starter policy file | action |
| `policy_migrate` | Upgrade policy schema in-place | action |
| `policy_diff` | Compare two policy files (`leftPath/rightPath/equal/.../diff`) | read |
| `plan_suggest` | Draft plan JSON from intent + devices | read |
| `plan_run` | Validate and execute a plan JSON object | action |
| `audit_query` | Filter audit log entries | read |
| `audit_stats` | Aggregate audit stats by kind/result/device/rule | read |
| `rules_suggest` | Draft automation rule YAML from intent | read |
| `policy_add_rule` | Inject rule YAML into `automation.rules[]` with diff | action |

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

- `<deviceId>.jsonl`: append-only, authoritative event log.
  Source of truth for `history range` and `history aggregate`.
  Rotated at ~50 MB (up to 3 segments).
- `<deviceId>.json`: latest 100-entry ring buffer.
  Written on every MQTT event. Read by MCP `get_device_history`
  for fast, zero-quota retrieval.
- `__control.jsonl`: MQTT connection lifecycle events
  (heartbeat, connect, disconnect). Not a device log; used for diagnostics.

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

### Draft a plan from intent (heuristic scaffold)

```bash
# CLI — produces a candidate plan JSON on stdout
switchbot plan suggest --intent "turn off all lights" --device D1 --device D2

# MCP — agents can call plan_suggest({intent, device_ids}) without leaving the session
```

`plan suggest` uses keyword heuristics (no LLM) to pick a command from the intent text and generate
one step per device. Recognised verbs: `turnOn`, `turnOff`, `press`, `lock`, `unlock`, `open`, `close`,
`pause`. Defaults to `turnOn` with a warning when the intent is unclear. Always review and edit the
output before running.

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
- `--require-approval` enables per-step TTY confirmation for destructive steps — approve with `y`, reject with any other key. Non-TTY environments (CI, pipes) auto-reject. Mutually exclusive with `--json`. `--yes` takes precedence.
- Every successful/failed step lands in `--audit-log` (see [Observability](#observability)).

---

## Surface 3: Direct JSON invocation

### `--json` vs `--format=json` — pick the right one

- `--json`
  Output: **Raw API payload** — exact JSON the SwitchBot API returned.
  Use when: building `jq` pipelines or scripts that need the full response body.
- `--format=json`
  Output: **Projected row view** — CLI column model, `--fields` applies.
  Use when: you only need specific fields with a consistent row shape.

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

## Policy awareness

Users can declare per-account preferences in a `policy.yaml` file
(at the CLI's default policy path). Agents should
read it at session start — it holds the aliases, quiet-hours window,
and confirmation overrides the user wants honoured.

```bash
switchbot policy validate            # exit 0 if the file is healthy
switchbot policy validate --json     # machine-readable error envelope
```

Do **not** attempt to parse the YAML directly; let `policy validate`
parse it and surface the result. If validation fails, relay the
compiler-style error (file:line:col + hint) to the user — the CLI
already produces agent-friendly output.

Concepts an agent should honour:

- `aliases.<name>` → deviceId mapping. Prefer this over the CLI's
  match-by-name fallback, which can pick the wrong device when two
  names collide.
- `confirmations.always_confirm[]` / `confirmations.never_confirm[]` —
  per-action overrides of the tier-based confirmation default. The
  schema refuses to pre-approve destructive actions, so you can
  trust `never_confirm` not to contain `unlock` etc.
- `quiet_hours.start / end` — during this window, even `mutation`-tier
  actions require explicit user confirmation.

Full field-level reference: [`docs/policy-reference.md`](./policy-reference.md).

---

## Autonomous rule authoring (L3)

Agents operating at autonomy level L3 can **author** automation rules
programmatically — no manual policy.yaml editing required.

### Workflow

```bash
# Step 1: Generate candidate rule YAML (no side effects)
switchbot rules suggest \
  --intent "turn on hallway light when motion detected" \
  --trigger mqtt \
  --device "hallway-sensor" --device "hallway-lamp"

# Step 2: Dry-run into policy.yaml (shows diff, no write)
switchbot rules suggest --intent "..." | switchbot policy add-rule --dry-run

# Step 3: Show diff to user, wait for approval, then inject
switchbot rules suggest --intent "..." | switchbot policy add-rule --enable

# Step 4: Lint and reload
switchbot rules lint && switchbot rules reload
```

MCP agents use `rules_suggest` + `policy_add_rule` tools for the same
pipeline without shell access.

### Hard limits

- **Never** set `automation.enabled: true` without explicitly informing the user.
- **Always** start a new rule with `dry_run: true` (the generator does this automatically).
- **Never** arm a rule (`dry_run: false`) on first author — require the user to confirm firings look correct via `switchbot rules tail --follow`.
- **Never** use destructive commands (`unlock`, `deleteScene`, etc.) in rule `then[]`.

### Dry-run → arm transition

After the user confirms the rule fires correctly:

```bash
# Edit policy.yaml: set dry_run: false
# Then reload:
switchbot rules lint && switchbot rules reload
```

Use `switchbot rules replay --since 24h --json` regularly to surface misfires.

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

---

## Performance and token budget

Agent contexts are expensive; the CLI is designed to be frugal.

- `switchbot devices list --format=tsv --fields=deviceId,deviceName,type,cloud` — typical output ≤ 500 chars for a 20-device account (vs ~5 KB for the default JSON).
- `switchbot devices status --format=yaml` — compact key/value, no array noise.
- `switchbot schema export --type <t>` — bring only the relevant part of the catalog into context.
- `switchbot devices describe <id> --live` returns **both** the static catalog entry and live status in one call — prefer it over separate `status` + `commands <type>` calls.
- Use `--cache=5m` when polling the same device repeatedly in a session; it caches live status locally so you don't burn the daily quota.

If you're seeing token pressure, `switchbot doctor --json | jq .checks` will also show you how big the bundled catalog is, whether cache is active, and whether credentials round-trip cleanly.
