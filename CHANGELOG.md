# Changelog

All notable changes to `@switchbot/openapi-cli` are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.0] - 2026-04-20

Large agent-experience overhaul driven by the OpenClaw + Claude integration
feedback (19 items across P0/P1/P2/P3) plus a new **device history
aggregation** subsystem. All schema changes are **additive-only** — existing
agent integrations keep working without code changes and pick up the new
fields when they upgrade.

### P0 — Correctness & security

- **IR command verifiability tag** — `devices command` responses for IR
  devices now carry `verification: { verifiable: false, reason, suggestedFollowup }`.
  Human output adds a stderr hint that IR transmissions cannot be
  acknowledged by the device. MCP `send_command` mirrors the same field.
- **`config set-token` secret scrubbing** — positional invocations have their
  token/secret replaced in `process.argv` before any hook, audit log, or
  verbose trace can observe them. Interactive `set-token` (hidden-echo
  readline) is now the primary path; positional form prints a discouragement
  warning but still works for backwards compatibility.

### P1 — Agent hardening

- **`--name` scope fix** — `devices status` / `devices command` now accept
  `--name` directly on the subcommand (previously root-only). `capabilities`
  reflects the change.
- **Fuzzy name resolution contract** — new `src/devices/resolve-name.ts`
  exports six strategies (`exact | prefix | substring | fuzzy | first |
  require-unique`). Reads default to `fuzzy`; writes default to
  `require-unique` and fail with exit code 2 +
  `error: "ambiguous_name_match"` and a candidate list when multiple devices
  match. Global filters `--type`, `--room`, `--category`, and
  `--name-strategy` compose with `--name`.
- **Smaller schema/capabilities payloads + pipe hygiene** — `schema export`
  and `capabilities` grew `--compact`, `--types <csv>`, `--used`, `--fields
  <csv>`, `--surface cli|mcp|plan`. Banners / tips / progress messages move
  to stderr; stdout is exactly one JSON document. Non-TTY no longer emits
  ANSI.
- **Semantic safety metadata** — every leaf command in `capabilities` now
  carries `{ mutating, consumesQuota, idempotencySupported, agentSafetyTier:
  "read"|"action"|"destructive", verifiability, typicalLatencyMs }`. MCP
  tools mirror the tier in `meta.agentSafetyTier`.

### D — Device history (new subsystem)

- **JSONL storage** — every `events mqtt-tail` event / MCP status refresh is
  appended to `~/.switchbot/device-history/<deviceId>.jsonl`. The file
  rotates at 50 MB into `.jsonl.1 → .jsonl.2 → .jsonl.3` with the oldest
  discarded. Writes are best-effort with `0o600` perms.
- **`history range <deviceId>`** — time-windowed query with `--since 7d` /
  `--from <iso>` / `--to <iso>`, payload-field projection via repeatable
  `--field <name>`, `--limit <n>` (default 1000). Uses streaming
  `readline` so even 50 MB files never load into memory.
- **`history stats <deviceId>`** — reports file count, total bytes, record
  count, earliest/newest timestamp.
- **MCP `query_device_history`** — same contract as the CLI, exposed as a
  tool for agents with a 1000-record default safety cap.

### P2 — DX & stability

- **`doctor --json` stable contract** — locked shape
  `{ ok, generatedAt, checks[], summary }`; each `check` is
  `{ name, status: ok|warn|fail, detail }`. The `clock` check now probes the
  real API once and reports `skewMs`.
- **`events mqtt-tail` control events** — synthesized JSONL records of
  `__connect` / `__reconnect` / `__disconnect` / `__heartbeat`. Every real
  event gets a UUIDv4 `eventId` when the broker doesn't supply one.
- **`devices batch --stagger` / `--max-concurrent` / `--plan`** — throttled
  concurrent execution with per-step `startedAt` / `finishedAt` /
  `durationMs` / `replayed` telemetry and a planner (`--dry-run --plan`)
  that prints the plan JSON without executing.
- **Idempotency contract + `replayed` flag** — cache hits now return
  `replayed: true`. A reused key with a **different** `(command, parameter)`
  shape within the 60 s window exits 2 with
  `error: "idempotency_conflict"` and the old/new shape in the payload.
  The cache is **process-local, in-memory**: keys live as SHA-256
  fingerprints on the heap (never raw, so heap dumps / log captures don't
  leak the user-supplied key) and vanish when the process exits. Replay
  + conflict therefore apply within a single long-lived process — MCP
  server session, `devices batch` run, `plan run`, `history replay` — and
  do **not** carry across independent CLI invocations.
- **Profile label / description / daily cap / default flags** — `config
  set-token` grew `--label`, `--description`, `--daily-cap <N>`,
  `--default-flags "<csv>"`. The daily cap is enforced before any request
  leaves the CLI (pre-flight refusal, exit 2). `config list-profiles` /
  `doctor` / `cache status` surface the label.
- **`--verbose` header redaction** — `Authorization`, `token`, `sign`, `t`,
  `nonce`, cookies, etc. are mid-masked in verbose output. `--trace-unsafe`
  opts in to raw output with a prominent one-time warning.

### P3 — Polish

- **`quota show` alias** for `quota status`.
- **`showSuggestionAfterError` across the full subcommand tree** — typos like
  `devices lst` now suggest `devices list`.
- **`schema export` declares CLI-added fields** — top-level `cliAddedFields`
  documents `_fetchedAt`, `replayed`, and `verification` so agents can
  distinguish CLI-synthesized data from upstream API fields.
- **`switchbot agent-bootstrap [--compact]`** — single-command aggregate
  (identity, cached devices, catalog, quota, profile, safety tiers, quick
  reference) that stays under 20 KB in `--compact` mode. Offline-safe; no
  API calls.
- **`--table-style <unicode|ascii|simple|markdown>`** + `--format markdown`
  — non-TTY now defaults to `ascii`; `markdown` emits fenced `|col|col|`
  tables for agent UI embedding.
- **Audit log versioning** — every line now carries `"auditVersion": 1`.
  New `docs/audit-log.md` documents the format, crash-safety, and
  rotation guidance. New `switchbot history verify` reports parsed /
  malformed / version counts and exits non-zero on malformed content.

### Migration notes

- **Fully backwards compatible.** No fields changed or were removed; only
  added. Existing MCP and CLI integrations continue to work.
- Agents that want the richer context can refresh their prompts by running
  `switchbot agent-bootstrap --compact` once per session instead of
  combining `doctor` + `capabilities` + `schema` + `devices list`.
- Upgraders who manage profiles with sensitive daily budgets should run
  `switchbot config set-token --profile <name> --label "..." --daily-cap N`
  to take advantage of the pre-flight refusal guard.
- Audit logs written by 2.3.0 coexist unchanged with 2.4.0 records;
  `history verify` reports them as `unversioned`.

## [2.3.0] and earlier

See git history.
