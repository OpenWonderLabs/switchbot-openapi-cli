# Codex network access for SwitchBot setup

Read this file when `switchbot codex setup` fails with a network error, or when the user asks why setup is failing or how to enable network access in Codex.

## Why network access is required

`switchbot codex setup` performs three network operations:

1. **npm registry probe** — checks for the latest `@switchbot/openapi-cli` version
2. **npm install -g** — installs or upgrades the CLI if outdated
3. **codex plugin marketplace add** — clones the plugin from GitHub

All three require outbound internet access. Codex workspaces are offline by default.

## How to enable network access in Codex

Add the following to `~/.codex/config.toml` (create the file if it does not exist):

```toml
[sandbox_workspace_write]
network_access = true
```

Then **restart Codex** and re-run setup:

```
switchbot codex setup
```

## Notes

- `network_access = true` enables outbound internet for `workspace-write` sandbox mode only.
- It does **not** reduce approval prompts on its own. Set `approval_policy = "on-request"` separately if you want fewer prompts.
- If setup still fails after enabling network, run `switchbot codex doctor` to see which checks are failing.
