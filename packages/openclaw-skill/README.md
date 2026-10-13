# @switchbot/openclaw-skill

SwitchBot MCP bootstrap bundle for [OpenClaw](https://openclaw.ai). It delegates to the installed `@switchbot/openapi-cli` MCP server and exposes that CLI default MCP profile.

## Prerequisites

- Node.js 18+
- `@switchbot/openapi-cli` >= 3.9.0, installed before the default MCP launcher runs
- SwitchBot credentials. The CLI resolves them in priority order from environment variables, the OS keychain, then its config file. Run `switchbot auth login` yourself when credentials are absent; do not provide secrets to a chat client.

## Installation

OpenClaw 2026.10.2 accepts this package as a manifest-based Claude bundle.
It is not an OpenClaw native extension and contributes MCP configuration only;
it does not include an OpenClaw skill component. Install from a local directory
or a plain archive, not from an npm package spec.

### Local development directory

```bash
openclaw plugins install --link --force --accept-capabilities ./packages/openclaw-skill
```

### Archive

```bash
npm pack ./packages/openclaw-skill
openclaw plugins install --force --accept-capabilities ./switchbot-openclaw-skill-0.2.0.tgz
```

The prepack hook bundles the installed YAML runtime dependency. Archive
consumers do not need a separate dependency installation for the editor.

Global npm installation is only useful for manually invoking
`switchbot-openclaw` or `switchbot-policy-edit`; it does not register the
bundle with OpenClaw.

After a bundle install, inspect its actual root and verify the underlying CLI
and credentials (`jq` is used here to select the reported path):

```bash
bundle_root="$(openclaw plugins inspect switchbot --json | jq -r '.plugin.rootDir')"
node "$bundle_root/bin/start.js" setup
```

`switchbot-openclaw setup` verifies `@switchbot/openapi-cli` is installed,
at `>=3.9.0`, and authenticated. Safe to re-run.

OpenClaw identifies this bundle by its manifest ID, `switchbot`, rather than
by the npm package name. For archive upgrades, reinstall the new tarball;
`openclaw plugins update switchbot` skips local-directory/archive sources.
If a previous uninstall left the plugin disabled, explicitly enable it.

```bash
openclaw plugins install --force --accept-capabilities ./switchbot-openclaw-skill-0.2.0.tgz
openclaw plugins enable switchbot
openclaw plugins uninstall switchbot
```

## MCP Tools

The bundle does not copy or maintain a tool list. Inspect the installed CLI:

```bash
switchbot mcp tools --tools default --json
```

CLI 3.9.0 exposes 18 default-profile tools, 15 of which are read-only. An
administrator who intentionally needs the broader profile can inspect it with
`switchbot mcp tools --tools all --json` (29 tools). The default bundle
launcher does not enable that broader profile.

## Usage

The server communicates over **stdio** (MCP protocol). OpenClaw launches
the MCP server via `.mcp.json` — stdio launcher (`node ${CLAUDE_PLUGIN_ROOT}/bin/start.js`).

**Default launcher prerequisites**: `bin/start.js` requires an installed CLI
at >=3.9.0 and valid credentials. It writes remediation to stderr and exits
without emitting a non-MCP frame on stdout when either prerequisite is absent.
The explicit setup command verifies the CLI and credentials but does not
install the CLI; install the required CLI yourself before retrying.
On Windows, an installed CLI's npm `.cmd` entry is resolved from PATH to its
JavaScript entrypoint and launched with Node and separate argv, not through a
shell. Local `.bin` and global-prefix layouts with spaces are covered by the
isolated bootstrap smoke. The CI matrix includes native Windows/macOS runs;
their execution has not yet been observed.

To start manually (for debugging):

```bash
node "$bundle_root/bin/start.js"
```

## Policy editor

A local browser-based editor for `~/.config/openclaw/switchbot/policy.yaml`:

```bash
node "$bundle_root/bin/policy-edit.js"
# Opens http://localhost:18799
```

## Configuration

Edit `~/.config/openclaw/switchbot/policy.yaml` to set device aliases, quiet hours, and confirmation rules. See the [Policy section](https://github.com/OpenWonderLabs/switchbot-openapi-cli#policy) of the CLI README.

## License

MIT
