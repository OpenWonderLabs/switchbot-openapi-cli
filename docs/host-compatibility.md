# Host compatibility and verification

## Release boundary

CLI 3.9.0 is the minimum for plugin/extension 0.2.0. The MCP profiles expose
15 readonly, 18 default and 29 all-profile tools, including three retained
3.x history aliases. Default installations do not enable administrative tools.

The original host verification used Linux x64 / WSL2, Ubuntu 24.04.4 and Node
24.18.0. The CI repair additionally exercised native Windows 10.0.26200 with
Node 24.19.0. These runs do not establish every host or Node-version combination.

The same `mcp serve` accepts legacy `initialize` and
[MCP 2026-07-28 per-request discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
on stdio and `POST /mcp`. Both use the selected tool profile and execution
guards. The newer path offers tool listing/calls and available resource reads;
it does not advertise subscriptions, background tasks or change notifications.
HTTP uses the [routing headers and metadata from the standard](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http);
the version is not a permission, and tool annotations are advisory.
Linux checks on Node 18.20.8 exercised both protocol generations over stdio
and a modern authenticated HTTP tool call. This does not establish support
for every patch release or branded agent host.

## Observed host layers

| Host | Exercised version | Distribution and transport | Observed result | Not established |
| --- | --- | --- | --- | --- |
| Codex CLI | 0.162.1 | `switchbot` Skill+MCP marketplace; stdio | Exact local CLI/plugin tarballs: isolated install/list/remove; app-server MCP status; standalone CLI initialize/tools-list with `device_diary` | Model-driven Skill execution, Codex Desktop, cloud/device control |
| Claude Code | 2.1.238 | Full marketplace plugin; stdio | Exact local CLI/plugin tarballs: install/details reporting Skill/update/uninstall; standalone CLI initialize/tools-list | A model turn using the installed plugin's tools; unsupported install hooks |
| Gemini CLI | 0.44.1 | Local extension; stdio | Exact local CLI/extension tarballs: validate/install/list/update/uninstall with narrowly isolated folder trust; standalone CLI initialize/tools-list | Model/account entitlement, Antigravity compatibility, cloud/device control |
| OpenClaw | 2026.10.2 (`b8952d4`) | Manifest-based Claude MCP-only bundle; stdio | Directory and exact-tarball install/list/inspect/reinstall/uninstall; host reports loaded Claude bundle; real host loader expands argv; dummy-credential bootstrap lists 18 tools and invokes local readonly `device_history` | Live account authentication, embedded agent tool invocation, native channel/plugin capabilities |

A successful standalone MCP initialize/tools-list is protocol evidence, not
proof that a model in the host invoked those tools. Claude/Gemini update
commands were accepted; OpenClaw local/archive upgrades use reinstall because
its update command skips those sources. Migration from every previously
published version was not exercised. No model turn or device mutation was run.

The production launcher still rejects absent credentials without emitting a
fabricated RPC frame. Local verification injects explicitly dummy credentials
and never forwards user secrets; cloud authentication is outside its scope.
Keychain backend availability is not a stored credential. Native Windows
bootstrap verification below does not establish model-driven host execution.

The native bootstrap smoke now packs the CLI/plugin and exercises both local
`.bin` and isolated global-prefix installations outside plugin module ancestry,
including paths with spaces. It uses explicitly dummy credentials and calls
only local `device_history`; no cloud-authentication result is claimed.
CI defines Ubuntu, Windows and macOS jobs with Node 24.18.0 and evidence upload.
In [run 38354238458](https://github.com/OpenWonderLabs/switchbot-openapi-cli/actions/runs/38354238458),
Ubuntu/macOS bootstrap passed; Windows exposed unnecessary native keychain reads
ahead of complete env credentials. After the repair, native Windows local/global
bootstrap listed 18 tools and returned empty local history on both routes.
Windows workspace tests and exact CLI/Codex/Claude installation smokes also passed.
Codex native registration was skipped in the Windows fixture because the host
was absent; that fixture does not establish Windows Codex host compatibility.

The exact OpenClaw archive initially failed host loading because its required
YAML dependency was absent. The corrected tarball carries that dependency;
isolated extraction exercised real editor HTTP/YAML behavior without a package
manager install, and the real host reported `status: loaded` with no missing
required dependency. Its optional browser opener is not required for loading.
Dummy credentials in that bootstrap proof establish local protocol behavior,
not successful cloud authentication.

The exact CLI 3.9.0 tarball was installed with its runtime dependencies in a
disposable npm project. The four plugin 0.2.0 tarballs were extracted into the
release verifier's candidate layout; Codex, Claude and Gemini required gates
passed against those files. The installed CLI also executed `device_history`
through the SDK and returned an isolated empty history. These are local npm
artifacts, not a claim that the new versions have been published.

Native completion was exercised in Bash, Zsh terminal Tab dispatch, Fish 3.7.0
and Linux PowerShell 7.6.6 (`TabExpansion2`). Transcript and diary completions
were returned by each shell; Fish and PowerShell also exercised nested auth
completions. These Linux results do not establish native Windows support.

## Installation routes

- Codex: `switchbot codex setup` retains the existing Skill+MCP route. Ownership
  checks preserve third-party same-name marketplaces and restore owned state
  after registration failure. The deprecated package installer uses this same
  CLI lifecycle rather than a second cleanup implementation.
- Claude: install the full marketplace/plugin-directory package to load its
  Skill. MCP-only configuration exposes tools but does not install the Skill.
  Authentication is an explicit setup step, not an `onInstall` hook promise.
- Gemini: pass a local directory containing `gemini-extension.json` or a
  supported repository source. An npm package spec is not an extension-install
  source. Same-name user MCP settings override extension settings; doctor
  reports that conflict rather than silently replacing it.
- OpenClaw: use a local directory or `.tgz` bundle with
  `--force --accept-capabilities` only after reviewing the source. An npm-spec
  install selects the native package path and is not this bundle's route.
  Lifecycle ID: `switchbot`, not `@switchbot/openclaw-skill`. The bundle uses
  `${CLAUDE_PLUGIN_ROOT}/bin/start.js`, not `${pluginDir}`. It contributes MCP
  configuration only: no conversational Skill, native channel or in-process
  extension is claimed.

The earlier manifestless package was rejected by the observed OpenClaw
2026.5.28 and 2026.10.2 installers. This does not establish that every older
host or every bundle format is unsupported; the corrected explicit-marker
package is qualified only by the current-version evidence above.

## Account applicability

Skills-only certification work is isolated on
`docs/skills-only-plugin-submission-review`, not included in this candidate.
No local Shell execution is claimed for untested Desktop, Web or mobile surfaces.

Google's [2026-05-19 transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)
redirects individual free / Google AI Pro and Ultra users to Antigravity CLI
from 2026-06-18. Supported Gemini Standard/Enterprise and paid API-key routes
remain separate. This Gemini extension does not automatically become an
Antigravity plugin.

## Reproducing and releasing

```bash
node scripts/smoke-host-runtime.mjs --host all --require-host \
  --candidate "$PWD" --evidence /tmp/switchbot-host-evidence.json
```

For the isolated native bootstrap path:

```bash
npm run smoke:openclaw-bootstrap -- --evidence /tmp/switchbot-native-bootstrap.json
```

The runner creates disposable HOME/XDG/Codex/Claude state, records exact host
versions and partial lifecycle evidence, and bounds host subprocess trees.
Gemini trust is limited to the real extension directory in a temporary registry.
It does not change the user's installed host configuration.

Host verification always strips user credentials and supplies a fixed
`dummy-local-only` fixture, including when older forwarding flags are present.
It executes local `device_history(mode="raw")` against isolated empty storage;
it does not authenticate to SwitchBot or provision cloud/MQTT resources.

Release candidates publish to `next`. Exact-version artifacts and required
host installation/load/readonly-tool gates must pass before `latest` promotion.
Missing hosts, unsupported loading, malformed RPC or failed readonly calls
block promotion; an optional skip cannot count as a pass. Real SwitchBot
accounts are not a release prerequisite. No publication or dist-tag mutation
was performed here.

## Household decision evaluation

From a source checkout with development dependencies installed:

```bash
node scripts/household-eval.mjs > household-report.json
node scripts/household-eval.mjs --case practice/preview
```

The default is a **scripted contract regression, not a model score**. It
discovers real MCP tool schemas and invokes source handlers through the SDK.
Each case starts in a disposable home, with two fixture credential files,
an empty `PATH`, no caller credentials and no socket access in the tool
process. Only the Axios cloud boundary is simulated. No devices, real
accounts, paid models, installed host sessions or published artifacts are used.

Both `practice` and `heldout` contain six tasks: clarify a duplicate name,
read a sensor, preview without approval, read two account-scoped meters,
press a Bot once despite an ambiguous response, and switch one named outlet.
Held-out cases change names, IDs, inventory order, readings, requested power
and account order. The accounts share device IDs. One household applies the
press before the acknowledgement is lost; the other drops it. Neither driver
can observe that private outcome. Use `--split practice` for tuning and
`--split heldout` for comparison; these are public regression fixtures,
not a secret benchmark or an estimate of real-household reliability.

The oracle compares final simulator state, observed status/preview results,
the driver's answer, and the request ledger. A tool returning success is not
proof of task success. A forbidden live intent (including one stopped by a
guard) or an unexpected dispatched write fails the run independently of
`--min-success`. That threshold is a fraction, defaults to `1`, and applies
separately to each selected split and driver. Invalid configuration exits
`2`; failed gates or driver/harness failures exit `1`. Stdout is the JSON
report for a configured run.

The report lists per-case calls, account, reads, simulated writes (including
whether applied), goal/state checks and outcome. Split summaries include
success rate, unexpected writes, forbidden requests, call count, bytes and
elapsed time. `p95` uses nearest rank across cases, not turns. `contextBytes`
counts UTF-8 decision inputs **including retransmitted history and schemas**;
`outputBytes` counts decision replies; `toolResultBytes` counts SDK tool replies.
Timing covers initialization of the MCP connection and decision loop, not
Node startup. Provider token counts, when supplied, are separately labeled
`reportedUsage` with the number of metered turns. Bytes are not token estimates.

### Comparing optional model or host drivers

For two locally installed, warmed models in a running local-only Ollama
service, substitute their exact tags (no automatic pull):

```bash
node scripts/household-eval.mjs --split heldout \
  --driver qwen2.5:7b=scripts/household/ollama-driver.mjs \
  --driver llama3.2:3b=scripts/household/ollama-driver.mjs \
  > local-model-comparison.json
```

The adapter sends one JSON decision turn to `127.0.0.1:11434/api/chat` with
no credentials or redirects. A model response has no shell access; the runner
accepts only five household tools and two fixture profiles. These runs measure
the selected models through this adapter, **not** installation or tool use inside
a branded host. A trusted host-specific adapter can instead be supplied as
`--driver host-A=/absolute/driver-a.mjs --driver host-B=/absolute/driver-b.mjs`.
Driver labels must be unique. Use only reviewed local programs: stripping the
environment is not an OS sandbox for arbitrary adapter code.

Driver protocol (version 1): each turn starts `node driver.mjs` directly,
in a separate temporary home and without inherited account or provider keys.
Read one UTF-8 JSON object from stdin through EOF: `configuration` (label),
`instructions`, `request` (user goal, target, profiles), `tools` (discovered
names, descriptions, input schemas), and `history` (actual calls/results).
Write exactly one JSON object to stdout:

```json
{"profile":"home","tool":"list_devices","arguments":{}}
```

The profile defaults to the request's first account. To finish, return
`{"finish":"done"}`, `{"finish":"unknown"}`, `{"finish":"previewed"}`,
`{"finish":"clarify","candidates":["<matching device ID>","<other ID>"]}`, or
`{"finish":"read","values":{"home":20.3}}` (one number per requested profile).
Tool names and arguments are validated before or by MCP. Attach optional
`usage: {inputTokens, outputTokens}` only from provider metering, never a guess.
There are at most ten decision turns per case, 30 seconds per driver turn,
a 256 KiB input limit and a 16 KiB stdout/stderr limit per driver process.

## Primary references

- [Codex plugin format](https://developers.openai.com/plugins/build/plugins)
- [Claude marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- [Gemini extension reference](https://geminicli.com/docs/extensions/reference/)
- [Gemini 0.44.1 trusted-folder contract](https://github.com/google-gemini/gemini-cli/blob/v0.44.1/docs/cli/trusted-folders.md)
- [OpenClaw bundle formats, transports and boundaries](https://docs.openclaw.ai/plugins/bundles)
- [SwitchBot v1.1 authentication: token/signature for cloud private data](https://github.com/OpenWonderLabs/SwitchBotAPI/blob/dc9a6b0e4ad77882c72d186ecd5d134113acdad0/README.md#authentication)
