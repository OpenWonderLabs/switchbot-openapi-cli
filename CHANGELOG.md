# Changelog

All notable changes to `@switchbot/openapi-cli` are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.5.1] - 2026-04-20

Round-2 + Round-3 smoke-test response: 24 bugs closed across three groups —
Round-2 correctness (13), Round-2 leftovers (3), and Round-3 contract & DX
(8). Sources: `switchbot-cli-v2.5.0-round2-report.md` and
`switchbot-cli-v2.5.0-round3-report.md`.

The release was cut initially against the Round-2 report; the Round-3 report
arrived shortly after and is folded into the same patch so consumers of
2.5.1 get the full fix set in one version bump. The two Round-3 🔴 items
(`#SYS-1`, `#SYS-3`) are contract bugs that break agent pipelines and could
not wait.

### Fixed (correctness & safety)

- **`devices command --dry-run --json` no longer emits empty stdout** —
  the single-device write path was hitting `handleError`'s silent
  `DryRunSignal` exit before the JSON serializer ran. Now mirrors the MCP
  `send_command {dryRun:true}` shape:
  `{schemaVersion:"1.1", data:{dryRun:true, wouldSend:{deviceId,command,parameter,commandType}}}`.
  Batch and plan dry-run paths were already correct. (bug #36)
- **MCP tool-call errors preserve structure** — `send_command` /
  `describe_device` / `run_scene` were letting `ApiError`s escape to the
  SDK's generic `createToolError`, collapsing `{code, subKind, transient,
  hint, retryAfterMs, errorClass}` to a plain-text string. Errors now
  return `structuredContent.error` alongside `isError:true` so agents can
  branch on `subKind` instead of parsing English. Also narrowed the
  `mcpError()` option types so `subKind` / `errorClass` are compile-time
  checked. (bug #38)
- **`devices batch` propagates `verification` + `subKind` for IR devices** —
  a batch over IR remotes was emitting zero unverifiability signal, the
  exact contract 2.4.0 was released to establish. `succeeded[]` entries
  now include `subKind:'ir-no-feedback'` and the verification object for
  IR devices, plus `summary.unverifiableCount`. (bug #28)
- **Device & status cache scoped per profile** — `devices.json` and
  `status.json` lived at a fixed disk path, so rotating credentials or
  switching profiles served the *prior* session's inventory. Cache files
  now live under `~/.switchbot/cache/<sha256(profile):8>/` when a profile
  is active; unnamed/default profile keeps the legacy `~/.switchbot/`
  path (backwards compatible). A follow-up fix also keys the in-memory
  hot cache (`_listCache` / `_statusCache`) by profile so `mcp serve`
  request-scoped profile switches do not leak either. (bug #37)
- **API code 190 reclassified `device-internal-error`** — 190 fires for
  invalid deviceIds, unsupported parameters, AND non-device endpoints
  like `webhook query` with no webhook configured. The `device-busy`
  subKind and device-specific hint were misleading for webhook. Renamed
  subKind + rewrote hint to cover all three causes. (bug #27)
- **API code 3005 mapped to `command-not-supported`** — 3005 "invalid
  value" is the API's catch-all for model-specific command rejections
  (e.g., Fan `lowSpeed/middleSpeed/highSpeed` on stock IR remotes that
  only work under `--type customize`). Now returns a useful subKind + hint
  pointing to `devices commands <type>` and `--type customize`. (bug #29)
- **`scenes execute` pre-validates sceneId** — `scenes execute <bogus>`
  returned `ok:true` because the API does not validate sceneIds.
  `scenes describe` already guarded against this via `scene_not_found` —
  port the same check so agents do not silently burn quota. (bug #31)
- **`devices meta set --alias` enforces uniqueness** — nothing stopped
  two devices from carrying the same alias; `--name <dup-alias>` behavior
  was undefined. Reject duplicate aliases with a clear error naming the
  existing holder; `--force` reassigns (clears the old holder's alias)
  with a log line. (bug #41)

### Fixed (UX & docs)

- **`--fields id` / `--fields name` aliases restored on `devices list`** —
  the 2.5.0 alias-map refactor dropped the short forms that 2.4.0
  accepted, breaking scripts. `id → deviceId` is back alongside
  `name → deviceName`. (bug #22)
- **`cache clear --status` and `--list` shorthand aliases** — the old
  `--key status` form still works, but the shorter flags no longer
  error with `unknown option`. Using them with `--key` or together
  raises `UsageError`. (bug #35)
- **`history aggregate --metric` marked `requiredOption`** — help text
  said `(default: [])` implying optional; the command actually required
  at least one metric and threw a custom error. Now Commander enforces
  it and `--help` says `required`. (bug #42)
- **`plan validate` help text clarifies scope** — now says "structural
  only; does not verify device or scene existence" and points to
  `plan run --dry-run` for semantic checks. (bug #32)
- **`cache` help text documents TTL behavior** — the cache TTL is computed
  from the `lastUpdated` field *inside* the JSON, not file mtime.
  Operators who `touch`ed cache files to force a refresh were surprised.
  One-line note added to `cache show --help`. (bug #34)
- **`devices meta` surfaced in agent-bootstrap and capabilities** — the
  local metadata system was completely undiscoverable in 2.5.0. `meta set
  / get / list / clear` now appear in `capabilities` with correct safety
  tiers, and `agent-bootstrap`'s `quickReference` gains a `meta` entry.
  (bug #40)
- **`~/.switchbot/device-history/<id>.json` companion file documented** —
  the 100-entry ring buffer read by MCP `get_device_history` had no docs,
  while only the append-only `.jsonl` was mentioned. `docs/agent-guide.md`
  now describes both files and `__control.jsonl`. (bug #43)

### Fixed (Round 3 contract bugs — 🔴)

- **`--json` errors now emit on stdout instead of stderr** — piped
  consumers (`cli --json ... | jq`) could not decode failure envelopes
  because `handleError` wrote them to stderr. The JSON envelope
  `{schemaVersion, error:{...}}` now lands on stdout for both success
  and failure; TTY users still get a colored human-readable summary on
  stderr, non-TTY invocations get silence on stderr. 15+ bespoke JSON
  error sites across `batch`, `config`, `devices`, `expand`, `history`,
  `mcp`, and `format` were consolidated through a new `emitJsonError`
  helper. (bug #SYS-1)
- **MCP `send_command { dryRun:true }` validates deviceId against the
  local cache** — dryRun previously accepted any string and echoed back
  a plausible-looking preview, defeating the whole point of a
  validation surface. Unknown IDs now return `subKind:'device-not-found'`
  with a hint to run `list_devices` first. Happy path unchanged for
  cached IDs. (bug #SYS-3)

### Fixed (Round 2 leftovers)

- **`devices batch --idempotency-key`** accepted as alias for
  `--idempotency-key-prefix`. Still uses prefix semantics internally
  (auto-appends `-<deviceId>` per step). (bug #30)
- **`--filter` DSL accepts three operators** — `key=value` (legacy
  exact/substring), `key~value` (case-insensitive substring), and
  `key=/pattern/` (case-insensitive regex; invalid regex returns a
  usage error). (bug #39)

### Added (Round 2/3 features)

- **`devices batch --skip-offline`** (default off) skips devices whose
  cached status is offline, with each skip recorded under
  `summary.skipped` with `skippedReason:'offline'`. Reads the local
  status cache only — no new API calls. Off by default preserves 2.5.0
  behavior. (bug #33)
- **`--for <duration>` alias** on `devices watch`, `events tail`, and
  `events mqtt-tail` — stops after elapsed time instead of tick/event
  count. Accepts the same duration grammar as `--since` (ms/s/m/h/d/w).
  When both `--for` and `--max` are set, the first limit to hit wins.
  (bug #52)
- **Duration parser accepts `d` (days) and `w` (weeks)** in addition
  to `ms/s/m/h`. Unsupported units like `1y` / `1month` now produce a
  usage error that lists the supported unit set. (bug #54)
- **`events mqtt-tail --json` emits a `__session_start` envelope**
  immediately on invocation (before the broker connect), so downstream
  tools can distinguish "connecting" from "never connected" and get an
  eventId to correlate with subsequent `__connect` / `__disconnect`
  events. (bug #56)

### Polish (Round 3 DX)

- **`--name-strategy` help + `agent-bootstrap` list all six
  strategies** — `exact`, `prefix`, `substring`, `fuzzy`, `first`,
  `require-unique`. `ALL_STRATEGIES` in `name-resolver.ts` is the
  single source of truth; help text is generated from it. (bug #51)
- **MCP `search_catalog` rejects empty queries** with a usage error
  pointing to `list_catalog_types` for enumeration. Silent
  "return everything" behavior was surprising and agent-hostile.
  (bug #57)
- **Negative positional parameters reach the validation layer** —
  `setBrightness -1` was being swallowed by Commander as "unknown
  option `-1`". `devices command` now uses `.passThroughOptions()` so
  negative numeric positionals are forwarded to the command-specific
  validator, where they can be accepted or range-rejected as
  appropriate. (bug #53)

### Not included (response to reports)

- **Report bug #19 (MCP strict schema not enforced) — false positive.**
  All 11 MCP tools already have `.strict()` on their Zod input schemas
  and the SDK enforces it via `safeParseAsync` → JSON-RPC `-32602`.
  Could not reproduce the reported behavior; the existing test suite
  exercises the full JSON-RPC path.
- **Deferred to 2.6.0:**
  - Report bug #58 (parallel `devices status` outlier) — needs
    profiling to separate CLI-side latency from API-side, and the fix
    likely involves a concurrency knob rather than a single flip.
  - Report bug #55 (`devices watch --json` rewording) — already works
    via the global `--json` flag; pure doc rewording scheduled with
    other doc sweeps.
  - MCP / CLI naming alignment (`live` vs `includeStatus`, `metric` vs
    `metrics`) flagged in Round-3 §4.
  - `devices meta import/export` (Round-2 #40 follow-up).

## [2.5.0] - 2026-04-20

### Added

- **`history aggregate <deviceId>`** — on-demand bucketed statistics
  (`count / min / max / avg / sum / p50 / p95`) over the append-only JSONL
  device history. Flags: `--since` / `--from` / `--to`, repeatable
  `--metric`, `--agg <csv>`, `--bucket <dur>`,
  `--max-bucket-samples <n>`. Non-numeric samples are skipped; empty
  metrics are omitted from their bucket.
- **MCP `aggregate_device_history`** — same contract as the CLI, exposed
  as a read-tier tool (`_meta.agentSafetyTier: "read"`) with a strict
  Zod input schema (unknown keys reject with JSON-RPC `-32602`).
- **Capabilities manifest** — new `history aggregate` entry in
  `COMMAND_META`; new `aggregate_device_history` entry in
  `surfaces.mcp.tools`.
- **`scenes describe <sceneId>`** — returns `{sceneId, sceneName,
  stepCount:null, note}`; SwitchBot API v1.1 does not expose scene
  steps. Unknown sceneId returns structured `scene_not_found` with a
  candidate list. (bug #17)
- **`--no-color` flag + `NO_COLOR` env var** — honors the standard
  https://no-color.org/ contract; disables chalk colors globally before
  any subcommand runs. (bug #12)
- **`--format markdown`** — accepted as an alias for `--format table`
  with `--table-style markdown` forced at render time, independent of
  the user's `--table-style` flag. (bug #8)
- **`cache status`** — alias for `cache show`, matching the `quota`
  subcommand's status/show parity. (bug #9)

### Fixed (security & correctness — v2.4.0 report)

- **MCP strict input schemas on all 11 tools** — unknown keys now
  reject with JSON-RPC `-32602`. Fixes the v2.4.0 hole where
  `send_command {dryRun:true}` silently fired the command anyway —
  particularly dangerous for Smart Lock / Garage. (bug #4)
- **MCP `dryRun` on mutating tools** — `send_command` and `run_scene`
  accept `dryRun:true`; when set, no API call is made and the response
  is `{ok:true, dryRun:true, wouldSend:{...}}`. (bug #4)
- **MCP `serverInfo.version`** — wired to `package.json#version`; was
  hardcoded `"2.0.0"` despite the CLI reporting the real version
  everywhere else. (bug #5)
- **MCP `_meta.agentSafetyTier`** — every tool now emits its tier
  (`read` / `action` / `destructive`). Release notes already claimed
  this but no tool was actually emitting it. (bug #6)
- **`--name` require-unique + exact-match** — exact-name short-circuit
  in `name-resolver` was returning the exact hit even when substring
  matches existed, defeating the write-path `require-unique` default.
  Exact hits now enter the candidate list under `require-unique` and
  go through the ambiguity check like any other match. (bug #1)
- **`history verify` on missing audit.log** — exits 0 with `status:"warn"`
  and `fileMissing:true` rather than exit 1. Malformed/unversioned
  content still exits 1 as before. (bug #11)
- **`events mqtt-tail` control events** — `__connect` / `__reconnect` /
  `__disconnect` / `__heartbeat` now append to
  `~/.switchbot/device-history/__control.jsonl` alongside per-device
  files, honoring the v2.4.0 "every event is persisted" claim. (bug #10)

### Changed (docs)

- `--idempotency-key` help text on `devices command`, `devices batch`,
  `plan run`, `history replay` now explicitly mentions the process-local
  60s scope — independent CLI invocations do NOT share the cache. (bug #14)
- `mcp --help` now says "eleven tools" and lists all 11 names. (bug #15)
- New `docs/verbose-redaction.md` — documents the nine masked headers
  (`authorization`, `token`, `sign`, `nonce`, `x-api-key`, `cookie`,
  `set-cookie`, `x-auth-token`, `t`) and the `--trace-unsafe` opt-out. (bug #16)
- `plan schema` now includes `agentNotes.deviceNameStrategy` declaring
  that plan steps using `deviceName` resolve with `require-unique`. (bug #18)
- `agent-bootstrap` `hints` field carries JSDoc + `schema export`
  declares it in `cliAddedFields` — empty array means "no hints",
  never null. (bug #13)

### Notes

- Storage format unchanged. Aggregation streams the existing JSONL
  rotation files via `readline` — zero memory blow-up for large
  windows, with a hard ceiling of `--max-bucket-samples` × 8 bytes per
  `(bucket × metric)` for quantile computation.
- Quantiles use nearest-rank on sorted per-bucket samples; if the cap
  is reached the result carries `partial: true` and a per-bucket
  `notes[]` entry. `count / min / max / avg / sum` remain exact.
- All bug-fix items bundled into 2.5.0 rather than shipping a separate
  2.4.1. Source of bug numbers: the v2.4.0 smoke-test report at
  `D:/servicdata/openclaw/workspace/switchbot-cli-v2.4.0-report.md`.

### Not included (deferred)

- Cross-device aggregation (agents merge locally).
- Trend / rate-of-change helpers (derivable from bucket series).
- `--fill-empty` for missing buckets.
- Disk-persisted idempotency cache for cross-invocation replay
  (report bug #2). Process-local is the documented 2.4.0 contract;
  the `--help` text now states this plainly — no code change. Revisit
  only if a concrete use case forces it.
- `capabilities --types` / `--fields` / `--used` (report bug #7).
  `schema export` already offers these for the agent bootstrap path;
  `capabilities --compact --surface <s>` covers the payload-size story.

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
