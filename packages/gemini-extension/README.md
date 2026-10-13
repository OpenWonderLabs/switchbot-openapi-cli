# SwitchBot Gemini CLI Extension

Gemini CLI extension for SwitchBot smart-home control through the SwitchBot MCP server. The extension supplies context and slash commands in addition to the default MCP tool profile.

## Install the full extension

Gemini CLI installs extensions from a local directory or Git repository source, not from an npm package specifier. For a local installation, clone the repository and pass the directory that contains gemini-extension.json:

~~~bash
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
npm install -g @switchbot/openapi-cli@^3.9.0
gemini extensions install ./switchbot-openapi-cli/packages/gemini-extension
~~~

For iterative local development, use a link instead of a copied installation:

~~~bash
gemini extensions link ./switchbot-openapi-cli/packages/gemini-extension
~~~

Restart Gemini CLI after installing, updating, or changing the extension. Confirm that it is active:

~~~bash
gemini extensions list
switchbot gemini doctor
~~~

## MCP-only setup

Use MCP-only setup when you want SwitchBot tools without the extension context or slash commands:

~~~bash
npm install -g @switchbot/openapi-cli@^3.9.0
switchbot gemini setup
~~~

This adds SwitchBot to the Gemini settings MCP configuration. It intentionally does not install the extension and does not enable every admin tool.

If an active SwitchBot extension already provides the server, Gemini settings take precedence only when they define the same server name. The doctor command reports an active extension as configured and does not add a competing MCP-only entry. Disable or remove the extension before choosing MCP-only setup, or remove the MCP-only entry before using the extension as the provider.

## Credentials

Prefer the explicit login flow before configuring extension settings:

~~~bash
switchbot auth login
~~~

The CLI resolves credentials in this order: environment variables, OS keychain, then its configuration file. Gemini extension settings provide the environment-variable values when configured. Leaving those settings empty does not prevent the CLI from using keychain or configuration-file credentials. Never copy a token or secret from a configuration file into chat.

## Requirements

- Node.js >= 18
- @switchbot/openapi-cli >= 3.9.0
- A currently supported Gemini CLI installation with extension support

## Verify

~~~bash
switchbot --version
switchbot doctor
gemini extensions list
switchbot gemini doctor
~~~

## Uninstall

~~~bash
gemini extensions uninstall switchbot
~~~

For MCP-only setup, remove the named SwitchBot entry from mcpServers in the Gemini settings file. Removing an extension or MCP server does not remove CLI credentials; run switchbot auth logout only when you intend to remove them.

## Related packages

- [@switchbot/openapi-cli](https://www.npmjs.com/package/@switchbot/openapi-cli) — CLI and MCP server
- [@switchbot/claude-code-plugin](https://www.npmjs.com/package/@switchbot/claude-code-plugin) — Claude Code variant
- [@switchbot/codex-plugin](https://www.npmjs.com/package/@switchbot/codex-plugin) — OpenAI Codex CLI variant
