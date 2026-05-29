# @switchbot/claude-code-plugin

SwitchBot plugin for [Claude Code](https://claude.ai/claude-code) — wires Claude Code to the SwitchBot OpenAPI CLI MCP server, exposing 24 smart-home tools with policy-based safety gates.

## Installation

```bash
npm install -g @switchbot/claude-code-plugin
```

Then register the MCP server with Claude Code:

```bash
claude mcp add switchbot -- switchbot mcp serve --tools all
```

If SwitchBot credentials are not yet configured, run:

```bash
switchbot auth login
```

Or use the bundled helper at any time to re-authenticate:

```bash
switchbot-claude-auth
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
