# @switchbot/openapi-cli

[![npm version](https://img.shields.io/npm/v/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![npm downloads](https://img.shields.io/npm/dm/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![license](https://img.shields.io/npm/l/@switchbot/openapi-cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@switchbot/openapi-cli.svg)](https://nodejs.org)
[![CI](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml)

**SwitchBot** smart home CLI — control lights, locks, curtains, sensors, plugs, and IR appliances (TV/AC/fan) via the [SwitchBot Cloud API v1.1](https://github.com/OpenWonderLabs/SwitchBotAPI).
Run scenes, stream real-time events over MQTT, and plug AI agents into your home via the built-in MCP server — all from your terminal or shell scripts.

- **npm package:** [`@switchbot/openapi-cli`](https://www.npmjs.com/package/@switchbot/openapi-cli)
- **Source code:** [github.com/OpenWonderLabs/switchbot-openapi-cli](https://github.com/OpenWonderLabs/switchbot-openapi-cli)
- **Releases / changelog:** [GitHub Releases](https://github.com/OpenWonderLabs/switchbot-openapi-cli/releases)
- **Issues / feature requests:** [GitHub Issues](https://github.com/OpenWonderLabs/switchbot-openapi-cli/issues)

> Looking for the **conversational skill** that drives this CLI from a chat
> agent? A companion skill for third-party agent hosts is maintained in a
> separate repository.
> See [`docs/agent-guide.md`](./docs/agent-guide.md) for the authoritative
> surfaces (MCP, `agent-bootstrap`, `schema export`, `capabilities --json`)
> the skill consumes. Skill packaging + registry entry is tracked
> as Phase 3B — see [`docs/design/roadmap.md`](./docs/design/roadmap.md).

---

## Who is this for?

Three entry points, same binary — pick the one that matches how you use it:

- **Human**: start with this README ([Quick start](#quick-start)).
  You get colored tables, helpful error hints, shell completion, and
  `switchbot doctor` self-check.
- **Script**: start with [Output modes](#output-modes) and
  [Scripting examples](#scripting-examples).
  You get `--json`, `--format=tsv/yaml/id`, `--fields`, stable exit codes,
  `history replay`, and audit log support.
- **Agent**: start with [`docs/agent-guide.md`](./docs/agent-guide.md).
  You get `switchbot mcp serve` (stdio MCP server), `schema export`,
  `plan run`, and destructive-command guards.

Under the hood every surface shares the same catalog, cache, and HMAC client — switching between them costs nothing.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Credentials](#credentials)
- [Policy](#policy)
- [Global options](#global-options)
- [Commands](#commands)
  - [`config`](#config--credential-management)
  - [`devices`](#devices--list-status-control)
  - [`devices batch`](#devices-batch--bulk-commands)
  - [`devices watch`](#devices-watch--poll-status)
  - [`scenes`](#scenes--run-manual-scenes)
  - [`webhook`](#webhook--receive-device-events-over-http)
  - [`events`](#events--receive-device-events)
  - [`status-sync`](#status-sync--mqttopenclaw-bridge)
  - [`plan`](#plan--declarative-batch-operations)
  - [`mcp`](#mcp--model-context-protocol-server)
  - [`doctor`](#doctor--self-check)
  - [`health`](#health--runtime-health-report)
  - [`upgrade-check`](#upgrade-check--version-check)
  - [`quota`](#quota--api-request-counter)
  - [`history`](#history--audit-log)
  - [`catalog`](#catalog--device-type-catalog)
  - [`schema`](#schema--export-catalog-as-json)
  - [`capabilities`](#capabilities--cli-manifest)
  - [`cache`](#cache--inspect-and-clear-local-cache)
  - [`policy`](#policy--validate-scaffold-and-migrate-policyyaml)
  - [`daemon`](#daemon--background-rules-engine-process)
  - [`completion`](#completion--shell-tab-completion)
- [Output modes](#output-modes)
  - [Cache](#cache)
- [Exit codes & error codes](#exit-codes--error-codes)
- [Environment variables](#environment-variables)
- [Scripting examples](#scripting-examples)
- [Development](#development)
- [License](#license)
- [References](#references)

---

## Features

- 🔌 **Complete API coverage** — every `/v1.1` endpoint (devices, scenes, webhooks)
- 📚 **Built-in catalog** — offline reference for every device type's supported commands, parameter formats, and status fields (no API call needed)
- 🎨 **Dual output modes** — colorized tables by default; `--json` passthrough for `jq` and scripting
- 🔐 **Secure credentials** — HMAC-SHA256 signed requests; config file written with `0600`; env-var override for CI
- 🔍 **Dry-run mode** — preview every mutating request before it hits the API
- 🧪 **Fully tested** — 1900 Vitest tests, mocked axios, zero network in CI
- ⚡ **Shell completion** — Bash / Zsh / Fish / PowerShell

## Requirements

- **Node.js ≥ 18**
- A SwitchBot account with **Developer Options** enabled (see [Credentials](#credentials))

## Installation

### From npm (recommended)

```bash
npm install -g @switchbot/openapi-cli
```

This adds the `switchbot` binary to your `$PATH`.

### From source

```bash
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
cd switchbot-openapi-cli
npm install
npm run build
npm link      # optional — expose `switchbot` globally
```

Verify:

```bash
switchbot --version
switchbot --help
```

## Quick start

The fast path (credentials + policy + skill link, with rollback on failure):

```bash
switchbot install --agent claude-code --skill-path ../switchbot-skill
# or preview first
switchbot install --dry-run
```

Prefer the manual 4-step walk-through? Here it is:

```bash
# 1. Save your credentials (one-time)
switchbot config set-token <token> <secret>

# 2. List every device on your account
switchbot devices list

# 3. Control a device, writing a structured entry to the audit log
switchbot devices command <deviceId> turnOn --audit-log

# 4. Confirm everything is healthy — network, catalog, credentials, cache.
#    Any non-"ok" check prints with a hint; fix those first.
switchbot doctor --json | jq '.checks[] | select(.status!="ok")'
```

Adding an AI agent or declarative automation? A few more one-liners
round out the first-day path:

```bash
# 5. Cold-start snapshot an LLM can read before its first tool call.
switchbot agent-bootstrap --compact | jq '.identity, .devices.total'

# 6. Scaffold a policy.yaml (aliases, quiet hours, confirmations) and
#    validate it. Safe to run — defaults apply if you never edit it.
switchbot policy new
switchbot policy validate

# 7. Stream real-time device events over MQTT (events land as JSONL).
switchbot events mqtt-tail --max 3 --json

# 8. Run the OpenClaw status bridge in the background.
switchbot status-sync start --openclaw-model home-agent
```

See [Policy](#policy) for the authoring flow, [Rules engine](#rules-engine)
for automations, and [`docs/agent-guide.md`](./docs/agent-guide.md)
for the agent surface.

## Credentials

The CLI reads credentials in this order (first match wins):

1. **Environment variables** — `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET`
2. **OS keychain** — native keychain (macOS Keychain / Windows Credential Manager / libsecret on Linux) when populated via `switchbot auth keychain set`
3. **Config file** — `~/.switchbot/config.json` (written by `config set-token`, mode `0600`)

Obtain the token and secret from the SwitchBot mobile app:
**Profile → Preferences → Developer Options → Get Token**.

```bash
# One-time setup (writes ~/.switchbot/config.json)
switchbot config set-token <token> <secret>

# Or export environment variables (e.g. in CI)
export SWITCHBOT_TOKEN=...
export SWITCHBOT_SECRET=...

# Confirm which source is active and see the masked secret
switchbot config show
```

### OS keychain

Prefer native OS storage over the `0600` JSON on disk:

```bash
# See which backend is active on this machine
switchbot auth keychain describe

# Move existing ~/.switchbot/config.json into the keychain.
#   With --delete-file, the CLI deletes the source only when it contains
#   nothing except token/secret; otherwise it scrubs those fields and keeps
#   profile metadata such as labels and limits.
switchbot auth keychain migrate

# Or write credentials directly (TTY prompt or --stdin-file <path>)
switchbot auth keychain set

# Verify a profile has credentials without leaking the material
switchbot auth keychain get
```

Backends: `security(1)` on macOS, `libsecret` / `secret-tool` on Linux,
Credential Manager (via PowerShell + Win32 `CredReadW`/`CredWriteW`) on
Windows. If no native backend is available, the file backend takes
over transparently so the CLI keeps working. `switchbot doctor`
surfaces which backend is active and warns when file-stored credentials
could be moved into a writable keychain.

## Policy

`policy.yaml` is an optional per-user file that declares preferences
the CLI (and any connected AI agent) should honour: device aliases,
quiet-hours, confirmation overrides, audit-log location, and CLI
profile. The file lives at:

- Linux / macOS: default policy path resolved by the CLI
- Windows: default policy path resolved by the CLI

Everything in it is optional — if the file is missing, safe defaults
apply. Scaffold, edit, and validate:

```bash
switchbot policy new        # write a commented starter template
$EDITOR <policy-path>
switchbot policy validate   # exit 0 if OK, otherwise line-accurate error
```

Why most users want a policy file: it makes name resolution
deterministic. Without it, "turn on the bedroom light" falls through
the CLI's prefix/substring/fuzzy match strategies and can pick the
wrong device when two names collide. A one-line `aliases` entry
removes the ambiguity.

**Schema version.** The CLI requires **policy v0.2**. If you have an existing
v0.1 file from an earlier release, migrate it first:

```bash
switchbot policy migrate   # in-place upgrade, preserves comments
```

The v0.2 schema adds a typed `automation.rules[]` block (triggers, conditions,
throttles, dry-run) used by the rules engine (see
[Rules engine](#rules-engine)). Full field-by-field reference, validation flow,
and error catalogue: [`docs/policy-reference.md`](./docs/policy-reference.md).
Five annotated starter files covering common setups live in
[`examples/policies/`](./examples/policies/).

### Rules engine

With a policy.yaml (v0.2) you can declare automations that the CLI
executes for you. Supported triggers: **MQTT** (device events),
**cron** (schedule-driven), and **webhook** (local HTTP POST).
Supported conditions: `time_between` (quiet hours) and `device_state`
(live API check with per-tick dedup). Every fire is recorded in
`~/.switchbot/audit.log`. `rules run` is long-running; use
`daemon start` / `daemon reload` for the managed background mode.

```bash
# 1. Author rules under `automation.rules`. See examples/policies/automation.yaml
#    for a walkthrough covering the three trigger sources.

# 2. Static-check before running.
switchbot rules lint                       # exit 0 valid, 1 error
switchbot rules list --json | jq .         # structured summary

# 3. Inspect a single rule in full detail (trigger, conditions, actions,
#    cooldown, hysteresis, maxFiringsPerHour, suppressIfAlreadyDesired, last fired).
switchbot rules explain "motion on"
switchbot rules explain "motion on" --json

# 4. Run the engine. --dry-run overrides every rule into audit-only mode;
#    --max-firings bounds a demo session.
switchbot rules run --dry-run --max-firings 5

# 5. Edit policy.yaml in another shell, then hot-reload without restart.
switchbot daemon reload                    # managed daemon reload

# 6. Review recorded fires.
switchbot rules tail --follow              # stream rule-* audit lines
switchbot rules replay --since 1h --json   # per-rule fires/dries/throttled/errors
switchbot rules summary                    # aggregate fires/errors per rule (24h window)
switchbot rules last-fired -n 20           # 20 most recent fire entries

# 7. Conflict and health analysis.
switchbot rules conflicts                  # opposing actions, high-frequency MQTT,
                                           # destructive commands, quiet-hours gaps
switchbot rules doctor --json              # lint + conflicts combined; exit 0 when clean
```

When `quiet_hours` is configured in `policy.yaml`, `rules conflicts` additionally flags event-driven (MQTT / webhook) rules that lack a `time_between` condition — they would fire uninhibited during the quiet window. The hint in each finding includes a ready-to-paste `time_between` condition to add.

Webhook trigger token management:

```bash
switchbot rules webhook-rotate-token       # rotate the bearer token for webhook triggers
switchbot rules webhook-show-token         # print current token (creates one if absent)
```

See [`docs/design/phase4-rules.md`](./docs/design/phase4-rules.md) for
the engine's pipeline (subscribe → classify → match → conditions →
throttle → action → audit).

## Global options

- `--json`: Print the raw JSON response instead of a formatted table.
- `--format <fmt>`: Output format: `tsv`, `yaml`, `jsonl`, `json`, `id`.
- `--fields <cols>`: Comma-separated column names to include (for example `deviceId,type`).
- `-v`, `--verbose`: Log HTTP request/response details to stderr.
- `--dry-run`: Print mutating requests (POST/PUT/DELETE) without sending them.
- `--timeout <ms>`: HTTP request timeout in milliseconds (default `30000`).
- `--config <path>`: Override credential file location (default `~/.switchbot/config.json`).
- `--profile <name>`: Use a named credential profile (`~/.switchbot/profiles/<name>.json`).
- `--cache <dur>`: Set list and status cache TTL, for example `5m`, `1h`, `off`, `auto` (default).
- `--cache-list <dur>`: Set list-cache TTL independently (overrides `--cache`).
- `--cache-status <dur>`: Set status-cache TTL independently (default off; overrides `--cache`).
- `--no-cache`: Disable all cache reads for this invocation.
- `--retry-on-429 <n>`: Max 429 retry attempts (default `3`).
- `--no-retry`: Disable automatic 429 retries.
- `--backoff <strategy>`: Retry backoff: `exponential` (default) or `linear`.
- `--no-quota`: Disable local request-quota tracking.
- `--audit-log`: Append mutating commands to a JSONL audit log (default path `~/.switchbot/audit.log`).
- `--audit-log-path <path>`: Custom audit log path; use together with `--audit-log`.
- `-V`, `--version`: Print the CLI version.
- `-h`, `--help`: Show help for any command or subcommand.

Every subcommand supports `--help`, and most include a parameter-format reference and examples.

```bash
switchbot --help
switchbot devices command --help
```

> **Tip — required-value flags and subcommands.** Flags like `--profile`, `--timeout`, `--max`, and `--interval` take a value. If you omit it, Commander will happily consume the next token — including a subcommand name. Since v2.2.1 the CLI rejects that eagerly (exit 2 with a clear error), but if you ever hit `unknown command 'list'` after something like `switchbot --profile list`, use the `--flag=value` form: `switchbot --profile=home devices list`.

### `--dry-run`

Intercepts every non-GET request: the CLI prints the URL/body it would have
sent, then exits `0` without contacting the API. `GET` requests (list, status,
query) are still executed so you can preview the state involved. Dry-run also
validates command names against the device catalog and rejects unknown commands
(exit 2) when the device type has a known catalog entry. Commands sent to
read-only sensors (e.g. Meter) are likewise rejected.

```bash
switchbot devices command ABC123 turnOn --dry-run
# [dry-run] Would POST https://api.switch-bot.com/v1.1/devices/ABC123/commands
# [dry-run] body: {"command":"turnOn","parameter":"default","commandType":"command"}
```

## Commands

### `config` — credential management

```bash
switchbot config set-token <token> <secret>   # Save to ~/.switchbot/config.json
switchbot config show                          # Print current source + masked secret
switchbot config list-profiles                 # List saved profiles

# Print (or write) the recommended AI-agent profile template
switchbot config agent-profile                 # print to stdout
switchbot config agent-profile --write         # write to ~/.switchbot/profiles/agent.json (mode 0600)
switchbot config agent-profile --write --force # overwrite if it already exists
switchbot config agent-profile --json          # structured JSON envelope
```

### `devices` — list, status, control

```bash
# List all physical devices and IR remote devices
# Default columns (4): deviceId, deviceName, type, category
# Pass --wide for the full 10-column operator view
switchbot devices list
switchbot devices ls              # short alias for 'list'
switchbot devices list --wide
switchbot devices list --json | jq '.deviceList[].deviceId'

# IR remotes: type = remoteType (e.g. "TV"), category = "ir"
# Physical: category = "physical"
switchbot devices list --format=tsv --fields=deviceId,type,category

# Filter devices by type / name / category / room (server-side filter keys)
switchbot devices list --filter category=physical
switchbot devices list --filter type=Bot
switchbot devices list --filter name=living,category=physical

# Filter operators: = (substring; exact for `category`), ~ (substring),
# =/regex/ (case-insensitive regex). Clauses are AND-ed.
switchbot devices list --filter 'name~living'
switchbot devices list --filter 'type=/Hub.*/'
switchbot devices list --filter 'name~office,type=/Bulb|Strip/'

# Filter by family / room (family & room info requires the platform source
# header, which this CLI sends on every request)
switchbot devices list --json | jq '.deviceList[] | select(.familyName == "Home")'
switchbot devices list --json | jq '[.deviceList[], .infraredRemoteList[]] | group_by(.familyName)'

# Query real-time status of a physical device
switchbot devices status <deviceId>
switchbot devices status <deviceId> --json

# Resolve device by fuzzy name instead of ID (status, command, describe, expand, watch)
switchbot devices status --name "Living Room AC"
switchbot devices command --name "Office Light" turnOn
switchbot devices describe --name "Kitchen Bot"

# Batch status across multiple devices
switchbot devices status --ids ABC,DEF,GHI
switchbot devices status --ids ABC,DEF --fields power,battery  # only show specific fields
switchbot devices status --ids ABC,DEF --format jsonl           # one JSON line per device

# Send a control command
switchbot devices command <deviceId> <cmd> [parameter] [--type command|customize]

# Describe a specific device (1 API call): metadata + supported commands + status fields
switchbot devices describe <deviceId>
switchbot devices describe <deviceId> --json

# Discover what's supported (offline reference, no API call)
switchbot devices types                 # List all device types + IR remote types (incl. role column)
switchbot devices commands <type>       # Show commands, parameter formats, and status fields
switchbot devices commands Bot
switchbot devices commands "Smart Lock"
switchbot devices commands curtain      # Case-insensitive, substring match
```

#### Filter expressions — per-command reference

Three commands accept `--filter`. They share one four-operator grammar,
but each exposes its own key set:

- `devices list`
  Operators: `=` (substring; **exact** for `category`), `!=` (negated),
  `~` (substring), `=/regex/` (case-insensitive regex).
  Keys: `type`, `name`, `category`, `room`.
- `devices batch`
  Operators: same as `devices list`.
  Keys: `type`, `family`, `room`, `category`.
- `events tail` / `events mqtt-tail`
  Operators: same (tail only; mqtt-tail uses `--topic` instead).
  Keys: `deviceId`, `type`.

Clauses are comma-separated and AND-ed. No OR across clauses — use regex
alternation (`=/A|B/`) for that. `category` is the one key that stays exact
under `=` / `!=` to preserve `category=physical` / `category!=ir` semantics.
A clause with an empty value (e.g. `name~`, `type=`) is rejected with exit 2 —
the parser refuses to guess whether an empty value means "no constraint" or
"match empty string". Drop the clause outright to remove the constraint.

#### Parameter formats

`parameter` is optional — omit it for commands like `turnOn`/`turnOff` (auto-defaults to `"default"`).
Numeric-only and JSON-object parameters are auto-parsed; strings with colons / commas / semicolons pass through as-is.

For the exact commands and parameter formats a specific device supports, query the built-in catalog:

```bash
switchbot devices commands <type>       # e.g. Bot, Curtain, "Smart Lock", "Robot Vacuum Cleaner S10"
```

Generic parameter shapes (which one applies is decided by the device — see the catalog):

| Shape               | Example                                                  |
| ------------------- | -------------------------------------------------------- |
| _(none)_            | `devices command <id> turnOn`                            |
| `<integer>`         | `devices command <id> setBrightness 75`                  |
| `<R:G:B>`           | `devices command <id> setColor "255:0:0"`                |
| `<direction;angle>` | `devices command <id> setPosition "up;60"`               |
| `<a,b,c,…>`         | `devices command <id> setAll "26,1,3,on"`                |
| `<json object>`     | `'{"action":"sweep","param":{"fanLevel":2,"times":1}}'`  |
| Custom IR button    | `devices command <id> MyButton --type customize`         |

Parameters for `setAll` (Air Conditioner), `setPosition` (Curtain / Blind Tilt), `setMode` (Relay Switch), `setBrightness` (dimmable lights), and `setColor` (Color Bulb / Strip Light / Ceiling Light) are validated client-side before the request — malformed shapes, out-of-range values, and JSON for CSV fields all fail fast with exit 2. `setColor` accepts `R:G:B`, `R,G,B`, `#RRGGBB`, `#RGB`, and CSS named colors (`red`, `blue`, …); all normalize to `R:G:B` before hitting the API. Pass `--skip-param-validation` to bypass (escape hatch — prefer fixing the argument). Command names are also case-normalized against the catalog (e.g. `turnon` is auto-corrected to `turnOn` with a stderr warning); unknown names still exit 2 with the supported-commands list.

Unknown deviceIds (not in the local cache) exit 2 by default so `--dry-run` is a reliable pre-flight gate. Unknown command names and commands on read-only sensors are also rejected during dry-run when the device type has a catalog entry. Run `switchbot devices list` first, or pass `--allow-unknown-device` for scripted pass-through.

Negative numeric parameters (e.g. `setBrightness -1` for a probe) are passed through to the command validator instead of being swallowed by the flag parser as an unknown option.

For the complete per-device command reference, see the [SwitchBot API docs](https://github.com/OpenWonderLabs/SwitchBotAPI#send-device-control-commands).

#### `devices expand` — named flags for packed parameters

Some commands require a packed string like `"26,2,2,on"`. `devices expand` builds it from readable flags:

```bash
# Air Conditioner — setAll
switchbot devices expand <acId> setAll --temp 26 --mode cool --fan low --power on
# Resolve by name
switchbot devices expand --name "Living Room AC" setAll --temp 26 --mode cool --fan low --power on

# Curtain / Roller Shade — setPosition
switchbot devices expand <curtainId> setPosition --position 50 --mode silent

# Blind Tilt — setPosition
switchbot devices expand <blindId> setPosition --direction up --angle 50

# Relay Switch — setMode
switchbot devices expand <relayId> setMode --channel 1 --mode edge
```

Run `switchbot devices expand <id> <command> --help` to see the available flags for any device command. `expand` is only meaningful for multi-parameter commands (the four above); single-parameter commands like `setBrightness 50` or `setColor "#FF0000"` are already flag-free at the CLI level.

#### `devices explain` — one-shot device summary

```bash
# Metadata + supported commands + live status in one call
switchbot devices explain <deviceId>

# Skip live status fetch (catalog-only output, no API call)
switchbot devices explain <deviceId> --no-live
```

Returns a combined view: static catalog info (commands, parameters, status fields) merged with the current live status. For Hub devices, also lists connected child devices. Prefer this over separate `status` + `describe` calls.

#### `devices meta` — local device metadata

```bash
switchbot devices meta set <deviceId> --alias "Office Light"
switchbot devices meta set <deviceId> --hide          # hide from `devices list`
switchbot devices meta get <deviceId>
switchbot devices meta list                            # show all saved metadata
switchbot devices meta clear <deviceId>
```

Stores local annotations (alias, hidden flag, notes) in `~/.switchbot/device-meta.json`. The alias is used as a display name; `--show-hidden` on `devices list` reveals hidden devices.

#### `devices batch` — bulk commands

```bash
# Send the same command to every device matching a filter
switchbot devices batch turnOff --filter 'type=Bot'
switchbot devices batch setBrightness 50 --filter 'type~Light,family=Living'

# Explicit device IDs (comma-separated)
switchbot devices batch turnOn --ids ID1,ID2,ID3

# Pipe device IDs from `devices list`
switchbot devices list --format=id --filter 'type=Bot' | switchbot devices batch toggle -

# Destructive commands require --yes
switchbot devices batch unlock --filter 'type=Smart Lock' --yes

# Skip devices whose cached status is offline (default: off)
switchbot devices batch turnOn --ids ID1,ID2 --skip-offline

# --idempotency-key is an alias for --idempotency-key-prefix; both append -<deviceId>
switchbot devices batch turnOn --ids ID1,ID2 --idempotency-key morning-lights
```

Sends the same command to many devices in one run. Filter grammar matches `devices list` (`=` substring, `~` substring, `=/regex/` regex — clauses AND-ed); supported keys here are `type`, `family`, `room`, `category`. Destructive commands (Smart Lock unlock, Garage Door Opener, etc.) require `--yes` to prevent accidents.

`--skip-offline` reads from the local status cache only (no new API calls);
skipped devices appear under `summary.skipped` with `skippedReason:'offline'`.

### `scenes` — run manual scenes

```bash
switchbot scenes list                 # Columns: sceneId, sceneName
switchbot scenes execute <sceneId>

# One-shot summary: risk profile, execution hint, estimated commands
switchbot scenes explain <sceneId>
switchbot scenes explain <sceneId> --json
```

### `webhook` — receive device events over HTTP

```bash
# Register a receiver URL for events from ALL devices
switchbot webhook setup https://your.host/hook

# Query what is currently configured
switchbot webhook query
switchbot webhook query --details https://your.host/hook

# Enable / disable / re-submit the registered URL
switchbot webhook update https://your.host/hook --enable
switchbot webhook update https://your.host/hook --disable

# Remove the configuration
switchbot webhook delete https://your.host/hook
```

The CLI validates that `<url>` is an absolute `http://` or `https://` URL before calling the API. `--enable` and `--disable` are mutually exclusive.

### `events` — receive device events

Two subcommands cover the two ways SwitchBot can push state changes to you.

#### `events tail` — local webhook receiver

```bash
# Listen on port 3000 and print every incoming webhook POST
switchbot events tail

# Filter to one device
switchbot events tail --filter deviceId=ABC123

# Stop after 5 matching events
switchbot events tail --filter 'type=WoMeter' --max 5

# Stop after 10 minutes regardless of event count
switchbot events tail --for 10m

# Custom port / path
switchbot events tail --port 8080 --path /hook --json
```

Run `switchbot webhook setup https://your.host/hook` first to tell SwitchBot where to send events, then expose the local port via ngrok/cloudflared and point the webhook URL at it. `events tail` only runs the local receiver — tunnelling is up to you.

Output (one JSON line per matched event):

```json
{ "t": "2024-01-01T12:00:00.000Z", "remote": "1.2.3.4:54321", "path": "/", "body": {...}, "matched": true }
```

Filter keys: `deviceId`, `type`. Operators: `=` (substring), `~` (substring), `=/regex/` (case-insensitive regex). Clauses comma-separated and AND-ed.

#### `events mqtt-tail` — real-time MQTT stream

```bash
# Stream all shadow-update events (runs in foreground until Ctrl-C)
switchbot events mqtt-tail

# Filter to a topic subtree
switchbot events mqtt-tail --topic 'switchbot/#'

# Stop after 10 events
switchbot events mqtt-tail --max 10 --json

# Stop after a fixed duration (emits __session_start under --json before connect)
switchbot events mqtt-tail --for 30s --json
```

Connects to the SwitchBot MQTT service automatically using the same credentials configured for the REST API (`SWITCHBOT_TOKEN` + `SWITCHBOT_SECRET`). No additional MQTT configuration is required — the client certificates are provisioned on first use.

Output (one JSON line per message):

```json
{ "t": "2024-01-01T12:00:00.000Z", "topic": "switchbot/abc123/status", "payload": {...} }
```

This command runs in the foreground and streams events until you press Ctrl-C. To run it persistently in the background, use a process manager:

```bash
# pm2
pm2 start "switchbot events mqtt-tail --json" --name switchbot-events

# nohup
nohup switchbot events mqtt-tail --json >> ~/switchbot-events.log 2>&1 &
```

Run `switchbot doctor` to verify MQTT credentials are configured correctly before connecting.

### `status-sync` — MQTT/OpenClaw bridge

Use this command family when you want the CLI itself to own the lifecycle of a
long-running bridge that forwards SwitchBot MQTT shadow events into an OpenClaw
gateway. Internally it reuses `events mqtt-tail --sink openclaw`, but adds a
stable command surface for foreground execution, background startup, status
inspection, and shutdown.

```bash
# Foreground mode for supervisors / containers
switchbot status-sync run --openclaw-model home-agent

# Background mode for a normal shell session
switchbot status-sync start --openclaw-model home-agent

# Inspect the current bridge
switchbot status-sync status --json

# Stop the running bridge
switchbot status-sync stop
```

Required input:

- `OPENCLAW_MODEL` or `--openclaw-model <id>`
- `OPENCLAW_TOKEN` or `--openclaw-token <token>`

Optional input:

- `OPENCLAW_URL` or `--openclaw-url <url>`
- `--topic <pattern>` to narrow the MQTT subscription
- `SWITCHBOT_STATUS_SYNC_HOME` or `--state-dir <path>` for custom runtime state

Background mode writes these files under the state directory:

- `state.json` — current pid, start time, effective command
- `stdout.log` — child stdout
- `stderr.log` — child stderr

Foreground vs background:

- `status-sync run` keeps the bridge attached to the current terminal
- `status-sync start` detaches the bridge and returns immediately
- `status-sync status` reports whether the bridge is alive plus paths/logs
- `status-sync stop` terminates the managed bridge process tree

#### `mqtt-tail` sinks — route events to external services

By default `mqtt-tail` prints JSONL to stdout. Use `--sink` (repeatable) to route events to one or more destinations instead:

| Sink | Required flags |
| --- | --- |
| `stdout` | (default when no `--sink` given) |
| `file` | `--sink-file <path>` — append JSONL |
| `webhook` | `--webhook-url <url>` — HTTP POST each event |
| `telegram` | `--telegram-token` (or `$TELEGRAM_TOKEN`), `--telegram-chat <chatId>` |
| `homeassistant` | `--ha-url <url>` + `--ha-webhook-id` (no auth) or `--ha-token` (REST event API) |

```bash
# Generic webhook (n8n, Make, etc.)
switchbot events mqtt-tail --sink webhook --webhook-url https://n8n.local/hook/abc

# Forward to Home Assistant via webhook trigger
switchbot events mqtt-tail --sink homeassistant --ha-url http://homeassistant.local:8123 --ha-webhook-id switchbot
```

Device state is also persisted to `~/.switchbot/device-history/<deviceId>.json` (latest + 100-entry ring buffer) regardless of sink configuration. This enables the `get_device_history` MCP tool to answer state queries without an API call.

### `daemon` — background rules-engine process

Runs `switchbot rules run` as a detached background process. Tracks runtime
metadata in `~/.switchbot/daemon.state.json` and can co-launch a health HTTP
server.

```bash
# Start the daemon (no-op if already running)
switchbot daemon start
switchbot daemon start --policy ./my-policy.yaml
switchbot daemon start --healthz-port 3100     # also launch health serve on port 3100
switchbot daemon start --force                 # restart even if already running

# Inspect daemon state (pid, log path, health server, last reload)
switchbot daemon status
switchbot daemon status --json

# Hot-reload policy without restarting (sends SIGHUP on Unix, writes sentinel on Windows)
switchbot daemon reload

# Stop the daemon and any co-launched health server
switchbot daemon stop
```

Start prints the PID, log path, and state file location. If the process exits
within 300 ms of launch, start fails immediately and includes the last 20 lines
of the log in the error message for fast diagnosis.

### `completion` — shell tab-completion

```bash
# Bash: load on every new shell
echo 'source <(switchbot completion bash)' >> ~/.bashrc

# Zsh
echo 'source <(switchbot completion zsh)' >> ~/.zshrc

# Fish
switchbot completion fish > ~/.config/fish/completions/switchbot.fish

# PowerShell (profile)
switchbot completion powershell >> $PROFILE
```

Supported shells: `bash`, `zsh`, `fish`, `powershell` (`pwsh` is accepted as an alias).

### `plan` — declarative batch operations

```bash
# Print the plan JSON Schema (give to your agent framework)
switchbot plan schema

# Draft a candidate plan from natural language intent
switchbot plan suggest --intent "turn off all lights" --device <id1> --device <id2>

# Validate a plan file without running it
switchbot plan validate plan.json

# Preview — mutations skipped, GETs still execute
switchbot --dry-run plan run plan.json

# Save / review / approve / execute for destructive plans
switchbot plan save plan.json
switchbot plan review <planId>
switchbot plan approve <planId>
switchbot plan execute <planId>
switchbot plan run plan.json --continue-on-error

# Run with per-step TTY confirmation for destructive steps (human-in-the-loop)
switchbot plan run plan.json --require-approval
```

A plan file is a JSON document with `version`, `description`, and a `steps` array of `command`, `scene`, or `wait` steps. Steps execute sequentially; a failed step stops the run unless `--continue-on-error` is set. `plan run` is the preview/direct path, but destructive steps are blocked by default and should go through `plan save` → `plan review` → `plan approve` → `plan execute`. See [`docs/agent-guide.md`](./docs/agent-guide.md) for the full schema and agent integration patterns.

### `devices watch` — poll status

```bash
# Poll a device's status every 30 s until Ctrl-C
switchbot devices watch <deviceId>

# Custom interval; emit every tick even when nothing changed
switchbot devices watch <deviceId> --interval 10s --include-unchanged --json

# Time-bounded: stop after 5 minutes instead of a fixed tick count
switchbot devices watch <deviceId> --for 5m
```

Output is a JSONL stream of status-change events (with `--json`) or a refreshed table. Use `--max <n>` to stop after N ticks, or `--for <duration>` to stop after an elapsed wall-clock window (e.g. `30s`, `1h`, `2d`). When both are set, whichever limit trips first wins.

### `mcp` — Model Context Protocol server

```bash
# Start the stdio MCP server (connect via Claude, Cursor, etc.)
switchbot mcp serve
```

Exposes MCP tools (`list_devices`, `describe_device`, `get_device_status`,
`send_command`, `list_scenes`, `run_scene`, `search_catalog`,
`account_overview`, `plan_suggest`, `plan_run`, `audit_query`,
`audit_stats`, `policy_diff`, `policy_validate`, `policy_new`,
`policy_migrate`) plus a `switchbot://events` resource for real-time
shadow updates.
See [`docs/agent-guide.md`](./docs/agent-guide.md) for the full tool reference and safety rules (destructive-command guard).

### `doctor` — self-check

```bash
switchbot doctor
switchbot doctor --json
```

Runs local checks (Node version, credentials, profiles, catalog, cache, quota, clock, MQTT, policy, MCP) and exits 1 if any check fails. `warn` results exit 0. The MQTT check reports `ok` when REST credentials are configured (auto-provisioned on first use). Use this to diagnose connectivity or config issues before running automation.

`--json` output includes `maturityScore` (0–100) and `maturityLabel` (`production-ready` / `mostly-ready` / `needs-work` / `not-ready`) to give an at-a-glance readiness rating:

```bash
switchbot doctor --json | jq '{score: .data.maturityScore, label: .data.maturityLabel}'
```

Pass `--fix --yes` to auto-apply safe fixes (e.g. clear stale cache entries) without a prompt.

### `health` — runtime health report

```bash
# One-shot report: quota, audit error rate, circuit-breaker state
switchbot health check
switchbot health check --prometheus      # Prometheus text format
switchbot health check --json

# Start a long-running HTTP server with /healthz and /metrics
switchbot health serve                   # default port 3100, bind 127.0.0.1
switchbot health serve --port 8080
switchbot health serve --json            # print {"status":"listening",...} on start
```

`/healthz` returns a JSON health report (HTTP 200 when `ok`/`degraded`, 503 when circuit is open).
`/metrics` returns Prometheus text metrics (`switchbot_quota_used_total`, `switchbot_circuit_open`, …).
Port conflicts are reported immediately with a clear hint to choose a different port via `--port`.

### `upgrade-check` — version check

```bash
switchbot upgrade-check                      # human output; exits 1 when update available
switchbot upgrade-check --json               # structured JSON output
switchbot upgrade-check --timeout 5000       # custom registry timeout (ms)
```

Queries the npm registry for the latest published version and compares it against the running version. When the registry's `dist-tags.latest` is itself a prerelease (e.g. `4.0.0-rc.1`), the check is skipped and the current version is treated as up-to-date — accidental prerelease tags don't trigger spurious upgrade prompts.
`--json` output:

```json
{
  "current": "3.2.1",
  "latest": "4.0.0",
  "upToDate": false,
  "updateAvailable": true,
  "breakingChange": true,
  "installCommand": "npm install -g @switchbot/openapi-cli@4.0.0"
}
```

`breakingChange` is `true` when the latest major version is higher than the current — useful for agents or CI that need to distinguish breaking upgrades from patch releases.

### `quota` — API request counter

```bash
switchbot quota status     # today's usage + last 7 days
switchbot quota reset      # delete the counter file
```

Tracks daily API calls against the 10,000/day account limit. The counter is stored in `~/.switchbot/quota.json` and incremented on every mutating request. Pass `--no-quota` to skip tracking for a single run.

### `history` — audit log

```bash
switchbot history show              # recent entries (newest first)
switchbot history show --limit 20   # last 20 entries
switchbot history replay 7          # re-run entry #7
switchbot --json history show --limit 50 | jq '.entries[] | select(.result=="error")'
```

Reads the JSONL audit log (`~/.switchbot/audit.log` by default; override with `--audit-log --audit-log-path <path>`). Each entry records the timestamp, command, device ID, result, and dry-run flag. `replay` re-runs the original command with the original arguments.

### `catalog` — device type catalog

```bash
switchbot catalog show              # all 42 built-in types
switchbot catalog list              # alias for `show`
switchbot catalog show Bot          # one type
switchbot catalog search Hub        # fuzzy match across type / aliases / commands
switchbot catalog diff              # what a local overlay changes vs built-in
switchbot catalog path              # location of the local overlay file
switchbot catalog refresh           # reload local overlay (clears in-process cache)
```

The built-in catalog ships with the package. Create `~/.switchbot/catalog-overlay.json` to add, extend, or override type definitions without modifying the package.

### `schema` — export catalog as JSON

```bash
switchbot schema export                         # all types as structured JSON
switchbot schema export --type 'Strip Light'    # one type
switchbot schema export --role sensor           # filter by role
```

Exports the effective catalog in a machine-readable format. Pipe the output into an agent's system prompt or tool schema to give it a complete picture of controllable devices.

### `capabilities` — CLI manifest

```bash
switchbot capabilities --json
switchbot capabilities --used --json   # only types seen in the local cache
```

Prints a versioned JSON manifest describing available surfaces (CLI, MCP, MQTT, plan runner), commands, and environment variables. Every subcommand leaf now carries a `{mutating, consumesQuota, idempotencySupported, agentSafetyTier, verifiability, typicalLatencyMs}` block, and the top-level payload publishes a flat `commandMeta` path-keyed lookup so agents don't have to walk the tree. `--used` filters the per-type summary to devices actually present in the local cache (same semantics as `schema export --used`).

### `cache` — inspect and clear local cache

```bash
# Show cache status (paths, age, entry counts)
switchbot cache show

# Clear everything
switchbot cache clear

# Clear only the device-list cache or only the status cache
switchbot cache clear --key list
switchbot cache clear --key status
```

### `policy` — validate, scaffold, and migrate policy.yaml

Companion to the separate SwitchBot skill repository for third-party agent hosts. The skill reads behaviour (aliases, confirmations, quiet hours, audit path) from `policy.yaml`. This command group checks that file before the skill ever sees it, turning what used to be silent failures into line-accurate errors.

```bash
# Write a starter policy at the default location
switchbot policy new                              # writes to the resolved default policy path
switchbot policy new ./custom/policy.yaml --force

# Validate (compiler-style errors with line:col + caret + hints)
switchbot policy validate
switchbot policy validate ./custom/policy.yaml
switchbot policy validate --json | jq '.data.errors'
switchbot policy validate --no-snippet             # plain error list, no source preview

# Report the schema version the file declares
switchbot policy migrate

# Snapshot and restore the active policy
switchbot policy backup                            # write timestamped backup alongside policy file
switchbot policy backup --out ./backups/           # custom destination directory
switchbot policy restore <backup-file>             # overwrite active policy from backup (auto-backups first)
```

Path resolution order: positional `[path]` > `SWITCHBOT_POLICY_PATH` env var > default policy path.

**Exit codes:** `0` valid / `1` invalid / `2` file-not-found / `3` yaml-parse / `4` internal / `5` file already exists (on `new`, overridden with `--force`) / `6` unsupported schema version (on `migrate`).

Example — editing an alias without quoting the deviceId:

```console
$ switchbot policy validate
<policy-path>:14:11
  14 |   bedroom light: 01-abc-12345
                 ^^^^^^^^^^^^^
error: /aliases/bedroom light does not match pattern ^[A-Z0-9]{2,}-[A-Z0-9-]+$
hint:  paste the deviceId from `switchbot devices list --format=tsv`, e.g. 01-202407090924-26354212

✗ 1 error in <policy-path> (schema v0.1)
```

The default policy schema shipped with the CLI (`src/policy/schema/v0.2.json`) is mirrored as `examples/policy.schema.json` in the companion skill repo; a CI job on every push diffs the two to prevent drift.

## Output modes

- **Default** — ANSI-colored tables for `list`/`status`, key-value tables for details.
- **`--json`** — raw API payload passthrough. Output is the exact JSON the SwitchBot API returned, ideal for `jq` and scripting. Errors are also JSON on stderr: `{ "error": { "code", "kind", "message", "hint?" } }`.
- **`--format=json`** — projected row view. Same JSON structure but built from the CLI's column model (`--fields` applies). Use this when you only want specific fields.
- **`--format=tsv|yaml|jsonl|id`** — tabular text formats; `--fields` filters columns.

```bash
# Raw API payload (--json)
switchbot devices list --json | jq '.deviceList[] | {id: .deviceId, name: .deviceName}'

# Projected rows with field filter (--format)
switchbot devices list --format tsv --fields deviceId,deviceName,type,cloud
switchbot devices list --format id      # one deviceId per line
switchbot devices status <id> --format yaml
```

## Cache

The CLI maintains two local disk caches under `~/.switchbot/`:

- `devices.json`: Device metadata (id, name, type, category, hub, room…).
  Default TTL: 1 hour.
- `status.json`: Per-device status bodies.
  Default TTL: off (0).

The device-list cache powers offline validation (command name checks, destructive-command guard) and the MCP server's `send_command` tool. It is refreshed automatically on every `devices list` call.

### Cache control flags

```bash
# Turn off all cache reads for one invocation
switchbot devices list --no-cache

# Set both list and status TTL to 5 minutes
switchbot devices status <id> --cache 5m

# Set TTLs independently
switchbot devices status <id> --cache-list 2h --cache-status 30s

# Disable only the list cache (keep status cache at its current TTL)
switchbot devices list --cache-list 0
```

### Cache management commands

```bash
# Show paths, age, and entry counts
switchbot cache show

# Clear all cached data
switchbot cache clear

# Scope the clear to one store
switchbot cache clear --key list
switchbot cache clear --key status
```

### Status-cache GC

`status.json` entries are automatically evicted after 24 hours (or 10× the configured status TTL, whichever is longer), so the file cannot grow without bound even when the status cache is left enabled long-term.

## Exit codes & error codes

- `0`: Success (including `--dry-run` intercept when validation passes).
- `1`: Runtime error — API error, network failure, missing credentials.
- `2`: Usage error — bad flag, missing/invalid argument, unknown subcommand,
  unknown device type, invalid URL, conflicting flags.

Typical errors bubble up in the form `Error: <message>` on stderr. The
SwitchBot-specific error codes mapped to readable messages:

- `151`: Device type error.
- `152`: Device not found.
- `160`: Command not supported by this device.
- `161`: Device offline (BLE devices need a Hub).
- `171`: Hub offline.
- `190`: Device internal error / server busy.
- `401`: Authentication failed (check token/secret).
- `429`: Request rate too high (10,000 req/day cap).

## Environment variables

- `SWITCHBOT_TOKEN`: API token — takes priority over the config file.
- `SWITCHBOT_SECRET`: API secret — takes priority over the config file.
- `NO_COLOR`: Disable ANSI colors in all output (automatically respected).

## Scripting examples

```bash
# Turn off every Bot device
switchbot devices list --json \
  | jq -r '.deviceList[] | select(.deviceType == "Bot") | .deviceId' \
  | while read id; do switchbot devices command "$id" turnOff; done

# Dump each scene as `<id> <name>`
switchbot scenes list --json | jq -r '.[] | "\(.sceneId) \(.sceneName)"'
```

## Development

```bash
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
cd switchbot-openapi-cli
npm install

npm run dev -- <args>       # Run from TypeScript sources via tsx
npm run build               # Compile to dist/
npm test                    # Run the Vitest suite (1900 tests)
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report (v8, HTML + text)
```

### Project layout

```text
src/
├── index.ts              # Commander entry; mounts all subcommands; global flags
├── auth.ts               # HMAC-SHA256 signature (token + t + nonce → sign)
├── config.ts             # Credential load/save; env > keychain > file priority
├── api/client.ts         # axios instance + request/response interceptors;
│                         # --verbose / --dry-run / --timeout wiring
├── credentials/
│   ├── keychain.ts       # Credential store interface + OS backend selection
│   └── backends/         # macos.ts / linux.ts / windows.ts / file.ts
├── devices/
│   ├── catalog.ts        # Static device catalog (commands, params, status fields)
│   └── cache.ts          # Disk + in-memory cache for device list and status
├── install/
│   ├── steps.ts          # Generic step runner with rollback support
│   ├── preflight.ts      # Pre-flight checks (Node, npm, network, agent)
│   └── default-steps.ts  # Concrete steps: credentials, keychain, policy, skill, doctor
├── policy/
│   ├── validate.ts       # Schema version dispatch + JSON Schema validation
│   ├── migrate.ts        # v0.1 → v0.2 migration
│   ├── load.ts           # YAML file loading + error handling
│   ├── add-rule.ts       # Rule injection into automation.rules[]
│   ├── diff.ts           # Structural + line diff
│   └── schema/v0.2.json  # Authoritative v0.2 JSON Schema
├── rules/
│   ├── engine.ts         # Main orchestrator (MQTT + cron + webhook)
│   ├── matcher.ts        # Trigger + condition matchers
│   ├── action.ts         # Command renderer + executor
│   ├── throttle.ts       # Per-rule throttle gate
│   ├── cron-scheduler.ts # 5-field cron + days filter
│   ├── webhook-listener.ts # HTTP listener (bearer token, localhost-only)
│   ├── pid-file.ts       # Hot-reload via SIGHUP or sentinel file
│   ├── audit-query.ts    # Audit log filtering + aggregation
│   ├── conflict-analyzer.ts # Static conflict detection (opposing actions,
│   │                     #   high-freq MQTT, destructive cmds, quiet-hours gaps)
│   ├── suggest.ts        # Heuristic-based rule YAML generation
│   └── types.ts          # Shared rule/trigger/condition/action types
├── status-sync/
│   └── manager.ts        # Spawn/stop logic, state file, OpenClaw bridge
├── lib/
│   └── devices.ts        # Shared logic: listDevices, describeDevice, isDestructiveCommand
├── commands/
│   ├── auth.ts           # `auth keychain` subcommand group
│   ├── config.ts
│   ├── devices.ts
│   ├── expand.ts         # `devices expand` — semantic flag builder
│   ├── explain.ts        # `devices explain` — one-shot device summary
│   ├── device-meta.ts    # `devices meta` — local aliases / hide flags
│   ├── install.ts        # `switchbot install` / `uninstall`
│   ├── policy.ts         # `policy validate/new/migrate/diff/add-rule/backup/restore`
│   ├── rules.ts          # `rules suggest/lint/list/explain/run/reload/tail/replay/
│   │                     #   conflicts/doctor/summary/last-fired/webhook-*`
│   ├── scenes.ts
│   ├── health.ts         # `health check/serve` — report + HTTP endpoints
│   ├── upgrade-check.ts  # `upgrade-check` — npm registry version check
│   ├── status-sync.ts    # `status-sync run/start/stop/status`
│   ├── webhook.ts
│   ├── watch.ts          # `devices watch <deviceId>`
│   ├── events.ts         # `events tail` / `events mqtt-tail`
│   ├── mcp.ts            # `mcp serve` (MCP stdio/HTTP server)
│   ├── plan.ts           # `plan run/validate/suggest`
│   ├── cache.ts          # `cache show/clear`
│   ├── history.ts        # `history show/replay`
│   ├── quota.ts          # `quota status/reset`
│   ├── catalog.ts        # `catalog show/diff/path`
│   ├── schema.ts         # `schema export`
│   ├── doctor.ts         # `doctor`
│   ├── capabilities.ts   # `capabilities`
│   └── completion.ts     # `completion bash|zsh|fish|powershell`
└── utils/
    ├── flags.ts          # Global flag readers (isVerbose / isDryRun / getCacheMode / …)
    ├── output.ts         # printTable / printKeyValue / printJson / handleError
    ├── format.ts         # renderRows / filterFields / output-format dispatch
    ├── audit.ts          # JSONL audit log writer
    └── quota.ts          # Local daily-quota counter
tests/                    # Vitest suite (1900 tests, mocked axios, no network)
```

### Release flow

Releases are cut on tag push and published to npm by GitHub Actions:

```bash
npm version patch        # bump version + create git tag
git push --follow-tags
```

Then on GitHub → **Releases → Draft a new release → select tag → Publish**. The `publish.yml` workflow runs tests, verifies the tag matches `package.json`, and publishes `@switchbot/openapi-cli` to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements).

## License

[MIT](./LICENSE) © chenliuyun

## References

- [SwitchBot API v1.1 documentation](https://github.com/OpenWonderLabs/SwitchBotAPI)
- Base URL: `https://api.switch-bot.com`
- Rate limit: 10,000 requests/day per account
