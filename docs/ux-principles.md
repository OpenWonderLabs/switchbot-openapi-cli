# UX principles for the SwitchBot integration

These are the ten principles the CLI, MCP server, rules engine, and
skill layers all obey. They are what make the integration feel
consistent whether the human is typing into a shell, an AI agent is
driving over MCP, or a declarative rule in `policy.yaml` is firing.

The principles are **not aspirational** — every one of them is
load-bearing in code shipped today. When a pull request conflicts
with one of these, the PR changes, not the principle.

Design references: the [Command Line Interface Guidelines](https://clig.dev/)
for human and script behavior, and [Anthropic's guide to evaluating agent tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
for measuring task outcomes and context cost. The [host verification record](host-compatibility.md)
separates protocol, simulated household tasks and real host evidence.

---

## 1. One binary, one contract

There is exactly one npm package (`@switchbot/openapi-cli`). It
exposes the CLI, the MCP server (`switchbot mcp serve`), and the
rules engine runtime (`switchbot rules run`). A human, an agent, and
a cron-triggered rule all reach the SwitchBot API through the same
code path. No per-channel behavior drift.

## 2. JSON envelopes are the agent-facing contract

Non-streaming `--json` results write `{schemaVersion, data}` on success or
`{schemaVersion, error}` on failure to stdout. Start `jq` projections at `.data`.
`--format=json` can project table rows; it is not always the raw `--json` payload.
Streaming commands use NDJSON headers: see the [JSON contract](json-contract.md).

## 3. Schema-versioned and drift-checked

`CATALOG_SCHEMA_VERSION` and `AGENT_BOOTSTRAP_SCHEMA_VERSION` are
bumped together and validated by `doctor`'s `catalog-schema` check.
Any agent that caches the bootstrap response SHOULD poll that check
on session start; a mismatch means the cache is stale and must be
refreshed before issuing commands.

## 4. Destructive commands always confirm, by default

For destructive work, review and approve a saved plan for the intended account
and targets. `--yes` or MCP `confirm: true` alone does not authorize a direct
production write. Rules cannot use the approval or bypass their own safety
restrictions. Review the [plan workflow](agent-guide.md#run-semantics).

## 5. Dry-run is a first-class mode, not a debug aid

`--dry-run` suppresses device/scene writes and leaves approvals and business
files unchanged. Unsupported mutations fail before their handler runs.
An inventory or scene lookup may still read the cloud, consume quota and
refresh a cache; explicitly enabled auditing can record a preview.
Use `rules simulate` for an offline decision. A live engine with a
`dry_run: true` rule still provisions subscriptions and records rule events.

## 6. Names for selection, IDs for confirmation

`policy.yaml` maps names such as `"hallway lamp"` to device IDs. Use aliases
on surfaces that support name resolution; otherwise look up the ID. Before
approval, verify the resolved target, account and normalized parameters. Two
devices named “Lamp” are not interchangeable.

## 7. Quiet hours are policy, not a flag

Rules express time-of-day constraints in their policy conditions. Agents
should inspect the applicable policy and explicit approvals rather than
assuming a device name or scheduled time grants permission.

## 8. Every mutation is auditable

`--audit-log` enables a best-effort JSONL record for device/scene mutations.
Rule events are also observable. Inspect the [audit contract](audit-log.md)
for scope, `auditVersion: 2`, and crash limits. The audit log is not an
execution receipt, proof of physical completion, or retry authorization.

## 9. Credentials live outside the repo, outside the shell history

Order of precedence: environment variables → OS keychain →
`0600`-permissioned JSON file. The keychain backend is automatic per
platform (macOS `security`, Windows PowerShell + Win32
`CredReadW`/`CredWriteW`, Linux `secret-tool`). No command echoes the
token or secret to stdout. `doctor` reports which backend is active
but never prints the value.

## 10. Cold-start is one command, bounded in time

`switchbot agent-bootstrap --compact` uses local state. On an empty cache,
`.data.devices` and `.data.catalog.types` are empty: this means *unknown inventory*,
not that the account has no devices. Refresh with `devices list` when online.
Use `schema export --type S30` for one model or `--project` to narrow the response.

---

## Non-goals (things these principles deliberately leave out)

- **No blind retries.** A transient failure need not be safe to repeat.
  `--retry-on-429` only applies to reads and verified repeat-safe writes.
  Neither scenes, custom IR buttons nor image deletions are automatically
  re-sent. A deduplication key does not make an unknown outcome repeat-safe.
- **No hidden state migration.** Policy `0.1 → 0.2` is an explicit
  `policy migrate` run, not an auto-upgrade.
- **No vendor-extension MQTT payloads.** The shadow event extractor
  only trusts fields documented by SwitchBot Cloud. Unknown fields
  are carried through unchanged but never used for routing decisions.
