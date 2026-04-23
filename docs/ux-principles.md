# UX principles for the SwitchBot integration

These are the ten principles the CLI, MCP server, rules engine, and
skill layers all obey. They are what make the integration feel
consistent whether the human is typing into a shell, an AI agent is
driving over MCP, or a declarative rule in `policy.yaml` is firing.

The principles are **not aspirational** — every one of them is
load-bearing in code shipped today. When a pull request conflicts
with one of these, the PR changes, not the principle.

---

## 1. One binary, one contract

There is exactly one npm package (`@switchbot/openapi-cli`). It
exposes the CLI, the MCP server (`switchbot mcp serve`), and the
rules engine runtime (`switchbot rules run`). A human, an agent, and
a cron-triggered rule all reach the SwitchBot API through the same
code path. No per-channel behavior drift.

## 2. JSON envelopes are the agent-facing contract

Every command that returns data supports `--json` (also `--format=json`)
and emits the envelope
`{ schemaVersion, ok, data|error, meta }`. Errors go to the **same
stream** as success in JSON mode so agents parse one byte-stream. The
legacy `--json-legacy` flag still exists for pre-v1.6 consumers and
will be removed when the last in-tree user moves off it.

## 3. Schema-versioned and drift-checked

`CATALOG_SCHEMA_VERSION` and `AGENT_BOOTSTRAP_SCHEMA_VERSION` are
bumped together and validated by `doctor`'s `catalog-schema` check.
Any agent that caches the bootstrap response SHOULD poll that check
on session start; a mismatch means the cache is stale and must be
refreshed before issuing commands.

## 4. Destructive commands always confirm, by default

Unlock, garage-door-open, keypad-create-key, and the other
destructive operations prompt for confirmation unless the user has
explicitly overridden the tier in `policy.yaml`. The rules engine
validator **rejects** rules that would fire a destructive command;
automations cannot override a destructive confirmation.

## 5. Dry-run is a first-class mode, not a debug aid

`--dry-run` on `devices command` / `plan run` prints the exact
request that would have been sent and writes **no** audit entry,
**no** quota charge, and **no** state change. A rule's per-rule
`dry_run: true` does the same at the engine level. Dry-run output is
byte-stable — agents can diff it against a subsequent real run.

## 6. Aliases, not device IDs, in human-facing surfaces

`policy.yaml` maps human names (`"hallway lamp"`) to opaque device
IDs. Every CLI command, MCP tool, and rule body accepts the alias.
The device ID never leaks into a prompt the user has to look at. IDs
appear only in JSON output and in logs.

## 7. Quiet hours are policy, not a flag

Time-of-day gating lives in `policy.yaml` (`quiet_hours`, rule-level
`time_between`). The same rule block guards manual `devices command`
calls when the user opts in. No command-line flag duplicates this —
the policy is the one place that changes.

## 8. Every mutation is auditable

A single JSONL audit log (`~/.switchbot/audit.log` by default)
records every mutating command, every rule firing, every dry-run
preview, every webhook rejection. Format is documented in
`docs/audit-log.md` and frozen at `schemaVersion: 2`. The CLI never
trims the file; retention is the operator's responsibility.

## 9. Credentials live outside the repo, outside the shell history

Order of precedence: environment variables → OS keychain →
`0600`-permissioned JSON file. The keychain backend is automatic per
platform (macOS `security`, Windows `cmdkey`, Linux `secret-tool`).
No command echoes the token or secret to stdout. `doctor` reports
which backend is active but never prints the value.

## 10. Cold-start is one command, bounded in time

`switchbot agent-bootstrap --compact` returns the full snapshot an
agent needs to start operating — identity, device count, policy
status, schema versions — within a single API call and a cached
catalog read. No agent implementation ever needs to issue five
commands in parallel to warm up.

---

## Non-goals (things these principles deliberately leave out)

- **No "smart" error recovery.** API errors map to a small fixed
  taxonomy (`auth-failed`, `device-offline`, `device-busy`,
  `quota-exceeded`, `command-not-supported`, `device-not-found`,
  `runtime`, `usage`). The CLI does **not** retry without an explicit
  `--retry` flag; retry policy is the caller's choice.
- **No hidden state migration.** Policy `0.1 → 0.2` is an explicit
  `policy migrate` run, not an auto-upgrade.
- **No vendor-extension MQTT payloads.** The shadow event extractor
  only trusts fields documented by SwitchBot Cloud. Unknown fields
  are carried through unchanged but never used for routing decisions.
