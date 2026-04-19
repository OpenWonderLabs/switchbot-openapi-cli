# @switchbot/openapi-cli

[![npm version](https://img.shields.io/npm/v/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![npm downloads](https://img.shields.io/npm/dm/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![license](https://img.shields.io/npm/l/@switchbot/openapi-cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@switchbot/openapi-cli.svg)](https://nodejs.org)
[![CI](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml)

Command-line interface for the [SwitchBot API v1.1](https://github.com/OpenWonderLabs/SwitchBotAPI).
List devices, query live status, send control commands, run scenes, and manage webhooks — all from your terminal or shell scripts.

- **npm package:** [`@switchbot/openapi-cli`](https://www.npmjs.com/package/@switchbot/openapi-cli)
- **Source code:** [github.com/OpenWonderLabs/switchbot-openapi-cli](https://github.com/OpenWonderLabs/switchbot-openapi-cli)
- **Release notes:** [GitHub Releases](https://github.com/OpenWonderLabs/switchbot-openapi-cli/releases)
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
  - [`events`](#events--receive-mqtt-device-updates)
  - [`batch`](#batch--run-multiple-commands)
  - [`watch`](#watch--poll-device-status)
  - [`mcp`](#mcp--model-context-protocol-server)
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
- 🧪 **Fully tested** — 592 Vitest tests, mocked axios, zero network in CI
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
| `--json`                    | Print a structured JSON envelope instead of a formatted table            |
| `--json-legacy`             | Opt out of the v1.6.0 envelope — emit the bare v1.5.0 payload (removed in v1.7.0) |
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

### JSON envelope (v1.6.0+)

Every `--json` response is wrapped in a unified envelope so agents can parse one
shape across every command:

```json
{
  "schemaVersion": "1",
  "ok": true,
  "data": { /* command-specific payload */ },
  "meta": { "command": "devices.status", "durationMs": 123 }
}
```

Errors use the same envelope with `ok: false` and an `error` block:

```json
{
  "schemaVersion": "1",
  "ok": false,
  "error": { "code": 190, "kind": "api", "subKind": "device-busy", "message": "...", "hint": "...", "retryable": false },
  "meta": { "command": "devices.command", "durationMs": 12 }
}
```

Key changes vs v1.5.0:

- **Errors now go to `stdout`** in `--json` mode (previously `stderr`). Agents can pipe a single stream.
- A top-level `schemaVersion: "1"` lets consumers detect breaking shape changes.
- Streaming commands (`devices watch`, `events stream`, `events tail`) still emit **bare JSON per line** — the envelope applies to one-shot responses.

Migration: scripts that parsed `--json` against the v1.5.0 shape can either
unwrap `.data` or pass `--json-legacy` for the old bare payload (removed in
v1.7.0).

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

### `events` — receive MQTT device updates

```bash
# Subscribe to all device shadow updates over MQTT
switchbot events stream

# Filter events by device type
switchbot events stream --filter type="Motion Sensor"

# Filter by device ID and stop after 10 events
switchbot events stream --filter deviceId=ABC123 --max 10

# Verify MQTT connectivity without streaming
switchbot events stream --probe

# Output as JSONL for scripting
switchbot events stream --filter type="Contact Sensor" --json | jq '.payload.moveDetected'
```

**Important:** `events stream` depends on the **SwitchBot IoT MQTT service**, which is not part of the official OpenAPI and is not documented in the SwitchBot API reference.
This feature provides real-time device state changes but relies on an undocumented service endpoint.
If SwitchBot's policy changes, this service may become unavailable; fall back to [`devices watch`](#watch--poll-device-status) for polling-based monitoring.

Credentials are cached in `~/.switchbot/mqtt-credential.json` with a 1-hour TTL; use `--no-cache` to fetch fresh credentials.

Output is JSONL (one event per line):
```json
{ "ts": "2026-04-19T10:23:45.123Z", "deviceId": "ABC123", "deviceType": "Motion Sensor", "payload": { "battery": 92, "moveDetected": true } }
```

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

### `batch` — run multiple commands

```bash
# Run a sequence of commands from a JSON/YAML file
switchbot batch run commands.json
switchbot batch run commands.yaml --dry-run

# Validate a plan file without executing it
switchbot batch validate commands.json
```

A batch file is a JSON array of `{ deviceId, command, parameter?, commandType? }` objects.

### `watch` — poll device status

```bash
# Poll a device's status every 30 s until Ctrl-C
switchbot watch <deviceId>
switchbot watch <deviceId> --interval 10s --json
```

Output is a stream of JSON status objects (with `--json`) or a refreshed table.

### `mcp` — Model Context Protocol server

```bash
# Start the stdio MCP server (connect via Claude, Cursor, etc.)
switchbot mcp serve
```

Exposes 7 MCP tools: `list_devices`, `describe_device`, `get_device_status`, `send_command`, `list_scenes`, `run_scene`, `search_catalog`.
See [`docs/agent-guide.md`](./docs/agent-guide.md) for the full tool reference and safety rules (destructive-command guard).

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

| Variable            | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| `SWITCHBOT_TOKEN`   | API token — takes priority over the config file                    |
| `SWITCHBOT_SECRET`  | API secret — takes priority over the config file                   |
| `NO_COLOR`          | Disable ANSI colors in all output (automatically respected)        |

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
npm test                    # Run the Vitest suite (592 tests)
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
│   ├── scenes.ts
│   ├── webhook.ts
│   ├── batch.ts          # `switchbot batch run/validate`
│   ├── watch.ts          # `switchbot watch <deviceId>`
│   ├── mcp.ts            # `switchbot mcp serve` (MCP stdio server)
│   ├── cache.ts          # `switchbot cache show/clear`
│   ├── history.ts        # `switchbot history [replay]`
│   ├── events.ts         # `switchbot events`
│   ├── quota.ts          # `switchbot quota`
│   ├── explain.ts        # `switchbot explain <deviceId>`
│   ├── plan.ts           # `switchbot plan run <file>`
│   ├── doctor.ts         # `switchbot doctor`
│   ├── schema.ts         # `switchbot schema export`
│   ├── catalog.ts        # `switchbot catalog search`
│   └── completion.ts     # `switchbot completion bash|zsh|fish|powershell`
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
