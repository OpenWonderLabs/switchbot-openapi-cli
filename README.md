# @switchbot/openapi-cli

[![npm version](https://img.shields.io/npm/v/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![npm downloads](https://img.shields.io/npm/dm/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![license](https://img.shields.io/npm/l/@switchbot/openapi-cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@switchbot/openapi-cli.svg)](https://nodejs.org)
[![CI](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml)

Command-line interface for the [SwitchBot API v1.1](https://github.com/OpenWonderLabs/SwitchBotAPI).
List devices, query live status, send control commands, run scenes, receive real-time events, and connect AI agents via the built-in MCP server — all from your terminal or shell scripts.

- **npm package:** [`@switchbot/openapi-cli`](https://www.npmjs.com/package/@switchbot/openapi-cli)
- **Source code:** [github.com/OpenWonderLabs/switchbot-openapi-cli](https://github.com/OpenWonderLabs/switchbot-openapi-cli)
- **Releases / changelog:** [GitHub Releases](https://github.com/OpenWonderLabs/switchbot-openapi-cli/releases)
- **Issues / feature requests:** [GitHub Issues](https://github.com/OpenWonderLabs/switchbot-openapi-cli/issues)

---

## Who is this for?

Three entry points, same binary — pick the one that matches how you use it:

| Audience  | Where to start                                                | What you get                                                                                      |
|-----------|---------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| **Human** | this README ([Quick start](#quick-start))                     | Colored tables, helpful hints on errors, shell completion, `switchbot doctor` self-check.         |
| **Script**| [Output modes](#output-modes), [Scripting examples](#scripting-examples) | `--json`, `--format=tsv/yaml/id`, `--fields`, stable exit codes, `history replay`, audit log.     |
| **Agent** | [`docs/agent-guide.md`](./docs/agent-guide.md)                | `switchbot mcp serve` (stdio MCP server), `schema export`, `plan run`, destructive-command guard. |

Under the hood every surface shares the same catalog, cache, and HMAC client — switching between them costs nothing.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Credentials](#credentials)
- [Global options](#global-options)
- [Commands](#commands)
  - [`config`](#config--credential-management)
  - [`devices`](#devices--list-status-control)
  - [`scenes`](#scenes--run-manual-scenes)
  - [`webhook`](#webhook--receive-device-events-over-http)
  - [`events`](#events--receive-device-events)
  - [`plan`](#plan--declarative-batch-operations)
  - [`devices watch`](#devices-watch--poll-status)
  - [`mcp`](#mcp--model-context-protocol-server)
  - [`doctor`](#doctor--self-check)
  - [`quota`](#quota--api-request-counter)
  - [`history`](#history--audit-log)
  - [`catalog`](#catalog--device-type-catalog)
  - [`schema`](#schema--export-catalog-as-json)
  - [`capabilities`](#capabilities--cli-manifest)
  - [`cache`](#cache--inspect-and-clear-local-cache)
  - [`completion`](#completion--shell-tab-completion)
- [Output modes](#output-modes)
- [Cache](#cache-1)
- [Exit codes & error codes](#exit-codes--error-codes)
- [Environment variables](#environment-variables)
- [Scripting examples](#scripting-examples)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)
- [References](#references)

---

## Features

- 🔌 **Complete API coverage** — every `/v1.1` endpoint (devices, scenes, webhooks)
- 📚 **Built-in catalog** — offline reference for every device type's supported commands, parameter formats, and status fields (no API call needed)
- 🎨 **Dual output modes** — colorized tables by default; `--json` passthrough for `jq` and scripting
- 🔐 **Secure credentials** — HMAC-SHA256 signed requests; config file written with `0600`; env-var override for CI
- 🔍 **Dry-run mode** — preview every mutating request before it hits the API
- 🧪 **Fully tested** — 692 Vitest tests, mocked axios, zero network in CI
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

```bash
# 1. Save your credentials (one-time)
switchbot config set-token <token> <secret>

# 2. List every device on your account
switchbot devices list

# 3. Control a device
switchbot devices command <deviceId> turnOn
```

## Credentials

The CLI reads credentials in this order (first match wins):

1. **Environment variables** — `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET`
2. **Config file** — `~/.switchbot/config.json` (written by `config set-token`, mode `0600`)

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

## Global options

| Option                      | Description                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| `--json`                    | Print the raw JSON response instead of a formatted table                 |
| `--format <fmt>`            | Output format: `tsv`, `yaml`, `jsonl`, `json`, `id`                     |
| `--fields <cols>`           | Comma-separated column names to include (e.g. `deviceId,type`)          |
| `-v`, `--verbose`           | Log HTTP request/response details to stderr                              |
| `--dry-run`                 | Print mutating requests (POST/PUT/DELETE) without sending them           |
| `--timeout <ms>`            | HTTP request timeout in milliseconds (default: `30000`)                  |
| `--config <path>`           | Override credential file location (default: `~/.switchbot/config.json`) |
| `--profile <name>`          | Use a named credential profile (`~/.switchbot/profiles/<name>.json`)    |
| `--cache <dur>`             | Set list and status cache TTL, e.g. `5m`, `1h`, `off`, `auto` (default) |
| `--cache-list <dur>`        | Set list-cache TTL independently (overrides `--cache`)                   |
| `--cache-status <dur>`      | Set status-cache TTL independently (default off; overrides `--cache`)   |
| `--no-cache`                | Disable all cache reads for this invocation                              |
| `--retry-on-429 <n>`        | Max 429 retry attempts (default: `3`)                                    |
| `--no-retry`                | Disable automatic 429 retries                                            |
| `--backoff <strategy>`      | Retry backoff: `exponential` (default) or `linear`                      |
| `--no-quota`                | Disable local request-quota tracking                                     |
| `--audit-log [path]`        | Append mutating commands to a JSONL audit log (default path: `~/.switchbot/audit.log`) |
| `-V`, `--version`           | Print the CLI version                                                    |
| `-h`, `--help`              | Show help for any command or subcommand                                  |

Every subcommand supports `--help`, and most include a parameter-format reference and examples.

```bash
switchbot --help
switchbot devices command --help
```

### `--dry-run`

Intercepts every non-GET request: the CLI prints the URL/body it would have
sent, then exits `0` without contacting the API. `GET` requests (list, status,
query) are still executed so you can preview the state involved.

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
```

### `devices` — list, status, control

```bash
# List all physical devices and IR remote devices
# Default columns (4): deviceId, deviceName, type, category
# Pass --wide for the full 10-column operator view
switchbot devices list
switchbot devices list --wide
switchbot devices list --json | jq '.deviceList[].deviceId'

# IR remotes: type = remoteType (e.g. "TV"), category = "ir"
# Physical: category = "physical"
switchbot devices list --format=tsv --fields=deviceId,type,category

# Filter by family / room (family & room info requires the 'src: OpenClaw'
# header, which this CLI sends on every request)
switchbot devices list --json | jq '.deviceList[] | select(.familyName == "Home")'
switchbot devices list --json | jq '[.deviceList[], .infraredRemoteList[]] | group_by(.familyName)'

# Query real-time status of a physical device
switchbot devices status <deviceId>
switchbot devices status <deviceId> --json

# Send a control command
switchbot devices command <deviceId> <cmd> [parameter] [--type command|customize]

# Describe a specific device (1 API call): metadata + supported commands + status fields
switchbot devices describe <deviceId>
switchbot devices describe <deviceId> --json

# Discover what's supported (offline reference, no API call)
switchbot devices types                 # List all device types + IR remote types
switchbot devices commands <type>       # Show commands, parameter formats, and status fields
switchbot devices commands Bot
switchbot devices commands "Smart Lock"
switchbot devices commands curtain      # Case-insensitive, substring match
```

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

For the complete per-device command reference, see the [SwitchBot API docs](https://github.com/OpenWonderLabs/SwitchBotAPI#send-device-control-commands).

#### `devices expand` — named flags for packed parameters

Some commands require a packed string like `"26,2,2,on"`. `devices expand` builds it from readable flags:

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

Run `switchbot devices expand <id> <command> --help` to see the available flags for any device command.

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

### `scenes` — run manual scenes

```bash
switchbot scenes list                 # Columns: sceneId, sceneName
switchbot scenes execute <sceneId>
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

# Custom port / path
switchbot events tail --port 8080 --path /hook --json
```

Run `switchbot webhook setup https://your.host/hook` first to tell SwitchBot where to send events, then expose the local port via ngrok/cloudflared and point the webhook URL at it. `events tail` only runs the local receiver — tunnelling is up to you.

Output (one JSON line per matched event):
```
{ "t": "2024-01-01T12:00:00.000Z", "remote": "1.2.3.4:54321", "path": "/", "body": {...}, "matched": true }
```

Filter keys: `deviceId=<id>`, `type=<deviceType>` (comma-separated for AND logic).

#### `events mqtt-tail` — real-time MQTT stream

```bash
# Stream all shadow-update events from the MQTT broker
switchbot events mqtt-tail

# Filter to a topic subtree
switchbot events mqtt-tail --topic 'switchbot/#'

# Stop after 10 events
switchbot events mqtt-tail --max 10 --json
```

Requires a SwitchBot-compatible MQTT broker. Set three environment variables before running:

```bash
export SWITCHBOT_MQTT_HOST=your.broker.host
export SWITCHBOT_MQTT_USERNAME=your_username
export SWITCHBOT_MQTT_PASSWORD=your_password
# SWITCHBOT_MQTT_PORT defaults to 8883 (MQTTS/TLS)
```

Output (one JSON line per message):
```
{ "t": "2024-01-01T12:00:00.000Z", "topic": "switchbot/abc123/status", "payload": {...} }
```

Run `switchbot doctor` to verify MQTT is configured correctly before connecting.

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

# Validate a plan file without running it
switchbot plan validate plan.json

# Preview — mutations skipped, GETs still execute
switchbot --dry-run plan run plan.json

# Run — pass --yes to allow destructive steps
switchbot plan run plan.json --yes
switchbot plan run plan.json --continue-on-error
```

A plan file is a JSON document with `version`, `description`, and a `steps` array of `command`, `scene`, or `wait` steps. Steps execute sequentially; a failed step stops the run unless `--continue-on-error` is set. See [`docs/agent-guide.md`](./docs/agent-guide.md) for the full schema and agent integration patterns.

### `devices watch` — poll status

```bash
# Poll a device's status every 30 s until Ctrl-C
switchbot devices watch <deviceId>

# Custom interval; emit every tick even when nothing changed
switchbot devices watch <deviceId> --interval 10s --include-unchanged --json
```

Output is a JSONL stream of status-change events (with `--json`) or a refreshed table. Use `--max <n>` to stop after N ticks.

### `mcp` — Model Context Protocol server

```bash
# Start the stdio MCP server (connect via Claude, Cursor, etc.)
switchbot mcp serve
```

Exposes 8 MCP tools (`list_devices`, `describe_device`, `get_device_status`, `send_command`, `list_scenes`, `run_scene`, `search_catalog`, `account_overview`) plus a `switchbot://events` resource for real-time shadow updates.
See [`docs/agent-guide.md`](./docs/agent-guide.md) for the full tool reference and safety rules (destructive-command guard).

### `doctor` — self-check

```bash
switchbot doctor
switchbot doctor --json
```

Runs 8 local checks (Node version, credentials, profiles, catalog, cache, quota file, clock, MQTT config) and exits 1 if any check fails. `warn` results exit 0. Use this to diagnose connectivity or config issues before running automation.

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

Reads the JSONL audit log (`~/.switchbot/audit.log` by default; override with `--audit-log`). Each entry records the timestamp, command, device ID, result, and dry-run flag. `replay` re-runs the original command with the original arguments.

### `catalog` — device type catalog

```bash
switchbot catalog show              # all 42 built-in types
switchbot catalog show Bot          # one type
switchbot catalog diff              # what a local overlay changes vs built-in
switchbot catalog path              # location of the local overlay file
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
```

Prints a versioned JSON manifest describing available surfaces (CLI, MCP, MQTT, plan runner), commands, and environment variables. Designed for agents and tooling that need to discover the CLI's capabilities programmatically.

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

| File | Contents | Default TTL |
| ---- | -------- | ----------- |
| `devices.json` | Device metadata (id, name, type, category, hub, room…) | 1 hour |
| `status.json`  | Per-device status bodies | off (0) |

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

| Code | Meaning                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Success (including `--dry-run` intercept)                                                                                 |
| `1`  | Runtime error — API error, network failure, missing credentials                                                           |
| `2`  | Usage error — bad flag, missing/invalid argument, unknown subcommand, unknown device type, invalid URL, conflicting flags |

Typical errors bubble up in the form `Error: <message>` on stderr. The SwitchBot-specific error codes that get mapped to readable English messages:

| Code | Meaning                                     |
| ---- | ------------------------------------------- |
| 151  | Device type error                           |
| 152  | Device not found                            |
| 160  | Command not supported by this device        |
| 161  | Device offline (BLE devices need a Hub)     |
| 171  | Hub offline                                 |
| 190  | Device internal error / server busy         |
| 401  | Authentication failed (check token/secret)  |
| 429  | Request rate too high (10,000 req/day cap)  |

## Environment variables

| Variable                    | Description                                                        |
| --------------------------- | ------------------------------------------------------------------ |
| `SWITCHBOT_TOKEN`           | API token — takes priority over the config file                    |
| `SWITCHBOT_SECRET`          | API secret — takes priority over the config file                   |
| `SWITCHBOT_MQTT_HOST`       | MQTT broker hostname (enables real-time events via `events mqtt-tail` and `mcp serve`) |
| `SWITCHBOT_MQTT_PORT`       | MQTT broker port (default: `8883`, MQTTS/TLS)                      |
| `SWITCHBOT_MQTT_USERNAME`   | MQTT broker username                                               |
| `SWITCHBOT_MQTT_PASSWORD`   | MQTT broker password                                               |
| `NO_COLOR`                  | Disable ANSI colors in all output (automatically respected)        |

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
npm test                    # Run the Vitest suite (692 tests)
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report (v8, HTML + text)
```

### Project layout

```
src/
├── index.ts              # Commander entry; mounts all subcommands; global flags
├── auth.ts               # HMAC-SHA256 signature (token + t + nonce → sign)
├── config.ts             # Credential load/save; env > file priority; --config override
├── api/client.ts         # axios instance + request/response interceptors;
│                         # --verbose / --dry-run / --timeout wiring
├── devices/
│   ├── catalog.ts        # Static device catalog (commands, params, status fields)
│   └── cache.ts          # Disk + in-memory cache for device list and status
├── lib/
│   └── devices.ts        # Shared logic: listDevices, describeDevice, isDestructiveCommand
├── commands/
│   ├── config.ts
│   ├── devices.ts
│   ├── expand.ts         # `devices expand` — semantic flag builder
│   ├── explain.ts        # `devices explain` — one-shot device summary
│   ├── device-meta.ts    # `devices meta` — local aliases / hide flags
│   ├── scenes.ts
│   ├── webhook.ts
│   ├── watch.ts          # `devices watch <deviceId>`
│   ├── events.ts         # `events tail` / `events mqtt-tail`
│   ├── mcp.ts            # `mcp serve` (MCP stdio/HTTP server)
│   ├── plan.ts           # `plan run/validate`
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
    ├── output.ts         # printTable / printKeyValue / printJson / handleError / buildErrorPayload
    ├── format.ts         # renderRows / filterFields / output-format dispatch
    ├── audit.ts          # JSONL audit log writer
    └── quota.ts          # Local daily-quota counter
tests/                    # Vitest suite (592 tests, mocked axios, no network)
```

### Release flow

Releases are cut on tag push and published to npm by GitHub Actions:

```bash
npm version patch        # bump version + create git tag
git push --follow-tags
```

Then on GitHub → **Releases → Draft a new release → select tag → Publish**. The `publish.yml` workflow runs tests, verifies the tag matches `package.json`, and publishes `@switchbot/openapi-cli` to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements).

## Contributing

Bug reports, feature requests, and PRs are welcome.

1. Fork the repo and create a topic branch.
2. Keep changes small and focused; add or update Vitest cases for any behavior change.
3. Run `npm test` and `npm run build` locally — both must pass.
4. Open a pull request against `main`. CI runs on Node 18/20/22; all three must stay green.

## License

[MIT](./LICENSE) © chenliuyun

## References

- [SwitchBot API v1.1 documentation](https://github.com/OpenWonderLabs/SwitchBotAPI)
- Base URL: `https://api.switch-bot.com`
- Rate limit: 10,000 requests/day per account
