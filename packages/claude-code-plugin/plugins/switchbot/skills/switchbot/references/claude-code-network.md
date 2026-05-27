# Claude Code network access for SwitchBot

Claude Code automatically manages the SwitchBot MCP server process and its
network access via the `.mcp.json` file bundled with this plugin. No manual
configuration file changes are required.

## If you see network errors in the MCP server output

The MCP server requires outbound HTTPS to `api.switch-bot.com`. Check:

1. **CLI installed:** `switchbot --version` — should print `3.7.1` or later
2. **Credentials configured:** `switchbot doctor` — should exit 0
3. **Network connectivity:** outbound HTTPS to `api.switch-bot.com` must be allowed

If credentials are missing, re-run the setup:

```bash
switchbot auth login
```

Then reload Claude Code to restart the MCP server.
