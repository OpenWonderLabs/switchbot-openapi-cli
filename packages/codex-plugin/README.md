# SwitchBot Codex Plugin

Codex plugin for SwitchBot smart-home control through the authoritative
`switchbot` CLI MCP server.

## What it installs

- A Codex skill at `skills/switchbot/SKILL.md`
- An MCP server definition that runs `switchbot mcp serve --tools all`
- A best-effort `onInstall` hook that runs non-interactive setup when the CLI is present
- A bootstrap binary: `switchbot-codex-install`

## Requirements

- Node.js `>=18`
- `@switchbot/openapi-cli >=3.7.1`
- Codex with plugin marketplace support

## Install

### Recommended

```bash
npx @switchbot/openapi-cli codex setup
```

`switchbot codex setup` installs or upgrades the CLI and Codex plugin packages
if needed, registers the plugin with Codex, prompts for credentials when
needed, then verifies the integration.

### Direct Codex install

If you install the plugin from Codex itself, enable plugin hooks for automatic
best-effort setup:

```toml
[features]
plugin_hooks = true
```

The hook never blocks plugin installation. If setup needs credentials or the
SwitchBot CLI is missing, finish with:

```bash
npx @switchbot/openapi-cli codex setup
```

## Verify

Run:

```bash
switchbot --version
switchbot doctor
switchbot devices list
```

Then restart Codex and ask:

> List my SwitchBot devices and tell me which ones are currently on.

## If install succeeds but you are not logged in

This usually means the plugin installed, but the browser auth step did not run
or did not complete.

Run:

```bash
switchbot-codex-auth
```

If you prefer the CLI directly:

```bash
switchbot auth login
switchbot doctor
```

Do not paste your token or secret into Codex chat. The login flow stores
credentials in your OS keychain.

## Re-login

Use this when `switchbot doctor` reports auth failures, the token was rotated,
or Codex says credentials exist but are rejected.

```bash
switchbot auth logout
switchbot auth login
switchbot doctor
switchbot devices list
```

After re-login, restart Codex and retry:

> List my SwitchBot devices and tell me which ones are currently on.

## Verify End-To-End

For a full release-style verification, run:

```bash
switchbot --version
switchbot doctor
switchbot devices list
```

Expected result:

- `switchbot --version` is `3.7.1` or newer
- `switchbot doctor` completes without credential failures
- `switchbot devices list` returns your devices
- Codex can answer the device prompt without asking for secrets

## Uninstall

Remove the plugin entry you installed. Common Codex plugin IDs are:

```bash
codex plugin remove switchbot@switchbot-skill
codex plugin remove switchbot@codex-plugin
```

Repo-marketplace installs usually use `switchbot@switchbot-skill`. Package-local
marketplace installs use `switchbot@codex-plugin` (matches the package directory
name).

If you installed the npm package globally and also want to remove the helper
commands:

```bash
npm uninstall -g @switchbot/codex-plugin
```

## Full Uninstall

To remove the plugin, local policy files, and stored login state:

```bash
codex plugin remove switchbot@switchbot-skill
codex plugin remove switchbot@codex-plugin
switchbot auth logout
```

Optional cleanup:

```bash
npm uninstall -g @switchbot/codex-plugin
npm uninstall -g @switchbot/openapi-cli
```

Key detail: deleting local files under `~/.switchbot` does not automatically
remove credentials from the OS keychain. Use `switchbot auth logout` when you
want a true logout.
