# SwitchBot Gemini CLI Extension

Gemini CLI native extension for SwitchBot smart-home control through the authoritative
`switchbot` CLI MCP server (31 tools, policy-based safety gates).

## Install

### Option A: Extension link (local/development)

```bash
npm install -g @switchbot/openapi-cli
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
gemini extensions link ./switchbot-openapi-cli/packages/gemini-extension
```

Gemini CLI prompts you to set `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET` during install.
Get both from the SwitchBot app: **Profile → Preferences → Developer Options → Open API**.

### Option B: MCP-only setup (no extension install)

If you only want the MCP tools without slash commands or context file:

```bash
npm install -g @switchbot/openapi-cli
switchbot gemini setup
```

This writes the MCP server entry directly to `~/.gemini/settings.json`.

> **Note:** MCP-only mode does not load `GEMINI.md` — the AI model will lack safety-tier
> awareness and slash commands. For the full experience, use Option A or follow the upgrade
> hint shown after setup completes.

> **Local development:** If testing an unreleased version, use `npm link` in the repo root
> instead of `npm install -g`, then run `switchbot gemini setup`.

## What the extension provides

- 31 MCP tools for device control, scene execution, automation rules, and diagnostics
- `GEMINI.md` context file (auto-loaded) with safety tiers, name resolution, authority chain
- 23 slash commands:

  **Discovery & Diagnostics:**
  - `/switchbot:overview` — full account snapshot (devices, scenes, quota, MQTT)
  - `/switchbot:list-devices` — list all devices with live status
  - `/switchbot:status <name>` — live status for a named device
  - `/switchbot:describe <name>` — device capabilities and supported commands
  - `/switchbot:history <name>` — device state history and trends
  - `/switchbot:doctor` — integration health check

  **Device Control:**
  - `/switchbot:turn-on <name>` — turn on a device
  - `/switchbot:turn-off <name>` — turn off a device
  - `/switchbot:toggle <name>` — toggle power state
  - `/switchbot:press <name>` — press a Bot button
  - `/switchbot:open <name>` — open a Curtain/Blind
  - `/switchbot:close <name>` — close a Curtain/Blind
  - `/switchbot:pause <name>` — pause movement
  - `/switchbot:lock <name>` — lock a Smart Lock
  - `/switchbot:unlock <name>` — unlock a Smart Lock (destructive, requires confirmation)
  - `/switchbot:set-brightness <name> <0-100>` — set light brightness
  - `/switchbot:set-color <name> <color>` — set light RGB color
  - `/switchbot:set-color-temp <name> <2700-6500>` — set color temperature
  - `/switchbot:set-position <name> <0-100>` — set curtain/blind position

  **Scenes & Automation:**
  - `/switchbot:run-scene <name>` — execute a scene
  - `/switchbot:plan <intent>` — generate an execution plan from natural language
  - `/switchbot:rule <intent>` — create an automation rule from natural language
  - `/switchbot:audit [--since 1h]` — query command/rule execution history

## Requirements

- Node.js ≥ 18
- `@switchbot/openapi-cli` ≥ 3.7.1 (global install provides the `switchbot` binary)
- Gemini CLI ≥ 0.2.x (https://github.com/google-gemini/gemini-cli) — required for `settings` / keychain support

## Verify

```bash
switchbot --version              # must be ≥ 3.7.1
switchbot doctor                 # credentials + MCP health
gemini extensions list           # confirm "switchbot" appears
switchbot gemini doctor          # full integration health check
```

Restart Gemini CLI after install, then ask: **"List my SwitchBot devices."**

## Credentials

The extension uses `SWITCHBOT_TOKEN` and `SWITCHBOT_SECRET` environment variables. When
installed via the extension system, Gemini CLI stores these securely in the system keychain
and injects them at runtime. As a fallback the `switchbot` CLI reads from the OS keychain
if you previously ran `switchbot auth login`.

To re-authenticate:

```bash
switchbot auth logout
switchbot auth login
```

## Uninstall

```bash
# If installed via extension link:
gemini extensions uninstall switchbot

# If installed via switchbot gemini setup (MCP-only):
# Manually remove "switchbot" from mcpServers in ~/.gemini/settings.json
```

To also remove the CLI and stored credentials:

```bash
npm uninstall -g @switchbot/openapi-cli
switchbot auth logout      # removes keychain entry
```

## Related packages

- [`@switchbot/openapi-cli`](https://www.npmjs.com/package/@switchbot/openapi-cli) — the CLI and MCP server
- [`@switchbot/claude-code-plugin`](https://www.npmjs.com/package/@switchbot/claude-code-plugin) — Claude Code variant
- [`@switchbot/codex-plugin`](https://www.npmjs.com/package/@switchbot/codex-plugin) — OpenAI Codex CLI variant
