# @switchbot/openclaw-skill

SwitchBot smart-home skill for [OpenClaw](https://openclaw.ai) — bootstraps the local SwitchBot CLI and delegates to `switchbot mcp serve`, so AI agents get the full MCP tool surface exposed by the installed `@switchbot/openapi-cli`.

## Prerequisites

- Node.js 18+
- SwitchBot API credentials (`switchbot config set-token`) — the CLI itself is **auto-installed** on first launch

## Installation

```bash
# Via OpenClaw plugin manager (recommended)
openclaw plugins install @switchbot/openclaw-skill

# Or global npm
npm install -g @switchbot/openclaw-skill

# Either way, then bootstrap the underlying CLI + credentials:
switchbot-openclaw setup
```

`switchbot-openclaw setup` verifies `@switchbot/openapi-cli` is
installed, at `>=3.7.1`, and authenticated. Safe to re-run.

## MCP Tools

This plugin does not maintain its own hand-written tool subset. OpenClaw launches `bin/start.js`, and that wrapper hands off to `switchbot mcp serve`, so the exact tool list stays aligned with the installed CLI version. Key groups include:

| Tool | Description |
|---|---|
| `devices_list` | List all devices in the account |
| `devices_status` | Get current status of a device |
| `devices_describe` | List supported commands for a device type |
| `devices_command` | Send a command (turnOn, turnOff, setBrightness, …) |
| `scenes_list` | List all saved scenes |
| `scenes_run` | Execute a scene by ID |
| `rules_list` | List automation rules |
| `rules_suggest` | Ask AI to suggest a new rule based on intent |
| `rules_explain` | Explain why a rule fired or was blocked (with trace) |
| `rules_simulate` | Replay rule against historical events before enabling |
| `daemon_start` / `daemon_stop` / `daemon_status` | Control the automation rule engine |
| `audit_query` | Query the audit log for device/rule history |

Full tool reference: `switchbot mcp tools`

## Usage

The server communicates over **stdio** (MCP protocol). OpenClaw launches
the MCP server via the declarations in:

- `.claude-plugin/plugin.json` — bundle identity
- `.mcp.json` — stdio launcher (`node ${pluginDir}/bin/start.js`)

**First launch auto-setup**: if `@switchbot/openapi-cli` is not installed,
`bin/start.js` installs it automatically. If credentials are missing, it
outputs a `setupRequired` prompt asking you to run
`switchbot config set-token`. Once configured, the plugin stays out of the
way and delegates every launch to the CLI-owned MCP server.

To start manually (for debugging):

```bash
switchbot-openclaw
```

## Policy editor

A local browser-based editor for `~/.config/openclaw/switchbot/policy.yaml`:

```bash
switchbot-policy-edit
# Opens http://localhost:18799
```

## Configuration

Edit `~/.config/openclaw/switchbot/policy.yaml` to set device aliases, quiet hours, and confirmation rules. See the [Policy section](https://github.com/OpenWonderLabs/switchbot-openapi-cli#policy) of the CLI README.

## License

MIT
