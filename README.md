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

## Installation

```bash
npm install -g @switchbot/openapi-cli
```

Requires Node.js ≥ 18 and a SwitchBot account with **Developer Options** enabled.

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

The Codex plugin is self-hosted in this repo (`packages/codex-plugin/`) — no separate npm package required.

**Paste into Codex chat:**

```
Please set up the SwitchBot integration for me by running:
npx @switchbot/openapi-cli codex setup
Then restart Codex and confirm it's working.
```

**Or run directly (if CLI is already installed):**

```bash
codex plugin marketplace add OpenWonderLabs/switchbot-openapi-cli \
  --sparse packages/codex-plugin --ref main
codex plugin add switchbot@codex-plugin
switchbot auth login
```

---

## Credentials

Priority: env vars → OS keychain → `~/.switchbot/config.json`

```bash
switchbot auth login                   # browser OAuth (recommended)
switchbot config set-token <t> <s>    # manual setup
export SWITCHBOT_TOKEN=... SWITCHBOT_SECRET=...   # CI / env override
switchbot auth keychain set/get/delete # OS keychain management
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

### `codex`

```bash
switchbot codex setup [--yes] [--dry-run] [--json]   # full bootstrap
switchbot codex doctor [--quiet] [--json]             # 7-check health summary
switchbot codex repair [--skip re-auth] [--yes]       # re-register + re-verify
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
switchbot mcp serve    # stdio MCP server — 24 tools
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
