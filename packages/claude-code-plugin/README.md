# @switchbot/claude-code-plugin

SwitchBot plugin for [Claude Code](https://claude.ai/claude-code) — wires Claude Code to the SwitchBot OpenAPI CLI MCP server, exposing 24 smart-home tools with policy-based safety gates.

## Installation

```bash
npm install -g @switchbot/claude-code-plugin
```

Then register as a Claude Code Marketplace source:

```bash
claude plugins add @switchbot/claude-code-plugin
```

Claude Code will run the `onInstall` hook automatically. If SwitchBot credentials are not configured, a browser login window will open.

## Manual auth setup

```bash
switchbot-claude-auth
```

Or via the CLI directly:

```bash
switchbot auth login
switchbot doctor
```

## Requirements

- Node.js ≥ 18
- `@switchbot/openapi-cli` ≥ 3.7.1 (installed globally or as a peer)
- Claude Code ≥ 1.x

## What it does

Registers the `switchbot` MCP server (`switchbot mcp serve --tools all`) with Claude Code. The skill document (`plugins/switchbot/skills/switchbot/SKILL.md`) guides Claude Code in safely controlling devices, reading sensors, running scenes, and respecting policy-based safety tiers.

## Related packages

- [`@switchbot/openapi-cli`](https://www.npmjs.com/package/@switchbot/openapi-cli) — the CLI and MCP server
- [`@switchbot/codex-plugin`](https://www.npmjs.com/package/@switchbot/codex-plugin) — OpenAI Codex CLI variant
- [`@switchbot/openclaw-skill`](https://www.npmjs.com/package/@switchbot/openclaw-skill) — OpenClaw / ClawhHub variant
