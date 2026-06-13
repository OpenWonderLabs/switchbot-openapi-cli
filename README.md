# @switchbot/openapi-cli

[![npm version](https://img.shields.io/npm/v/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![npm downloads](https://img.shields.io/npm/dm/@switchbot/openapi-cli.svg)](https://www.npmjs.com/package/@switchbot/openapi-cli)
[![license](https://img.shields.io/npm/l/@switchbot/openapi-cli.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@switchbot/openapi-cli.svg)](https://nodejs.org)
[![CI](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/workflows/ci.yml)

SwitchBot smart home CLI — control devices, run scenes, stream events, and plug AI agents into your home via the built-in MCP server.

- **npm:** [`@switchbot/openapi-cli`](https://www.npmjs.com/package/@switchbot/openapi-cli)
- **Source / issues:** [github.com/OpenWonderLabs/switchbot-openapi-cli](https://github.com/OpenWonderLabs/switchbot-openapi-cli)
- **Releases / changelog:** [GitHub Releases](https://github.com/OpenWonderLabs/switchbot-openapi-cli/releases)

---

**Human** — start with [Quick start](#quick-start): colored tables, error hints, shell completion, `switchbot doctor`.  
**Script** — start with [Global options](#global-options): `--json`, `--format tsv/yaml/id`, `--fields`, stable exit codes, audit log.  
**Agent** — start with [`docs/agent-guide.md`](./docs/agent-guide.md): `mcp serve`, `schema export`, `plan run`, destructive-command guards.

Every surface shares the same catalog, cache, and HMAC client.

---

## Installation

```bash
npm install -g @switchbot/openapi-cli
```

Requires Node.js ≥ 18. Run `switchbot auth login` to authenticate via browser — no Developer Options needed.

To use API token/secret directly instead, first obtain your credentials from the SwitchBot app:

1. Open the SwitchBot app → tap your profile avatar (top-right)
2. Go to **Preferences** → **App Version**, tap the version number 10 times to unlock Developer Options
3. Return to **Preferences** → **Developer Options**
4. Copy your **Token** and **Secret Key**

Then run:

```bash
switchbot config set-token <token> <secret>
```

---

## Supported devices

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
| **Other** | Bot · AI Art Frame · AI MindClip · Home Climate Panel · Remote |
| **IR virtual remotes** _(via Hub)_ | Air Conditioner · TV · Streamer · Set Top Box · DVD · Speaker · Fan · Light · Others |

---

## Quick start

```bash
switchbot auth login                        # browser OAuth — saves to OS keychain
switchbot config set-token <token> <secret> # or set credentials manually
switchbot devices list                      # list all devices
switchbot devices command <id> turnOn
switchbot doctor                            # self-check
```

---

## Codex integration

The Codex plugin is published to npm as [`@switchbot/codex-plugin`](https://www.npmjs.com/package/@switchbot/codex-plugin).

**Recommended — paste into Codex chat:**

```
Please set up the SwitchBot integration for me by running:
npx @switchbot/openapi-cli codex setup
Then restart Codex and confirm it's working.
```

`codex setup` installs or upgrades the CLI and plugin packages, registers the plugin with Codex, and opens a browser login page to save credentials to the OS keychain — no token copy-paste needed.

**Or install directly:**

```bash
npm install -g @switchbot/openapi-cli @switchbot/codex-plugin
switchbot codex setup           # one-shot bootstrap: register, auth, verify
```

**Or install via Codex Plugin Marketplace** (requires Codex CLI with marketplace support):

```bash
codex plugin marketplace add OpenWonderLabs/switchbot-openapi-cli
codex plugin add switchbot@switchbot
switchbot auth login
```

---

## Claude Code integration

**Already configured? Paste into Claude Code chat:**

```
Is my SwitchBot integration working? Please check and list my devices.
```

Claude will call `account_overview` or `switchbot doctor` to verify — no terminal needed.

**Fresh setup — paste into Claude Code chat:**

```
Please set up my SwitchBot integration by running:
npx @switchbot/openapi-cli claude-code setup
```

Claude will run the setup command via the Bash tool. It installs the CLI if missing, registers the MCP server via `claude mcp add --scope user`, and opens a browser login if credentials are not yet configured. Restart Claude Code afterwards to load the MCP tools.

**Or run manually in your terminal:**

```bash
npm install -g @switchbot/openapi-cli
switchbot claude-code setup
```

The optional skill package [`@switchbot/claude-code-plugin`](https://www.npmjs.com/package/@switchbot/claude-code-plugin) bundles the SKILL.md context document. Install it only if your environment does not already load the skill automatically.

**Or install via Claude Code Plugin Marketplace** (requires Claude Code with plugin marketplace support enabled):

```
/plugin marketplace add OpenWonderLabs/switchbot-openapi-cli
/plugin install switchbot@switchbot
```

**Note:** The root `marketplace.json` in this repo is for Codex CLI Route B (git sparse clone) and points to `packages/codex-plugin/plugins/switchbot`. The `.claude-plugin/marketplace.json` is for Claude Code Plugin Marketplace and points to `packages/claude-code-plugin/plugins/switchbot`.

---

## Gemini CLI integration

The Gemini extension is in [`packages/gemini-extension/`](./packages/gemini-extension/) — it provides up to 25 MCP tools (14 in the default profile, 25 with `--tools all`), a GEMINI.md context file, and 23 slash commands.

**Recommended — paste into Gemini CLI chat:**

```
Please set up the SwitchBot integration for me by running:
npx @switchbot/openapi-cli gemini setup
Then restart Gemini CLI and confirm it's working by listing my devices.
```

`gemini setup` installs or upgrades the CLI, registers the MCP server in `~/.gemini/settings.json`, and opens a browser login page to save credentials to the OS keychain — no token copy-paste needed.

**Or install the full extension (adds 23 slash commands + GEMINI.md context):**

```bash
npm install -g @switchbot/openapi-cli
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
gemini extensions link ./switchbot-openapi-cli/packages/gemini-extension
```

Gemini CLI prompts for `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET` during install (stored securely in system keychain).

**Or run MCP-only setup directly in your terminal:**

```bash
npm install -g @switchbot/openapi-cli
switchbot gemini setup
```

**Verify:**

```bash
switchbot gemini doctor
```

After setup, restart Gemini CLI and ask: "List my SwitchBot devices."

---

## OpenClaw integration

The OpenClaw skill is published to npm as [`@switchbot/openclaw-skill`](https://www.npmjs.com/package/@switchbot/openclaw-skill).

**Paste into OpenClaw chat:**

```
Please set up the SwitchBot integration for me by running:
npx @switchbot/openapi-cli install --agent openclaw
Then confirm it's working by listing my devices.
```

**Or install directly:**

```bash
npm install -g @switchbot/openapi-cli
openclaw plugins install @switchbot/openclaw-skill
switchbot auth login
```

`switchbot-openclaw setup` verifies `@switchbot/openapi-cli` is installed at `>=3.7.1` and authenticated. Safe to re-run.

---

## Credentials

> **Recommended:** use `switchbot auth login` for browser-based OAuth — credentials are stored securely in the OS keychain and never need to be copy-pasted anywhere.

Priority: env vars → OS keychain → `~/.switchbot/config.json`

```bash
switchbot auth login                             # browser OAuth — opens login page, saves to OS keychain
switchbot config set-token <token> <secret>     # manual setup (alternative)
export SWITCHBOT_TOKEN=... SWITCHBOT_SECRET=... # CI / env override
switchbot auth keychain set/get/delete          # OS keychain management
```

---

## Commands

### `devices`

```bash
switchbot devices list [--wide] [--filter 'type=Bot'] [--json]
switchbot devices status <id> [--ids A,B,C]
switchbot devices command <id> <cmd> [parameter]
switchbot devices expand <id> setAll --temp 26 --mode cool  # named flags for packed params
switchbot devices watch <id> [--interval 10s] [--for 5m]
switchbot devices batch turnOff --filter 'type=Bot'
switchbot devices meta set <id> --alias "Office Light"
```

### `scenes`

```bash
switchbot scenes list
switchbot scenes execute <sceneId>
```

### `mindclip`

```bash
switchbot mindclip recordings [--device <id>] [--page <n>] [--size <n>]
switchbot mindclip recording <id> [--language en|zh]
switchbot mindclip summary <id>
switchbot mindclip todos [--completed 0|1|2] [--category 0..5]
switchbot mindclip daily [--date YYYY-MM-DD]
switchbot mindclip weekly [--week YYYY-Www]
switchbot mindclip urgent-todos [--date YYYY-MM-DD]
```

### `codex`

```bash
switchbot codex setup [--yes] [--dry-run] [--json]   # full bootstrap
switchbot codex doctor [--quiet] [--json]             # 7-check health summary
switchbot codex repair [--skip re-auth] [--yes]       # re-register + re-verify
```

### `gemini`

```bash
switchbot gemini setup [--yes] [--dry-run] [--json]   # register MCP in ~/.gemini/settings.json
switchbot gemini doctor [--quiet] [--json]             # check CLI + MCP + credentials health
```

### `auth`

```bash
switchbot auth login [--no-open] [--timeout 60]
switchbot auth keychain describe/set/get/migrate/delete
```

### `config`

```bash
switchbot config set-token <token> <secret>
switchbot config show
switchbot config list-profiles
```

### `mcp`

```bash
switchbot mcp serve    # stdio MCP server — default 14 tools (use --tools all for 25)
```

### `webhook`

```bash
switchbot webhook setup <url>
switchbot webhook query [--details <url>]
switchbot webhook update <url> --enable/--disable
switchbot webhook delete <url>
```

### `events`

```bash
switchbot events tail [--filter deviceId=X] [--port 8080]
switchbot events mqtt-tail [--max 10] [--for 30s] [--json]
```

### `status-sync`

```bash
switchbot status-sync start --openclaw-model home-agent
switchbot status-sync status --json
switchbot status-sync stop
```

### `rules` / `daemon`

Policy-driven automations. Triggers: `mqtt` · `cron` · `webhook`. Conditions: `time_between` · `device_state` · `event_count` · `llm`. Actions: `command` · `notify`.

```bash
switchbot rules lint
switchbot rules list/explain/run/simulate
switchbot rules tail/replay/summary/conflicts/doctor
switchbot rules suggest --intent "turn off AC at 11pm" [--llm auto]
switchbot daemon start/stop/reload/status
```

### `plan`

Declarative batch operations. A plan file has `version`, `description`, and a `steps` array.

```bash
switchbot plan schema/suggest/validate
switchbot plan run plan.json [--dry-run] [--require-approval]
switchbot plan save/review/approve/execute
```

### `policy`

```bash
switchbot policy new/validate/migrate/backup/restore
```

### `doctor` / `health`

```bash
switchbot doctor [--json] [--fix --yes]
switchbot health check [--json] [--prometheus]
switchbot health serve [--port 3100]
```

### Other

```bash
switchbot history show [--limit 20]
switchbot quota status/reset
switchbot upgrade-check [--json]
switchbot catalog show/search
switchbot schema export [--type 'Strip Light']
switchbot capabilities --json
switchbot cache show/clear
switchbot reset [--yes] [--keep-credentials]
switchbot completion bash/zsh/fish/powershell
```

---

## Global options

| Flag | Description |
|---|---|
| `--json` | Raw JSON output |
| `--format <fmt>` | `tsv` / `yaml` / `jsonl` / `id` |
| `--fields <cols>` | Comma-separated column filter |
| `--dry-run` | Preview mutating requests without sending |
| `--verbose` | Log HTTP request/response to stderr |
| `--timeout <ms>` | HTTP timeout (default `30000`) |
| `--config <path>` | Override credential file location |
| `--profile <name>` | Named credential profile |
| `--cache <dur>` | Cache TTL (`5m`, `1h`, `off`, `auto`) |
| `--no-cache` | Disable all cache reads |
| `--retry-on-429 <n>` | Max 429 retry attempts (default `3`) |
| `--audit-log` | Append mutating commands to audit log |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime error (API / network / credentials) |
| `2` | Usage error (bad flag / unknown command / validation) |

---

## Environment variables

| Variable | Description |
|---|---|
| `SWITCHBOT_TOKEN` | API token (overrides config file) |
| `SWITCHBOT_SECRET` | API secret (overrides config file) |
| `NO_COLOR` | Disable ANSI colors |
| `CODEX_GIT_MARKETPLACE_REF` | Git ref used when registering the Codex plugin via the git marketplace (default: `main`) |

---

## Development

```bash
npm install && npm run build
npm run dev -- <args>   # run from TypeScript via tsx
npm test                # Vitest suite
```

## License

[MIT](./LICENSE) © chenliuyun

---

- [SwitchBot API v1.1](https://github.com/OpenWonderLabs/SwitchBotAPI) · Base URL: `https://api.switch-bot.com` · Rate limit: 10,000 req/day
