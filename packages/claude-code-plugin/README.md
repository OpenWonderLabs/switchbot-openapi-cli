# @switchbot/claude-code-plugin

SwitchBot plugin for [Claude Code](https://claude.ai/claude-code). The full plugin loads the SwitchBot skill and its default-profile MCP server. MCP-only setup registers only the server; it does not load the skill.

## Full plugin installation

Use the marketplace path when you want the skill, its safety guidance, and the default MCP server together. Clone the repository, then register the package directory as the marketplace:

~~~bash
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
claude plugin marketplace add ./switchbot-openapi-cli/packages/claude-code-plugin
claude plugin install switchbot@switchbot
~~~

Confirm that Claude Code discovered the plugin and its skill:

~~~bash
claude plugin list
claude plugin details switchbot
~~~

For a temporary local development session, load the plugin directory directly:

~~~bash
claude --plugin-dir ./switchbot-openapi-cli/packages/claude-code-plugin/plugins/switchbot
~~~

The plugin never installs the CLI or starts authentication automatically. Install the CLI and authenticate explicitly before controlling devices:

~~~bash
npm install -g @switchbot/openapi-cli@^3.9.0
switchbot auth login
~~~

The bundled switchbot-claude-auth command is an explicit interactive credential check and login helper; run it only when you want that flow.

## MCP-only setup

Use this path when you want MCP tools without the plugin skill:

~~~bash
npm install -g @switchbot/openapi-cli@^3.9.0
claude mcp add switchbot -- switchbot mcp serve
switchbot auth login
~~~

The default MCP profile intentionally exposes the minimal read and action tool set. It does not enable every admin tool. Use CLI policy commands when a workflow needs policy validation, or consciously configure a separate MCP server with the required tool profile.

## Requirements

- Node.js >= 18
- @switchbot/openapi-cli >= 3.9.0
- Claude Code with plugin marketplace or plugin-directory support for the full-plugin path

## Verify

~~~bash
switchbot --version
switchbot doctor
~~~

Restart Claude Code after installing or changing an MCP configuration. If credentials are missing, run switchbot auth login; do not paste tokens or secrets into a chat.

## Uninstall

~~~bash
claude plugin uninstall switchbot@switchbot
claude plugin marketplace remove switchbot
~~~

For MCP-only setup, remove the named SwitchBot MCP server with Claude Code's MCP management command. Removing the plugin or MCP registration does not remove CLI credentials; use switchbot auth logout only when you intend to remove them.

## Release metadata

Bump the npm package, packaged marketplace, embedded plugin manifest, and repository
root marketplace versions together. `npm pack`/`npm publish` reject stale packaged
metadata; the repository's `npm run verify:release` also checks the GitHub marketplace.

## Related packages

- [@switchbot/openapi-cli](https://www.npmjs.com/package/@switchbot/openapi-cli) — CLI and MCP server
- [@switchbot/gemini-extension](https://www.npmjs.com/package/@switchbot/gemini-extension) — Gemini CLI extension
- [@switchbot/codex-plugin](https://www.npmjs.com/package/@switchbot/codex-plugin) — OpenAI Codex CLI variant
