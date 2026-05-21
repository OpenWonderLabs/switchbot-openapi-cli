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

- [Features](#features) · [Supported devices](#supported-devices) · [Requirements](#requirements) · [Installation](#installation)
- [Quick start](#quick-start)
- [Credentials](#credentials)
- [Policy](#policy) · [Rules engine](#rules-engine)
- [Global options](#global-options)
- [Commands](#commands): [config](#config--credential-management) · [devices](#devices--list-status-control) · [scenes](#scenes--run-manual-scenes) · [webhook](#webhook--receive-device-events-over-http) · [events](#events--receive-device-events) · [status-sync](#status-sync--mqttopenclaw-bridge) · [daemon](#daemon--background-rules-engine-process) · [plan](#plan--declarative-batch-operations) · [mcp](#mcp--model-context-protocol-server) · [doctor](#doctor--self-check) · [health](#health--runtime-health-report) · [upgrade-check](#upgrade-check--version-check) · [quota](#quota--api-request-counter) · [history](#history--audit-log) · [catalog](#catalog--device-type-catalog) · [schema](#schema--export-catalog-as-json) · [capabilities](#capabilities--cli-manifest) · [cache](#cache--inspect-and-clear-local-cache) · [policy cmd](#policy--validate-scaffold-and-migrate-policyyaml) · [completion](#completion--shell-tab-completion)
- [Output modes](#output-modes) · [Cache](#cache) · [Exit codes](#exit-codes--error-codes) · [Environment variables](#environment-variables)
- [Scripting examples](#scripting-examples) · [Development](#development) · [License](#license)

---

## Features

- 🔌 **Complete API coverage** — every `/v1.1` endpoint (devices, scenes, webhooks)
- 📚 **Built-in catalog** — offline reference for every device type's supported commands, parameter formats, and status fields (no API call needed)
- 🎨 **Dual output modes** — colorized tables by default; `--json` passthrough for `jq` and scripting
- 🔐 **Secure credentials** — HMAC-SHA256 signed requests; config file written with `0600`; env-var override for CI
- 🔍 **Dry-run mode** — preview every mutating request before it hits the API
- 🧪 **Fully tested** — 2500+ Vitest tests, mocked axios, zero network in CI
- ⚡ **Shell completion** — Bash / Zsh / Fish / PowerShell

## Supported devices

The built-in catalog covers every device type in the [SwitchBot Cloud API v1.1](https://github.com/OpenWonderLabs/SwitchBotAPI).
Run `switchbot catalog list` to see the full list including aliases and per-command details.

| Category | Devices |
|---|---|
| **Lighting** | Color Bulb · Strip Light · Strip Light 3 · RGBICWW Strip Light · Floor Lamp · RGBICWW Floor Lamp · Ceiling Light · Ceiling Light Pro · RGBIC Neon Rope Light · RGBIC Neon Wire Rope Light · Candle Warmer Lamp |
| **Climate** | Humidifier · Humidifier2 · Air Purifier VOC · Air Purifier Table VOC · Air Purifier PM2.5 · Air Purifier Table PM2.5 · Smart Radiator Thermostat |
| **Security** | Smart Lock · Smart Lock Pro · Smart Lock Pro Wifi · Smart Lock Ultra · Lock Lite · Lock Vision · Lock Vision Pro · Keypad · Keypad Touch · Keypad Vision · Keypad Vision Pro · Garage Door Opener · Video Doorbell |
| **Curtains & blinds** | Curtain · Curtain3 · Blind Tilt · Roller Shade |
| **Power** | Plug · Plug Mini (US) · Plug Mini (JP) · Plug Mini (EU) · Relay Switch 1 · Relay Switch 1PM · Relay Switch 2PM |
| **Fans** | Battery Circulator Fan · Circulator Fan · Standing Circulator Fan |
| **Cleaning** | Robot Vacuum Cleaner S1 · Robot Vacuum Cleaner S1 Plus · K10+ · K10+ Pro · Robot Vacuum Cleaner K10+ Pro Combo · Robot Vacuum Cleaner S10 · Robot Vacuum Cleaner S20 · Robot Vacuum Cleaner K11+ · Robot Vacuum Cleaner K20 Plus Pro |
| **Sensors** _(read-only)_ | Meter · MeterPlus · WoIOSensor · MeterPro · MeterPro(CO2) · WeatherStation · Motion Sensor · Presence Sensor · Contact Sensor · Water Detector · Wallet Finder Card |
| **Hubs** _(read-only)_ | Hub · Hub Plus · Hub Mini · Hub 2 · Hub 3 · AI Hub |
| **Cameras** _(status only)_ | Indoor Cam · Pan/Tilt Cam · Pan/Tilt Cam 2K · Pan/Tilt Cam Plus 2K · Pan/Tilt Cam Plus 3K · Outdoor Spotlight Cam |
| **Other** | Bot · AI Art Frame · Home Climate Panel · Remote |
| **IR virtual remotes** _(via Hub)_ | Air Conditioner · TV · Streamer · Set Top Box · DVD · Speaker · Fan · Light · Others |

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
Supported conditions: `time_between` (quiet hours), `device_state`
(live API check with per-tick dedup), `event_count` (rolling-window
counts over per-device history), and `llm` (AI decision — see
below). Every fire is recorded in `~/.switchbot/audit.log`. `rules run` is long-running; use
`daemon start` / `daemon reload` for the managed background mode.

**Actions** — each rule's `then` array accepts two action types:

- `type: command` (default, no `type` field required) — sends a device command, e.g. `devices command <id> turnOn`
- `type: notify` — delivers a payload to an external channel after the rule fires:
  - `channel: webhook` — HTTP POST to a URL (only `http://` and `https://` schemes are accepted; `rules lint` rejects others)
  - `channel: file` — appends a JSONL line to a local file. `to` must be an absolute path; relative or `~`-prefixed paths are rejected by `rules lint` (code `notify-relative-path`) and at runtime
  - `channel: openclaw` — HTTP POST to an OpenClaw endpoint (same protocol restriction)
  - Optional `template` field supports `{{ rule.name }}`, `{{ event.* }}`, `{{ device.id }}` placeholders. Nested fields use dot paths, e.g. `{{ event.context.deviceMac }}`; arrays index numerically, e.g. `{{ event.list.0 }}`

```yaml
then:
  - command: devices command AC_001 turnOn
  - type: notify
    channel: webhook
    to: https://your.host/hook
    template: '{"rule":"{{ rule.name }}","fired":"{{ rule.fired_at }}"}'
```

**LLM condition** — add an AI judgement step before actions fire:

```yaml
conditions:
  - llm:
      prompt: "Is the temperature above normal comfort range?"
      provider: auto          # auto | openai | anthropic | local
      cache_ttl: 5m
      budget:
        max_calls_per_hour: 20
        max_tokens_per_hour: 100000   # optional rolling 1h token cap
        max_cost_per_day_usd: 1.00    # optional rolling 24h USD cap
      on_error: pass          # fail | pass | skip
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for the cloud providers.
For `provider: local`, point `SWITCHBOT_LOCAL_LLM_URL` at any
OpenAI-compatible `/v1/chat/completions` endpoint (Ollama, llama.cpp,
vLLM, LM Studio); `SWITCHBOT_LOCAL_LLM_MODEL` picks the model and
`SWITCHBOT_LOCAL_LLM_TOOL_USE=1` opts into native tool-use when the
endpoint supports it (otherwise a structured-output fallback is used).
`rules lint` flags misconfigured LLM conditions.

**Decision trace** — set `automation.audit.evaluate_trace: sampled` (or `full`) in `policy.yaml` to record every evaluation decision.

```bash
switchbot rules lint                        # static check: exit 0 valid, 1 error
switchbot rules list --json | jq .          # structured rule summary
switchbot rules explain "motion on"         # trigger, conditions, actions, last fired
switchbot rules run --dry-run --max-firings 5  # run engine; --dry-run = audit only
switchbot daemon reload                     # hot-reload policy without restart

switchbot rules tail --follow               # stream rule-* audit lines
switchbot rules replay --since 1h --json    # per-rule fires/dries/throttled/errors
switchbot rules summary                     # aggregate fires/errors (24h)
switchbot rules conflicts                   # opposing actions, destructive cmds, quiet-hours gaps
switchbot rules doctor --json               # lint + conflicts; exit 0 when clean

switchbot rules suggest --intent "turn off AC at 11pm"
switchbot rules suggest --intent "..." --llm auto    # LLM-backed (OPENAI_API_KEY or ANTHROPIC_API_KEY)

switchbot rules trace-explain --rule "motion on" --last   # why a rule fired/was blocked
switchbot rules simulate "motion on" --since 7d --json    # replay without running the engine
```

LLM-generated rules always have `dry_run: true` — flip it yourself after review. Notify URLs must be `http://` or `https://`. See [`docs/design/phase4-rules.md`](./docs/design/phase4-rules.md) for the full pipeline.

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

Every subcommand supports `--help`. Use `--flag=value` form when a flag takes a value and is followed by a subcommand (e.g. `switchbot --profile=home devices list`).

### `--dry-run`

Intercepts every non-GET request: prints the URL/body it would have sent, then exits `0`. GET requests still execute. Also validates command names against the device catalog (exit 2 on unknown commands or read-only sensors).

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
switchbot config agent-profile --write         # write recommended AI-agent profile (mode 0600)
```

### `devices` — list, status, control

```bash
# List all physical devices and IR remote devices
switchbot devices list                         # default 4 columns: deviceId, deviceName, type, category
switchbot devices list --wide                  # full 10-column operator view
switchbot devices list --json | jq '.deviceList[].deviceId'
switchbot devices list --format=tsv --fields=deviceId,type,category

# Filter by type / name / category / room
# Operators: = (substring; exact for category), ~ (substring), =/regex/; clauses AND-ed
switchbot devices list --filter 'type=Bot'
switchbot devices list --filter 'name~living,type=/Bulb|Strip/'
switchbot devices list --filter 'category=physical'

# Query real-time status
switchbot devices status <deviceId>
switchbot devices status --ids ABC,DEF,GHI    # batch status
switchbot devices status --ids ABC,DEF --fields power,battery --format jsonl

# Resolve device by fuzzy name instead of ID (status, command, describe, expand, watch)
switchbot devices status --name "Living Room AC"
switchbot devices command --name "Office Light" turnOn

# Send a control command
switchbot devices command <deviceId> <cmd> [parameter] [--type command|customize]

# Offline reference (no API call)
switchbot devices types                        # all device types
switchbot devices commands <type>              # commands, parameter formats, status fields
```

Parameters for `setAll`, `setPosition`, `setMode`, `setBrightness`, and `setColor` are validated client-side (exit 2 on bad input). `setColor` accepts `R:G:B`, `#RRGGBB`, `#RGB`, and CSS names — all normalize to `R:G:B`. Pass `--skip-param-validation` to bypass. Unknown deviceIds exit 2 by default; pass `--allow-unknown-device` for scripted pass-through.

For per-device command and parameter details: `switchbot devices commands <type>` or the [SwitchBot API docs](https://github.com/OpenWonderLabs/SwitchBotAPI#send-device-control-commands).

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

# Color Bulb / Strip Light / Floor Lamp / Ceiling Light — setBrightness / setColor / setColorTemperature
switchbot devices expand <bulbId> setBrightness --brightness 80
switchbot devices expand <bulbId> setColor --color "#FF0000"
switchbot devices expand <bulbId> setColorTemperature --color-temp 4000
```

Run `switchbot devices expand <id> <command> --help` to see the available flags for any device command.

#### `devices explain` — one-shot device summary

```bash
switchbot devices explain <deviceId>          # metadata + commands + live status
switchbot devices explain <deviceId> --no-live # catalog-only, no API call
```

#### `devices meta` — local device metadata

```bash
switchbot devices meta set <deviceId> --alias "Office Light"
switchbot devices meta set <deviceId> --hide   # hide from `devices list`
switchbot devices meta get <deviceId>
switchbot devices meta list
switchbot devices meta clear <deviceId>
```

Stores local annotations in `~/.switchbot/device-meta.json`. `--show-hidden` on `devices list` reveals hidden devices.

#### `devices batch` — bulk commands

```bash
# Same command to every matching device
switchbot devices batch turnOff --filter 'type=Bot'
switchbot devices batch setBrightness 50 --filter 'type~Light,family=Living'
switchbot devices batch turnOn --ids ID1,ID2,ID3
switchbot devices list --format=id --filter 'type=Bot' | switchbot devices batch toggle -
switchbot devices batch unlock --filter 'type=Smart Lock' --yes  # destructive: requires --yes
```

Filter keys: `type`, `family`, `room`, `category`. Skipped-offline devices appear under `summary.skipped` when `--skip-offline` is passed.

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

#### `events tail` — local webhook receiver

```bash
switchbot events tail                              # listen on port 3000
switchbot events tail --filter deviceId=ABC123     # filter to one device
switchbot events tail --filter 'type=WoMeter' --max 5 --for 10m
switchbot events tail --port 8080 --path /hook --json
```

Run `switchbot webhook setup https://your.host/hook` first. `events tail` only runs the local receiver — tunnelling (ngrok/cloudflared) is up to you.

#### `events mqtt-tail` — real-time MQTT stream

```bash
switchbot events mqtt-tail                         # stream all shadow events (Ctrl-C to stop)
switchbot events mqtt-tail --topic 'switchbot/#'   # filter to topic subtree
switchbot events mqtt-tail --max 10 --for 30s --json
```

Credentials are provisioned automatically from the REST API config. Use `--sink` to route events to external services (`file`, `webhook`, `telegram`, `homeassistant`, `openclaw`) — see `switchbot events mqtt-tail --help` for details.

### `status-sync` — MQTT/OpenClaw bridge

Forwards SwitchBot MQTT shadow events into an OpenClaw gateway with stable lifecycle management.

```bash
switchbot status-sync run --openclaw-model home-agent   # foreground (for supervisors)
switchbot status-sync start --openclaw-model home-agent # background
switchbot status-sync status --json
switchbot status-sync stop
```

Required: `OPENCLAW_MODEL` (or `--openclaw-model`) and `OPENCLAW_TOKEN`. Optional: `OPENCLAW_URL`, `--topic`, `--state-dir`. Background mode writes `state.json`, `stdout.log`, and `stderr.log` under the state directory.

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
`get_device_history`, `query_device_history`, `aggregate_device_history`,
`send_command`, `list_scenes`, `run_scene`, `search_catalog`,
`account_overview`, `plan_suggest`, `plan_run`, `audit_query`,
`audit_stats`, `policy_diff`, `policy_validate`, `policy_new`,
`policy_migrate`, `policy_add_rule`, `rules_suggest`, `rule_notifications`,
`rules_explain`, `rules_simulate`) plus a
`switchbot://events` resource for real-time shadow updates.
`rules_suggest` accepts an optional `llm` parameter (`openai | anthropic | auto`)
to generate YAML for complex intents via an LLM backend.
`rule_notifications` returns `rule-notify` audit entries, filterable by rule
name, time range, channel, and result.
`rules_explain` returns the decision trace for a specific evaluation (why a rule
fired or was blocked); `rules_simulate` replays historical events against a rule
and reports would-fire / blocked / throttled outcomes.
See [`docs/agent-guide.md`](./docs/agent-guide.md) for the full tool reference and safety rules (destructive-command guard).

### `doctor` — self-check

```bash
switchbot doctor
switchbot doctor --json
```

Runs local checks (Node version, credentials, profiles, catalog, catalog-schema, catalog-coverage, cache, quota, clock, MQTT, policy, MCP, keychain, path, inventory, audit, daemon, daemon-ipc, health, notify-connectivity, local-llm-reachable, release-notes) and exits 1 if any check fails. `warn` results exit 0. The MQTT check reports `ok` when REST credentials are configured (auto-provisioned on first use). The `notify-connectivity` check probes webhook URLs declared in `type: notify` actions. `daemon-ipc` round-trips the JSON-RPC socket when the daemon is running (silently skipped otherwise); `local-llm-reachable` only fires when policy uses `provider: local`. Use this to diagnose connectivity or config issues before running automation.

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
switchbot upgrade-check        # exits 1 when update available
switchbot upgrade-check --json # {current, latest, upToDate, updateAvailable, breakingChange, installCommand}
```

### `quota` — API request counter

```bash
switchbot quota status     # today's usage + last 7 days (10,000/day limit)
switchbot quota reset
```

### `history` — audit log

```bash
switchbot history show --limit 20
switchbot history replay 7           # re-run entry #7
switchbot --json history show --limit 50 | jq '.entries[] | select(.result=="error")'
```

### `catalog` — device type catalog

```bash
switchbot catalog show              # all built-in types
switchbot catalog show Bot          # one type
switchbot catalog search Hub        # fuzzy match
switchbot catalog diff              # local overlay vs built-in
```

Create `~/.switchbot/catalog-overlay.json` to extend or override type definitions without modifying the package.

### `schema` — export catalog as JSON

```bash
switchbot schema export                         # all types
switchbot schema export --type 'Strip Light'
switchbot schema export --role sensor
```

### `capabilities` — CLI manifest

```bash
switchbot capabilities --json
switchbot capabilities --used --json   # only types seen in the local cache
```

Prints a versioned manifest of surfaces, commands, and environment variables. Each command leaf includes `{mutating, consumesQuota, agentSafetyTier, typicalLatencyMs}`.

### `cache` — inspect and clear local cache

```bash
switchbot cache show                   # paths, age, entry counts
switchbot cache clear                  # clear everything
switchbot cache clear --key list       # list cache only
switchbot cache clear --key status     # status cache only
```

### `policy` — validate, scaffold, and migrate policy.yaml

```bash
switchbot policy new                              # write a starter policy
switchbot policy validate                         # compiler-style errors (line:col + caret)
switchbot policy validate --json | jq '.data.errors'
switchbot policy migrate                          # upgrade v0.1 → v0.2 in-place
switchbot policy backup                           # timestamped backup
switchbot policy restore <backup-file>
```

Path resolution: positional `[path]` > `SWITCHBOT_POLICY_PATH` > default. Exit codes: `0` valid / `1` invalid / `2` missing / `3` yaml-parse / `4` internal / `5` exists (use `--force`) / `6` unsupported version.

## Output modes

- **Default** — ANSI-colored tables for `list`/`status`, key-value tables for details.
- **`--json`** — raw API payload passthrough. Errors are also JSON on **stdout**: `{ "schemaVersion": "1.2", "error": { "code", "kind", "message", "hint?" } }`.
- **`--format=json`** — projected row view; `--fields` applies.
- **`--format=tsv|yaml|jsonl|id`** — tabular text formats.

```bash
switchbot devices list --json | jq '.deviceList[] | {id: .deviceId, name: .deviceName}'
switchbot devices list --format tsv --fields deviceId,deviceName,type,cloud
switchbot devices list --format id      # one deviceId per line
```

## Cache

Two local disk caches under `~/.switchbot/`:

| Cache | Default TTL | Purpose |
|---|---|---|
| `devices.json` | 1 hour | device metadata; powers offline validation |
| `status.json` | off | per-device status; GC'd after 24h |

```bash
switchbot devices list --no-cache          # bypass for one invocation
switchbot devices status <id> --cache 5m   # set list + status TTL
switchbot devices status <id> --cache-list 2h --cache-status 30s
```

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
- `SWITCHBOT_OAUTH_CLIENT_SECRET`: Override the bundled OAuth client secret (advanced).
- `SWITCHBOT_TOKEN_AES_KEY`: Override the AES-128-CBC key used for token decryption (advanced).
- `SWITCHBOT_TOKEN_AES_IV`: Override the AES-128-CBC IV used for token decryption (advanced).
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
npm test                    # Run the Vitest suite
npm run test:watch          # Watch mode
npm run test:coverage       # Coverage report (v8, HTML + text)
```

Source layout: `src/commands/` (one file per command group), `src/devices/` (catalog + cache), `src/rules/` (engine, matcher, throttle, audit), `src/policy/` (validate, migrate, schema), `src/llm/` (providers), `src/utils/` (output, format, flags). Tests are in `tests/` and mirror the `src/` structure.

### Release flow

```bash
npm version patch        # bump + create git tag
git push --follow-tags
# then: GitHub → Releases → Draft → Publish
```

See [`docs/release-pipeline.md`](./docs/release-pipeline.md) for the full CI / publish verification flow.

## License

[MIT](./LICENSE) © chenliuyun

## References

- [SwitchBot API v1.1 documentation](https://github.com/OpenWonderLabs/SwitchBotAPI)
- Base URL: `https://api.switch-bot.com`
- Rate limit: 10,000 requests/day per account
