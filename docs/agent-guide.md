# Agent Guide

This guide covers everything an LLM agent (Claude, GPT, Cursor, Zed, a homegrown orchestrator…) needs to drive SwitchBot devices through the `switchbot` CLI **safely** and **reliably**, without the agent needing to guess at device-specific JSON payloads.

If you're a human looking for a tour, start with the [top-level README](../README.md). This file assumes you're writing code that *calls* the CLI or embeds the MCP server.

> **Skill packaging.** This repository distributes OpenClaw, Claude Code,
> Gemini and Codex integrations. The Codex plugin (`switchbot`) retains
> its Skill + MCP architecture and existing startup contract.
> The documented CLI/MCP surfaces are the shared contract. Check offline
> catalog/bootstrap compatibility with
> `switchbot doctor --json | jq '.data.checks[] | select(.name=="catalog-schema")'`.

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

### Available tools (29, including 3 deprecated aliases)

The default profile exposes 18 tools; `--tools readonly` exposes 15. Policy, audit and rule-administration tools require `--tools all`. Installations keep the safe default rather than enabling all tools merely for onboarding.

| Tool | Purpose | Safety tier |
| --- | --- | --- |
| `list_devices` | Enumerate physical devices + IR remotes | read |
| `get_device_status` | Live status for one device | read |
| `device_diary` | Read Kata diary/AI diary/comic diary over a millisecond window of at most 31 days; detail strings and image storage keys remain raw | read |
| `send_command` | Dispatch a built-in or customize command | action (destructive needs `confirm: true` and still defaults to reviewed execution) |
| `list_scenes` | Enumerate saved manual scenes | read |
| `run_scene` | Execute a saved manual scene | action |
| `search_catalog` | Look up device type by name/alias | read |
| `describe_device` | Catalog-derived capabilities + optional live status | read |
| `account_overview` | Cold-start snapshot (devices/scenes/quota/cache/MQTT) | read |
| `device_history` | Read locally-persisted history. mode: "raw" (latest + ring) / "query" (time-range JSONL) / "aggregate" (bucketed stats) | read |
| `mindclip_recordings` | AI MindClip recordings. action: `"list"`, `"get"` metadata, `"summary"`, or `"transcript"` transcription status/result | read |
| `mindclip_list_todos` | List AI-extracted to-dos pulled from voice recordings | read |
| `mindclip_recall` | AI-curated recall views. period: `"daily"` daily recall / `"weekly"` weekly summary / `"urgent_todos"` urgent to-dos | read |
| `policy_validate` | Validate policy.yaml | read |
| `policy_new` | Scaffold a starter policy file | action |
| `policy_migrate` | Upgrade policy schema in-place | action |
| `policy_diff` | Compare two policy files (`leftPath/rightPath/equal/.../diff`) | read |
| `plan_suggest` | Draft plan JSON from intent + devices | read |
| `plan_run` | Validate and execute a plan JSON object | action |
| `audit_query` | Filter audit log entries | read |
| `audit_stats` | Aggregate audit stats by kind/result/device/rule | read |
| `rules_suggest` | Draft automation rule YAML from intent | read |
| `rule_notifications` | Query rule notification delivery history | read |
| `rules_explain` | Show why a rule evaluation fired or was blocked | read |
| `rules_simulate` | Simulate a rule against historical events | read |
| `policy_add_rule` | Inject rule YAML into `automation.rules[]` with diff | action |

The MCP server refuses destructive commands (Smart Lock `unlock` or `deadbolt`, Garage Door `open`, etc.) unless the tool call includes `confirm: true`, and the default safety profile still blocks direct destructive execution in favor of the reviewed CLI flow (`plan save` → `plan review` → `plan approve` → `plan execute`). `deadbolt` releases the latch; it does not lock the door. Discover destructive classifications with `switchbot schema export | jq '[.data.types[].commands[] | select(.safetyTier=="destructive")]'`; classification is not permission to execute.

Device type resolution uses `deviceType` or, when absent, `controlType` for
both cold and warm inventory. A frame reported only by `controlType` still
requires approval for `deleteImage`, including in a cold-cache CLI batch.
Using HTTP MCP instead of stdio does not change a command's safety tier.

MCP tool failures are structured results: `isError: true` with
`structuredContent.error`. Inspect that error rather than treating a returned
tool result as success. Published output schemas retain the existing success
object and also admit this error object; no tool or machine payload was added.

Physical devices must use built-in `command` dispatch. `commandType: "customize"`
is only for a genuine user-defined button on an IR virtual remote; it cannot
reclassify or bypass safety checks for a lock, camera, or other physical device.

### Deprecated aliases (scheduled for removal in 4.0.0)

These names continue to work in 3.x but are thin wrappers over `device_history`. Migrate to the consolidated tool — it emits a single schema per session instead of three.

- `get_device_history` → `device_history(mode="raw")`
- `query_device_history` → `device_history(mode="query")`
- `aggregate_device_history` → `device_history(mode="aggregate")`

### `device_history` — zero-cost state lookup

Reads the selected credential profile's local history (mode="raw" snapshots or mode="query"/"aggregate" JSONL). Default and explicit `--profile default` use `~/.switchbot/device-history/`; named profiles use `~/.switchbot/profiles/<name>/device-history/`. Requires no API call and costs zero quota.

```json
// mode=raw, no deviceId — list all devices with stored history
{ "tool": "device_history", "mode": "raw" }
// → { "devices": [{ "deviceId": "ABC123", "latest": { "t": "...", "payload": {...} } }] }

// mode=raw, with deviceId — latest + rolling history (default 20, max 100 entries)
{ "tool": "device_history", "mode": "raw", "deviceId": "ABC123", "limit": 5 }
// → { "deviceId": "ABC123", "latest": {...}, "history": [{...}, ...] }

// mode=query — time-range filtered JSONL records
{ "tool": "device_history", "mode": "query", "deviceId": "ABC123", "since": "1h" }
// → { "deviceId": "ABC123", "count": 42, "records": [{...}, ...] }

// mode=aggregate — bucketed numeric statistics
{ "tool": "device_history", "mode": "aggregate", "deviceId": "ABC123",
  "metrics": ["temperature","humidity"], "since": "24h", "bucket": "1h" }
// → { "deviceId": "ABC123", "buckets": [{ "t": "...", "metrics": { "temperature": {"count":12,"avg":21.4} } }, ...], ... }
```

**Workflow**: run `switchbot events mqtt-tail` in the background (e.g. with pm2) to keep the history files fresh; then call `device_history` from any MCP session without consuming REST quota.

#### Device-history directory layout

After `events mqtt-tail` runs on a device, the selected profile's history directory contains up to three companion files per device:

- `<deviceId>.jsonl`: append-only, authoritative event log.
  Source of truth for `history range` and `history aggregate`.
  Rotated at ~50 MB (up to 3 segments).
- `<deviceId>.json`: latest 100-entry ring buffer.
  Written on every MQTT event. Read by MCP `device_history` (mode="raw")
  for fast, zero-quota retrieval.
- `__control.jsonl`: MQTT connection lifecycle events
  (heartbeat, connect, disconnect). Not a device log; used for diagnostics.

The `.json` file is **not** the source of truth for historical queries — use `.jsonl` (via `history range` or `history aggregate`) when you need a complete, time-bounded record. The `.json` file is optimised for "what is the latest state?" lookups.

### MCP resource: `switchbot://events`

Read-only snapshot of recent MQTT shadow-update events from the ring buffer. Returns `{state, count, events[]}`.

MQTT credentials are auto-provisioned from the startup profile's SwitchBot token and secret via the cloud IoT-credential endpoint. No separate `SWITCHBOT_MQTT_*` variables are required. Without SwitchBot credentials, the subscription is disabled. Startup may fail if cloud provisioning is unavailable; local history remains separately readable.

### Profiles and credential refresh

HTTP profile selection uses `x-switchbot-profile` before `?profile=...`; names must start with a letter/digit and contain only letters, digits, `_` and `-`. Traversal and explicit empty names are rejected before filesystem access. Named history queries, aggregates, simulations and resets cannot read or remove another profile's history.

Named HTTP profiles may store credentials only in the OS keychain; a profile
JSON file is not required. Profile lookup happens after bearer authentication.
Without complete environment credentials or a `--config` override, names
without credentials or a configuration file are rejected. An explicit override
selects the account even when the request names another valid profile; profile
syntax and bearer-token checks still apply.

MQTT subscriptions belong to the startup profile. A request for a different profile cannot read that subscription's `switchbot://events` ring or receive its MQTT account-overview fields. Restart the subscription/server after switching its account; existing streams and event history are not rebound or cleared.

Successful CLI credential mutations publish a non-secret revision for the
affected profile or `--config` directory. Running processes invalidate device
inventory, status, credential snapshots, and idempotency results on their next
use; an obsolete in-flight inventory/status response is rejected. A retained
HTTP client from the old scope fails closed, including on a 429 retry. An
already dispatched mutation is not repeated automatically and may have taken
effect; check its outcome before retrying.

Native-keychain replacements require the keychain to be available on the next
refresh; the client will not silently fall back to an older file credential.
Unchanged credentials still use the five-second keychain cache. Complete
environment credentials take precedence; `--config` bypasses the keychain.
`config set-token` updates the file, so an existing keychain entry still wins.
External environment/keychain/file edits do not publish a revision: stop
long-running processes, clear the affected scope's cache, and restart them.

If the startup profile's replacement keychain is unavailable, optional MQTT
initialization is disabled instead of using an older file credential. HTTP MCP
can still serve other valid named profiles. Restore the keychain and restart
the server to establish the startup subscription.

Offline catalog, history, audit, and policy tools do not require credentials;
policy validation needs them only with `live: true`. This also applies over
HTTP to default and known local profiles while their replacement keychain is
locked. An unknown named profile still requires credential lookup.

Credential-refresh failures inside online MCP tool callbacks retain
`isError: true` and `structuredContent.error` with kind `runtime`; the callback
does not dispatch an API request. After unlocking the replacement keychain or
repairing credentials, retry explicitly. HTTP authentication, profile-selection,
and unknown-profile lookup failures remain transport errors.

Implicit and explicit `default` use the same legacy cache paths. Named
profiles use the full SHA-256 of their name for credential/cache isolation;
obsolete short-hash inventory/status caches are ignored, not migrated.
Refresh inventory with `switchbot --profile <name> devices list`.
`--config` places caches in the config file's directory, so separate config
files in one directory share a cache scope. Account changes do not erase
policy, audit, or event history.

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

`plan suggest` uses a local heuristic, not an LLM. An explicit supported
action produces one step per supplied device. A query, negation, conflicting
actions or unclear English/Chinese wording returns a usage error rather than
inventing a `turnOn`. The rule heuristic follows the same principle: do not
treat a trigger, device name or an unsupported condition as an action.

### Validate first, run later

```bash
switchbot plan validate plan.json                  # exit 2 on schema error
switchbot --dry-run plan run plan.json              # preview; no mutations
switchbot --json plan run plan.json                 # non-destructive plans only by default
```

### Reviewing an Art Frame deletion

For **AI Art Frame** or **AI Art Frame 2** (alias **AI Art Frame Luma**),
save the following as `delete-image.json`, substituting the verified frame
ID. `oldest`, `newest`, and `random` select one eligible image from the cloud
album, including images not downloaded to the frame. The displayed image is
never eligible. Deletion cannot be undone.

If the CLI does not know the frame ID, run `switchbot --no-cache devices list`
to refresh the inventory for the same account. `--allow-unknown-device` cannot
authorize deletion. Preview with `switchbot --json devices command FRAME_ID deleteImage oldest --explain`:
`idempotent: false` means a second request could remove another image. This preview sends no command.

```json
{
  "version": "1.0",
  "steps": [
    { "type": "command", "deviceId": "FRAME_ID", "command": "deleteImage", "parameter": "oldest" }
  ]
}
```

```bash
switchbot plan save delete-image.json              # note the returned plan ID; no deletion
switchbot plan review <planId>                     # check the account, target, and selection
```

Human review shows the bound credential selector, target ID, command type and
parameter (including the image selector). Sensitive values such as passcodes
and image data are masked in the human view; treat the saved JSON as private.

Stop here unless the user approves that exact deletion. After approval, use
the same profile or `--config` to run `switchbot plan approve <planId>` and
then `switchbot --json plan execute <planId>` **once**.
Read `.data.results[].result`: `deletedImageIndex: 0` means nothing was
deleted; `remainingCount: 1` can mean only the displayed image remains, and
`remainingCount: 0` means the album is empty. Cloud success does not mean
the frame has finished. If the displayed image cannot be identified, the
command fails rather than deleting it.

Do not put this command in a rule, `never_confirm`, or a history replay.
The client does not automatically retry deletion, even on HTTP 429. After a
timeout or ambiguous outcome, inspect the album before proposing a new plan.
MCP `plan_run` is not a substitute for approval: `yes: true` alone cannot
authorize direct execution. When execution is permitted, its command step
also returns the cloud body at `structuredContent.results[].result`.

### Run semantics

- Steps execute sequentially. A failed step stops the run (exit 1) unless you pass `--continue-on-error`.
- `wait` uses `setTimeout`; `ms` is capped at 600 000 so a malformed plan can't hang the agent.
- Every command target is resolved and validated before the first mutation. Destructive direct runs without approval fail as a whole; they are not a successful skipped preview.
- `plan run --yes` is reserved for explicit dev profiles. The default production path for destructive work is `plan save` → `plan review` → `plan approve` → `plan execute`.
- `--require-approval` enables per-step TTY confirmation for destructive steps during execution. Non-TTY environments (CI, pipes) auto-reject.
- `--dry-run` previews commands, scenes and waits without applying them or sleeping. It cannot grant approval. Approved plans, even empty or wait-only plans, retain their state. Read preflight can still consume quota.
- Saved plans bind to the active profile or absolute `--config` path **and** its effective credentials. Replacing credentials under the same selector invalidates approval. An independently changed native keychain is detectable when the normal credential resolver observes it. Old selector-only approvals must be reviewed and rebound; save a new plan after an account change.
- Approval seals the reviewed plan contents. Editing the stored JSON cannot transfer consent to different parameters. Only one process may change a saved plan at once. Explicitly reapproved failures may resume after a **known rejection**: acknowledged steps reuse their recorded results. After an ambiguous reply, interrupted claim, or legacy failure without receipts, inspect the target and review a new plan for the remaining actions. Do not remove private files to force a retry.
- The optional [audit log](audit-log.md) is independent of these private execution receipts.

---

## Surface 3: Direct JSON invocation

### `--json` vs `--format=json` — pick the right one

- `--json`
  Output: the command's full payload under `.data` (not a bare SwitchBot response).
  Use when: building `jq` pipelines or scripts that need the full response body.
- `--format=json`
  Output: **Projected row view** — CLI column model, `--fields` applies.
  Use when: you only need specific fields with a consistent row shape.

`--json` and `--format=json` differ only in output shape — they share the same HTTP client and auth.

Errors use the same versioned envelope on both JSON output paths, written to stdout:

```json
{ "schemaVersion": "1.2", "error": { "code": 152, "kind": "api", "message": "...", "hint": "...", "retryable": false } }
```

Error `kind` distinguishes cloud, runtime, usage and guard failures. Read `.error.code`, `.error.hint` and `.error.retryable`; do not infer retry safety from a transient network status alone.

```bash
switchbot --json devices list | jq '.data.deviceList[] | select(.deviceType=="Bot") | .deviceId'
switchbot --json devices describe <id>
switchbot --json --dry-run devices command <id> turnOff
switchbot --json scenes execute <sceneId>
```

### Transcript and pet diary reads

```bash
switchbot --json mindclip transcript <recordingId>
switchbot --json devices diary <kataId> --start <unix-ms> --end <unix-ms>
```

MCP equivalents: `mindclip_recordings(action="transcript", id=...)` and `device_diary(deviceId=..., startTimestamp=..., endTimestamp=...)`. Transcript requests use `/recordings/{id}/transcript`, not recording metadata, and do not send an undocumented language query. Inspect the returned transcription status; pending/failed states are not completed empty transcripts. JSON-encoded detail fields remain strings. Comic/thumbnail keys are storage identifiers, not constructed download URLs.

For `mindclip_recordings(action="list")`, supply `deviceID`, `pageNum`, and
`pageSize`. `mindclip_list_todos` requires `completedNum`, `pageNum`, and
`pageSize`. Recall requires `date` for daily/urgent views or `week` for weekly;
the client never chooses a server-default date or page.

For Keypad/Keypad Touch/Keypad Vision/Keypad Vision Pro `createKey`, both
scheduled and single-use passcodes require ordered 10-digit Unix-second
`startTime` and `endTime` values.
A successful POST acknowledges acceptance, not completed passcode creation;
correlate its `commandId` with webhook `eventName`, `commandId` and `result`.
Lock Vision's less-specific object template is not assigned these restrictions.

### Idempotent command retries

`send_command` / `devices command` accept an idempotency key. Within the same
running process, credential storage scope, and account revision, reusing it for
the same device, command type and wire parameters replays the result instead of
sending another request.
Changing any of those values returns an idempotency conflict; use a new key for
a different operation. Omitted parameters and `"default"` represent the same
wire request. The cache is process-local and expires after 60 seconds: separate
CLI invocations do not share it.
`devices batch` also accepts a per-device key prefix. `plan run` and `history replay`
do not accept a deduplication key. This is a cache of successful responses, not
an exactly-once guarantee. Unknown outcomes have no cached success.

For a specific target, `devices command --explain` distinguishes `true`,
`false` and `null` in `idempotent`. A generic manifest entry can only say `caution`.
MCP keeps its existing two-valued `idempotencyHint`: `non-idempotent` means
**do not repeat**, including when custom IR behavior is unknown. Decisions use
the resolved model and command type, not the command's spelling.

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
switchbot schema export --type 'Smart Lock' | jq '.data.types[0].commands'
```

Each command entry carries:

- `idempotent` — whether repeating a cataloged operation has the same effect; not a transport retry instruction
- `safetyTier` — exported command classification; `destructive` requires the reviewed approval path
- `parameter` / `exampleParams` — what the agent should fill in
- `commandType` (`command` vs `customize`) — built-in vs user-defined IR button

### Model-specific boundaries

**Unreleased models** (after CLI 3.10.0):

- For **Plug Mini (IT)** and **Outdoor Plug (EU)**, use `get_device_status` for `switchStatus` (0 off, 1 on), `power` (W), `electricCurrent` (mA), `voltage` (V), and daily `usedElectricity` (W·min). Their separate `changeReport` events expose `online`, `overTemperature`, `overload`, and `switchStatus`, not metering samples.
- **Hub 4** is read-only. Use status for `moveDetected` and webhook `detectionState` for motion events. **Vision Doorbell** is also read-only (`version`, `battery`, `online`), with no documented webhook. `list_devices` may report `lockDeviceId` as a string or `null`, or omit it. It is inventory metadata, not a doorbell command target. Do not offer Video Doorbell's motion-detection controls.
- **Robot Vacuum Cleaner S30** supports `startClean`, `pause`, `dock`, `setVolume`, `selfClean`, and `changeParam` (no `refill`). Use `sweep` or `sweep_mop` for `startClean`. For `selfClean` use numeric mode 1 (wash mop), 2 (start drying), 3 (stop drying), or 4 (empty dustbin). Its webhook reports only changed fields: a missing battery value is not zero.
- **AI Art Frame 2** is canonical in discovery and webhook metadata. **AI Art Frame Luma** resolves to it for compatibility; it is not a third frame or a second documented webhook identity. Both frame models support [reviewed deletion](#reviewing-an-art-frame-deletion).

See the [pinned protocol notes](./openapi-alignment-ambiguities.md) for the upstream evidence and unresolved limits.

**Models first supported in CLI 3.10.0:**

The catalog recognizes the model names RGBICWW Light Bars, Smart Lock Ultra
Max, Curtain 4, Robot Vacuum Cleaner K11 Plus Pro, AI Art Frame Luma, Outdoor
Pan/Tilt Cam 3K, and Solar Pan/Tilt Cam 2K. Use `search_catalog` and
`describe_device` to determine the model's command and parameter contract;
similarly named models can differ or share an alias.

- Light Bars use object parameters; `setLightEffect` takes `{ "effectId": 0 }`
  through `{ "effectId": 25 }`.
- K11+ Pro requires at least one valid `changeParam` property. Curtain 4 uses
  the normal curtain position tuple. AI Art Frame 2 accepts the established
  one-source upload object (`imageUrl` or `imageBase64`, never both).
- Outdoor Pan/Tilt Cam 3K is status-only. For both new cameras, `latestImage`
  is an optional object whose `expireAt` is Unix seconds; do not download its
  URL or assume a cached URL remains valid. Solar supports only motion-detection
  enable/disable; disabling detection is destructive.

Use `switchbot doctor` to confirm the CLI is healthy before orchestrating anything non-trivial — it validates credentials, catalog size, cache state, clock drift, and quota file access.

---

## Safety rails

1. **Destructive-command guard**: Smart Lock `unlock`/`deadbolt`, Solar motion-detection disable, Garage Door `open`, and anything else tagged `destructive: true` **refuse direct execution** in the default profile. `--yes` or `confirm: true` confirms intent; neither grants direct-execution permission. Use the reviewed plan workflow, or an explicit dev/override permission plus confirmation.
2. **Dry-run and dispatch type**: Global `--dry-run` short-circuits mutating requests; GETs still execute. Unknown physical device types and unsupported commands fail closed. A physical device cannot use `customize`; explicit custom IR buttons remain available only for IR virtual remotes.
3. **Quota**: The API applies account limits and throttling. `--retry-on-429 <n>` and `--backoff <linear|exponential>` handle throttling; `~/.switchbot/quota.json` is a local counter, not the authoritative server quota.
4. **Audit log**: `--audit-log` enables JSONL mutation records; `--audit-log-path <path>` selects a custom file.
5. **Exit codes**: Most commands use `0` success, `1` runtime error, `2` usage error. Policy commands have documented additional codes; see [Policy reference](./policy-reference.md#validation-flow).

---

## Policy awareness

Users can declare per-account preferences in a `policy.yaml` file
(at the CLI's default policy path). Agents should
read it at session start — it holds the aliases, quiet-hours window,
and confirmation overrides the user wants honoured.

```bash
switchbot policy validate            # exit 0 if the file is healthy
switchbot policy validate --json     # data.valid + data.errors; schema failure exits 1
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
# Step 1: Save a candidate rule locally; do not change the active policy.
switchbot rules suggest --intent "turn on hallway light when motion detected" \
  --trigger mqtt --device "hallway-sensor" --device "hallway-lamp" \
  --out candidate.yaml

# Step 2: Dry-run into policy.yaml (shows diff, no write)
switchbot policy add-rule --dry-run < candidate.yaml

# Step 3: Show diff to user, wait for approval, then inject
switchbot policy add-rule --enable < candidate.yaml

# Step 4: Lint and reload
switchbot rules lint && switchbot daemon reload
```

MCP agents use `rules_suggest` + `policy_add_rule` tools for the same
pipeline without shell access.

### Rule command parameters

Rules preserve JSON whitespace and YAML literal-block newlines. They are not
shell commands: YAML consumes its own outer quotes; do not add shell quotes
around JSON.

Both `setColor 255 0 0` and `setColor 255:0:0` send `255:0:0`. RGBICWW Ceiling
Light's `setColorLightRGB` also accepts both forms. Object arguments can be
written directly in a YAML literal block:

```yaml
then:
  - command: 'devices command <id> setColor 255:0:0'
    device: hallway lamp
  - command: |-
      devices command <id> uploadImage {
        "imageUrl": "https://example.com/art.jpg"
      }
    device: art frame
```

Rule dry-runs require a known target/type in the active profile's cache; a cold
or unknown cache fails preflight without a network call. `rules simulate`
evaluates triggers and conditions only—it does not validate or execute actions.

### Hard limits

- **Never** set `automation.enabled: true` without explicitly informing the user.
- **Always** start a new rule with `dry_run: true` (the generator does this automatically).
- **Never** arm a rule (`dry_run: false`) on first author — require the user to confirm firings look correct via `switchbot rules tail --follow`.
- **Never** use destructive commands (`unlock`, `deadbolt`, `deleteScene`, etc.) in rule `then[]`.

### Dry-run → arm transition

After the user confirms the rule fires correctly:

```bash
# Edit policy.yaml: set dry_run: false
# Then reload:
switchbot rules lint && switchbot daemon reload
```

Use `switchbot rules replay --since 24h --json` regularly to surface misfires.

---

## Observability

```bash
switchbot --audit-log devices command <id> turnOff        # writes ~/.switchbot/audit.log
switchbot --audit-log --audit-log-path /tmp/agent.log plan run plan.json
switchbot history show --limit 20                         # pretty-print recent entries
switchbot history replay 7                                # re-run entry #7
switchbot --json history show --limit 50 | jq '.data.entries[] | select(.result=="error")'
```

The audit format is JSONL with this shape:

```json
{ "auditVersion": 2, "t": "2026-04-18T10:00:00.000Z", "kind": "command", "deviceId": "BOT1",
  "command": "turnOn", "parameter": "default", "commandType": "command",
  "dryRun": false, "result": "ok" }
```

Pair with `switchbot devices watch <id> --interval=30s` for field-level diffs (`--include-unchanged` emits unchanged ticks). Use `events tail` for local webhook events or `events mqtt-tail` for live MQTT shadow updates.

---

## Performance and token budget

CI measures serialized **bytes**, not estimated tokens. Compact bootstrap is
budgeted below 20,000 bytes on empty and four-device fixture caches; the
scoped S30 schema is budgeted below 15,000. These are fixture budgets, not
limits on a large household. Measured decision-loop costs, including repeated
history, are reported by the [household evaluator](host-compatibility.md#household-decision-evaluation).

- Use `switchbot devices list --format=tsv --fields=deviceId,deviceName,type` for a narrow inventory.
- Use `switchbot devices status <id> --format=yaml` for a key/value view.
- Use `switchbot schema export --type <type>` to include only the relevant part of the catalog.
- `switchbot devices describe <id> --live` returns **both** the static catalog entry and live status in one call — prefer it over separate `status` + `commands <type>` calls.
- Use `--cache=5m` when polling the same device repeatedly in a session; it caches live status locally so you don't burn the daily quota.

If you're seeing token pressure, `switchbot doctor --json | jq '.data.checks'` shows the bundled catalog, cache state and credential diagnostics.
