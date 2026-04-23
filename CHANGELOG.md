# Changelog

All notable changes to `@switchbot/openapi-cli` are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.13.0] - 2026-04-24

Feature release — L3 fully autonomous rule authoring for agents.

### Added — `rules suggest`

- New subcommand `switchbot rules suggest --intent <text>` scaffolds a
  candidate automation rule YAML from natural language intent + optional
  device list. No LLM involved — uses keyword heuristics for trigger
  inference (mqtt/cron/webhook), schedule inference (am/pm/night/morning),
  and command inference (8 patterns). Always emits `dry_run: true` and
  `throttle: { max_per: "10m" }` for MQTT triggers.
- Options: `--trigger`, `--device` (repeatable), `--event`, `--schedule`,
  `--days`, `--webhook-path`, `--out`.
- Output: raw rule YAML on stdout; `--json` for structured output.
- Exported `suggestRule(opts)` pure function in `src/rules/suggest.ts`.

### Added — `policy add-rule`

- New subcommand `switchbot policy add-rule` reads rule YAML from **stdin**
  and appends it to `automation.rules[]` in policy.yaml, preserving all
  existing comments and formatting.
- `--dry-run`: print the unified diff without writing to disk.
- `--enable`: set `automation.enabled: true` after inserting the rule.
- `--force`: overwrite an existing rule with the same name.
- Pipeline-friendly: `switchbot rules suggest ... | switchbot policy add-rule`.
- Exported `addRuleToPolicySource()` / `addRuleToPolicyFile()` in
  `src/policy/add-rule.ts`.

### Added — MCP tools `rules_suggest` + `policy_add_rule`

- `rules_suggest` (tier `read`): MCP equivalent of `rules suggest`; agents
  call it without shell access to draft a rule YAML.
- `policy_add_rule` (tier `action`): MCP equivalent of `policy add-rule`;
  agents inject a rule into policy.yaml and receive the diff for user
  confirmation. Always run with `dry_run: true` first.
- MCP tool count: 15 → 17.

### Changed

- `src/lib/command-keywords.ts`: `COMMAND_KEYWORDS` array extracted from
  `plan.ts` into a shared module; imported by both `plan.ts` and
  `rules/suggest.ts`.
- `docs/agent-guide.md`: new section "Autonomous rule authoring (L3)"
  covering the suggest → add-rule → lint → reload → dry-run → arm workflow.

## [2.12.0] - 2026-04-23

Feature release — semi-autonomous L2 workflow for agents.

### Added — `plan suggest`

- New subcommand `switchbot plan suggest --intent <text> --device <id>...`
  scaffolds a candidate Plan JSON from natural language intent + device list.
  No LLM involved — uses keyword heuristics to match the intent against 8
  command patterns (`turnOn`, `turnOff`, `press`, `lock`, `unlock`, `open`,
  `close`, `pause`). Defaults to `turnOn` with a warning when unrecognised.
  Output goes to stdout (or `--out <file>`); warnings go to stderr.
- Exported `suggestPlan(opts)` pure function for programmatic use.

### Added — `plan run --require-approval`

- New flag `--require-approval` on `plan run` enables per-step TTY
  confirmation for destructive steps: the CLI prints the step details and
  prompts `[y/N]` before executing. Rejecting a step marks it `skipped`
  with `decision: "rejected"` in the JSON output.
- Non-TTY environments (CI, pipes) auto-reject destructive steps.
- `--require-approval` is mutually exclusive with `--json` (exits with an
  error if both are passed).
- `--yes` takes precedence over `--require-approval` as blanket approval.

### Added — MCP `plan_suggest` tool

- New read-only MCP tool `plan_suggest({ intent, device_ids })` wraps
  `suggestPlan()` for agents that prefer to stay in the MCP session.
  Returns `{ plan, warnings }` structured content.



Feature release — install/uninstall UX polish, cross-OS keychain CI,
and two rules engine enhancements.

### Changed — `switchbot install` polish

- **`--force`** replaces an existing skill symlink pointing at a different
  target, and bypasses the `SKILL.md` presence check (for in-development
  skill repos).
- **`--verify`** runs `switchbot doctor --json` as a warn-only post-check
  after a successful install. The result is surfaced (text or `--json`)
  but never changes the exit code — a doctor failure after a good install
  does not trigger rollback.
- **`stepSymlinkSkill`** now requires `SKILL.md` at the root of
  `--skill-path` before creating a link, so linking a random directory is
  caught at install time. Non-automating agents (cursor/copilot) are
  unaffected — they print a recipe before the check runs.
- Existing symlinks pointing at a **different** target are now a hard
  error without `--force`; pointing at the same target remains idempotent.
- **Preflight** gains an `agent-skills-dir` check for `--agent claude-code`
  that probes `~/.claude/skills/` writable before the step can fail.

### Changed — `switchbot uninstall` polish

- **`--purge`** is shorthand for `--yes --remove-creds --remove-policy`:
  removes everything in one flag without any prompts.

### Added — CI

- **`.github/workflows/keychain-matrix.yml`** — new workflow that runs the
  credential + install-step test suites on macOS (temp keychain),
  Linux (D-Bus + gnome-keyring), and Windows (Credential Manager). Triggers
  on changes under `src/credentials/`, `src/install/`, and their test
  counterparts.

### Added — `rules trigger.days` (γ-lite)

- Cron triggers now accept an optional **`days`** filter:
  ```yaml
  when:
    source: cron
    schedule: "0 9 * * *"
    days: [mon, tue, wed, thu, fri]
  ```
  Values are matched case-insensitively; both 3-letter abbreviations
  (`mon`) and full names (`monday`) are accepted. Firings on unlisted
  weekdays are silently suppressed before dispatch — throttle counters and
  audit log entries are not written for suppressed firings.

### Added — `rules conditions` composition (γ)

- Rule conditions can now be composed with **`all`** (AND), **`any`** (OR),
  and **`not`** (negation):
  ```yaml
  conditions:
    - any:
        - time_between: ["22:00", "06:00"]
        - device: lamp
          field: power
          op: "=="
          value: "on"
    - not:
        time_between: ["08:00", "20:00"]
  ```
  Nesting is unlimited. The top-level `conditions[]` array remains
  AND-joined so existing flat rules are unaffected.

### Notes

- 1676 tests pass (+22 vs 2.10.0: 6 polish + 9 day_of_week + 8
  and/or/not + 1 purge).

## [2.10.0] - 2026-04-23

Feature release — adds `switchbot install` / `switchbot uninstall`,
collapsing the Phase 3 one-command bootstrap UX onto the Phase 3A
orchestrator library that shipped in 2.9.0.

### Added — `switchbot install` (Phase 3B, in-CLI)

- **`switchbot install`** — one-command setup that composes four
  steps with rollback on failure: prompt credentials → write keychain
  → scaffold `policy.yaml` → symlink the Claude Code skill. The step
  library (`src/install/default-steps.ts`) is a thin layer over the
  generic `runInstall()` runner, so each factory is independently
  unit-tested and individually skippable via `--skip`.
- **`--agent <name>`** — `claude-code` (default: auto-links
  `~/.claude/skills/switchbot` to `--skill-path`), `cursor` / `copilot`
  (prints a skill-install recipe for docs users to follow), `none`
  (skips the skill step entirely).
- **`--skill-path <dir>`** — points at a local clone of
  the companion skill repo. No auto-clone — fork/offline/pin
  semantics stay in the user's court. On Windows the link uses an
  NTFS junction so it works without elevation.
- **`--token-file <path>`** — two-line credential file for
  non-interactive installs. Deleted on success; left alone on failure
  so the user can retry.
- **`--skip <names>`** — comma-separated step names to skip; useful
  for partial re-runs after fixing one failing step.
- **`--dry-run`** — prints the step list (text) or a structured
  preview (`--json`) without mutation.
- **Exit codes**: `0` ok · `2` preflight failed (nothing changed) ·
  `3` step failed, rollback completed · `4` rollback had residue (the
  printed output tells the user what to clean up).
- **Deliberate non-decisions**: doctor verification is NOT a step
  (treating its failure as rollback-worthy would destroy a
  freshly-installed good state); `install` prints
  `next: switchbot doctor` as a hint instead.

### Added — `switchbot uninstall`

- **`switchbot uninstall`** — reverse of install. Removes the skill
  symlink (default yes, confirm), credentials (opt-in via
  `--remove-creds`), and `policy.yaml` (opt-in via `--remove-policy`
  since user edits may live there). `--yes` assumes yes to every
  confirmation; `--dry-run` previews; `--json` emits structured
  outcomes.
- Unlike install, uninstall is **not** rollback-safe — it keeps going
  on per-step failure and exits `3` if anything failed, so the user
  can read the per-action report and clean up manually.
- The CLI binary is never uninstalled. Users remove it via
  `npm rm -g @switchbot/openapi-cli`.

### Changed

- **`src/commands/policy.ts`** exports `scaffoldPolicyFile()` so the
  install step can reuse the exact scaffolding logic `policy new`
  uses — no drift risk between the two code paths.
- **`src/commands/config.ts`** exports `promptTokenAndSecret()` and
  `readCredentialsFile()` for the install step to reuse the same
  terminal-prompt behavior `config set-token` has.

### Notes

- No API/CLI surface breakage. Existing scripts continue to work.
- Path for the skill symlink: `~/.claude/skills/switchbot` on
  claude-code; other agents receive a recipe block instead of an
  auto-link.
- 1654 tests pass (+30 vs 2.9.0: 20 step factory unit tests + 5
  install smoke + 5 uninstall smoke).

## [2.9.0] - 2026-04-23

Feature release — Policy v0.2, the Phase 4 rules engine, Phase 3A
keychain support, and the install orchestrator library. This is the
release that makes the CLI feel like a single integrated product
instead of a collection of commands that happen to share a binary.

### Added — Policy v0.2 schema (Phase 2 continuation)

- **`policy new --version 0.2`** emits a v0.2 starter file carrying
  the new `automation.rules[]` block. `policy new` still defaults to
  v0.1 so existing CLI builds keep parsing the output — the default
  flip is tracked on the Roadmap for v3.0.
- **`policy validate`** dispatches the validator by schema version
  (`0.1` or `0.2`), so a mixed install can hold two policy files at
  different versions without false-positive errors.
- **`policy migrate 0.1 → 0.2`** walks the YAML with `yaml@2`'s CST,
  rewrites the `version:` scalar, and appends an `automation:` block
  stub. Comments and key order are preserved byte-for-byte.
- **Destructive-command validator hook** — the v0.2 schema rejects
  rules whose `then.command` would fire `unlock`, `garage-door open`,
  `keypad createKey`, or other destructive actions. The rejection is
  a schema error, not a runtime surprise.
- **`doctor`, `agent-bootstrap --compact`, MCP `policy_validate`**
  now surface the detected policy schema version.

### Added — Rules engine v0.2 (Phase 4)

- **`switchbot rules lint`** — static checks against `policy.yaml`:
  schema, alias resolution, cron expression validity, duplicate rule
  names, destructive-command guard. Exit code 0/1/2/3.
- **`switchbot rules list [--json]`** — prints every rule's name,
  trigger summary, `dry_run` state, and throttle window.
- **`switchbot rules run [--dry-run] [--max-firings N]`** — the
  engine proper. Composes three triggers (`mqtt` / `cron` / `webhook`),
  two conditions (`time_between` / `device_state`), and the
  per-rule `throttle` and `dry_run` blocks.
- **`switchbot rules reload`** — sends SIGHUP on Unix, writes a
  pid-file sentinel on Windows. The engine reloads the policy without
  restarting the process; in-flight firings complete on the old
  policy.
- **`switchbot rules tail [--follow]`** — tails the audit log
  filtered to `rule-*` entries.
- **`switchbot rules replay --since <duration> --dry-run`** — reads
  past MQTT shadow events from the cache and replays them against
  the current rule set without firing commands, for verifying rule
  changes before enabling them.
- **Audit log v2** — `rule-fire`, `rule-fire-dry`, `rule-throttled`,
  and `rule-webhook-rejected` record types. Format is documented in
  `docs/audit-log.md`.
- **MQTT trigger** — subscribes to the cloud-issued broker, uses the
  same `extractShadowEvent` helper as `events mqtt-tail`.
- **Cron trigger** — runs on local time, quiet-hours aware.
- **Webhook trigger** — bearer-token HTTP ingest on a configurable
  port; tokens stored in the keychain, never in `policy.yaml`.
- **`device_state` condition** — per-tick cached lookups so a single
  firing doesn't hit the API N times for N conditions.

### Added — Phase 3A: keychain + install orchestrator

- **`src/credentials/keychain.ts`** abstraction with four backends:
  macOS `security`, Windows `cmdkey`, Linux `secret-tool` (libsecret),
  and a `0600`-permissioned JSON file fallback. The CLI picks the
  first backend that works on the running platform.
- **`switchbot auth keychain describe | get | set | delete | migrate`**
  — explicit management of credentials in the chosen backend.
  `migrate` moves a value from the file fallback to the OS keychain
  and removes the file entry on success.
- **`doctor`** and **`agent-bootstrap --compact`** report the active
  credential source in a field named `credentialSource`.
- **`src/install/`** — in-repo preflight + rollback-aware step runner
  library that the external plugin-manager install command
  (Phase 3B) can call into. Library only; no top-level install
  subcommand ships in this release (that is Track β).

### Added — Docs

- **`docs/design/roadmap.md`** — authoritative Phase 1-4 table with
  the skill repo's orthogonal `autonomyLevel` L1/L2/L3 mapping.
- **`docs/ux-principles.md`** — 10 principles the CLI, MCP server,
  rules engine, and skill all obey.
- **`docs/phase-1-manual-orchestration.md`** — frames Phase 1 as the
  complete manual-orchestration contract, not a transitional state.
- **`examples/quickstart/`** — 7-step walkthrough + `policy.yaml.example`,
  `config.env.example`, and a systemd unit template for running
  `events mqtt-tail` as a long-lived service.

### Changed

- **README Roadmap section** now points at
  `docs/design/roadmap.md` and lists reserved tracks β / γ / δ / ε
  alongside the existing long-term backlog.
- **README header** — the skill-pointer blockquote now links directly
  to the sibling companion skill repo instead of saying
  "published separately".

### Skill-side impact

- The companion skill is bumped to **0.3.0** in
  the companion skill repo with `authority.cli: ">=2.9.0 <3.0.0"`,
  `policy.version: "0.2"`, and `autonomyLevel: "L1"`. The skill's
  Authoritative command table adds the `switchbot rules *` and
  `switchbot auth keychain *` groups shipped in this release.

## [2.8.0] - 2026-04-22

Feature release — `switchbot policy` command group.

The companion SwitchBot skill reads its behaviour from `~/.config/switchbot/policy.yaml` (aliases, confirmations, quiet hours, audit path). Until this release, a typo in that file failed silently — the skill would load whatever YAML parsed and use defaults for anything it didn't understand, leaving the user to wonder why "bedroom light" didn't work. This release ships a dedicated command group that turns those silent failures into compiler-style errors with line numbers, carets, and fix hints, and eliminates the hand-crafted starter template step from the skill's Quickstart.

### Added

- **`switchbot policy validate [path]`** — validates the policy file against the embedded schema v0.1 (JSON Schema 2020-12). Reports each error with its path, YAML line:col, a source-line snippet + caret, and an action-specific hint (e.g. "paste the deviceId from `switchbot devices list --format=tsv`" on alias pattern mismatches; "destructive actions (lock/unlock/delete*/factoryReset) cannot be pre-approved in policy.yaml" on a forbidden `never_confirm` entry). Supports `--json` for programmatic consumers, `--no-snippet` to drop source preview, `--no-color` for piped output.
- **`switchbot policy new [path]`** — writes a 99-line annotated starter template to the given path (or the default `~/.config/switchbot/policy.yaml`). Refuses to overwrite an existing file unless `--force` is passed. Creates the parent directory if needed.
- **`switchbot policy migrate [path]`** — reports the policy file's schema version against what this CLI supports. No-op today (only v0.1 exists); wired so future releases can run structural upgrades without breaking existing policies.
- **Path resolution precedence**: `[path]` argument > `SWITCHBOT_POLICY_PATH` env var > default `~/.config/switchbot/policy.yaml`. The same resolver is exported for the Phase 3 `agent-bootstrap` install flow to reuse.
- **Exit-code taxonomy** (scriptable): `0` valid / `1` invalid / `2` file-not-found / `3` yaml-parse / `4` internal / `5` exists (on `new` without `--force`) / `6` unsupported-version (on `migrate`). `--json` mode emits the usual `{schemaVersion, error}` or `{schemaVersion, data}` envelope.
- **Embedded schema asset** — `src/policy/schema/v0.1.json` ships in the npm package via a post-build `copy-assets.mjs` step. The skill repository's `examples/policy.schema.json` is the mirror copy; a CI job diffs the two on every push to prevent drift.

### Dependencies

- Added `yaml@^2` (source-map-preserving parser), `ajv@^8` + `ajv-formats@^3` (JSON Schema 2020-12 validator via `ajv/dist/2020`).

### Skill-side impact

- Companion SwitchBot skill v0.2.0 declares `authority.cli: "@switchbot/openapi-cli@>=2.8.0 <3.0.0"` and replaces the manual "edit this file by hand" Quickstart step with `switchbot policy new` + `switchbot policy validate`. See the skill repo's `CHANGELOG.md` for the matching entry.

## [2.7.2] - 2026-04-21

Patch release — CI size-budget fix.

### Fixed

- **`schema export --compact`** — dropped the `resources` block from compact output. In v2.7.0 the resources catalog (scenes / webhooks / keys, ~12 KB) was added to the schema payload unconditionally, which pushed `schema export --compact --used` past the 15 KB agent-prompt budget enforced by CI. The `resources` block is still emitted under the full (non-`--compact`) output, and is always available via `capabilities --json`, which is the canonical source for CLI resource metadata. No behaviour change for `capabilities --json` consumers.

## [2.7.1] - 2026-04-21

AI-discoverability patch. Top-level `--help` / `--help --json` and every
subcommand description now lead with the SwitchBot product category
(smart home: lights, locks, curtains, sensors, plugs, IR appliances) so
AI agents reading help text can identify scope without parsing the
catalog. Identity is consolidated into a single module to prevent drift.

### Changed

- **Top-level `switchbot --help`** — program description rewritten to "SwitchBot smart home CLI — control lights, locks, curtains, sensors, plugs, and IR appliances (TV/AC/fan) via Cloud API v1.1; run scenes, stream real-time events, and integrate AI agents via MCP." (previously the terse "Command-line tool for SwitchBot API v1.1"). Both human and AI scanners now learn the product category on the first line.
- **`switchbot --help --json` (root)** — now carries top-level `product`, `domain`, `vendor`, `apiVersion`, `apiDocs`, and `productCategories[]` fields for programmatic discovery. Subcommand `--help --json` output is unchanged (identity is root-only to keep per-command payloads tight).
- **Subcommand descriptions** — `catalog`, `schema`, `history`, `plan`, `doctor`, `capabilities` now explicitly mention "SwitchBot" so each command self-describes in `--help` (the other 10 top-level commands already mentioned it).
- **README intro** — rewritten to lead with the product category ("SwitchBot smart home CLI — control lights, locks, curtains, sensors, plugs, and IR appliances …") instead of the API version.

### Refactored

- **Shared IDENTITY module** — extracted the product-identity constant to `src/commands/identity.ts`; `capabilities.ts`, `agent-bootstrap.ts`, and `utils/help-json.ts` now import from a single source of truth to prevent field drift. The canonical IDENTITY adds `productCategories: string[]` (8 category keywords AI agents can scan) and clarifies `constraints.transport = "Cloud API v1.1 (HTTPS)"` — the CLI does **not** drive BLE radios directly; BLE-only devices are reached through a SwitchBot Hub, which the Cloud API handles transparently. `agent-bootstrap --json` gains additive identity fields (`apiDocs`, `deviceCategories`, `productCategories`, `agentGuide`) via the shared module; no fields removed.

## [2.7.0] - 2026-04-21

AI-first maturity release. Broader field-alias coverage, richer capability
metadata, and agent-discoverable resource surfaces (scenes, webhooks, keys).

### Added

- **Field aliases** — registry expanded from ~10 to ~51 canonical keys (~98% coverage of catalog `statusFields` + webhook payload fields), dispatched through `devices status`, `devices watch`, and `--fields` parsers. Phase 4 sweep adds ultra-niche sensor/webhook aliases: `waterLeakDetect`, `pressure`, `moveCount`, `errorCode`, `buttonName`, `pressedAt`, `deviceMac`, `detectionState`.
- **safetyTier enum (5 tiers)** — catalog commands now carry `safetyTier: 'read' | 'mutation' | 'ir-fire-forget' | 'destructive' | 'maintenance'`; replaces the legacy `destructive: boolean` flag.
- **`DeviceCatalogEntry.statusQueries`** — read-tier catalog entries exposing queryable status fields; derived from existing `statusFields` plus a curated `STATUS_FIELD_DESCRIPTIONS` map. Powers `safetyTier: 'read'` and lights up `capabilities.catalog.readOnlyQueryCount`.
- **`capabilities.resources`** — new top-level `resources` block in `capabilities --json` and `schema export`, exposing scenes (list/execute/describe), webhooks (4 endpoints + 15 event specs + constraints), and keypad keys (4 types: permanent/timeLimit/disposable/urgent). Each endpoint/event declares its safety tier so agents can plan without trial-and-error.
- **Multi-format output** — `--format=yaml` and `--format=tsv` for all non-streaming commands (devices list, scenes list, catalog, etc.); `id` / `markdown` formats preserved. `--json` remains the alias for `--format=json`.
- **doctor upgrades** — new `--section`, `--list`, `--fix`, `--yes`, `--probe` flags; new checks `catalog-schema`, `audit`, `mcp` (dry-run — instantiates MCP server and counts registered tools), plus live MQTT probe (guarded by `--probe`, 5 s timeout).
- **Streaming JSON contract** — every streaming command (watch / events tail / events mqtt-tail) now emits a `{ schemaVersion, stream: true, eventKind, cadence }` header as its first NDJSON line; documented in `docs/json-contract.md`.
- **Events envelope** — unified `{ schemaVersion, t, source, deviceId, topic, type, payload }` shape across `events tail` and `events mqtt-tail`.
- **MCP tool schema completeness** — every tool input schema now carries `.describe()` annotations; new test suite enforces this.
- **Help-JSON contract test** — table-driven coverage for all 16 top-level commands.
- **batch `--emit-plan`** — new canonical flag alias for the deprecated `--plan`.

### Changed

- **Error envelope** — all error paths route through `exitWithError()` / `handleError()`; `--json` failure output always carries `schemaVersion` + structured `error` object.
- **Quota accounting** — requests are recorded on attempt (request interceptor) instead of on success, so timeouts / 4xx / 5xx count against daily quota.
- **`--json` vs `--format=json`** — both paths go through the same formatter; `--json` is now documented as the alias.

### Deprecated

- `destructive: boolean` on catalog entries — derived from `safetyTier === 'destructive'`. Removed in v3.0.
- `DeviceCatalogEntry.statusFields` — superseded by `statusQueries`. Removed in v3.0.
- `batch --plan` — renamed to `--emit-plan`. Old flag still works but prints a deprecation warning to stderr. Removed in v3.0.
- Events legacy fields `body` / `remote` on `events tail` — superseded by the unified envelope. Removed in v3.0.

### Reserved

- `safetyTier: 'maintenance'` — enum value accepted by the type system but no catalog entry uses it today. Reserved for future SwitchBot API endpoints (factoryReset, firmwareUpdate, deepCalibrate).

### Fixed

- Quota counter no longer under-counts requests that fail at the transport or server layer.

## [2.6.4] - 2026-04-21

### Added

- `devices describe` now shows a tip for device types that support `devices expand` (Air Conditioner, Curtain, Curtain 3, Blind Tilt, Relay Switch 2PM); `--json` output includes an `expandHint` field with `command`, `flags`, and a ready-to-run `example` string

### Fixed

- `--filter controlType=X` now works correctly; `controlType` was documented as a filterable key but was missing from the canonical key registry
- `field-aliases.ts`: removed `category` from the `controlType` alias list to prevent collision with the physical/IR `category` filter key
- MCP stdio path now handles `SIGTERM` and `SIGINT` with the same graceful shutdown as the HTTP path (30 s force-exit timeout, `isShuttingDown` guard)

### Changed

- Extracted `exitWithError()` helper in `output.ts`; deduplicated `isJsonMode()` across `index.ts` and `config.ts`

## [2.6.3] - 2026-04-21

### Fixed

- MCP `send_command` dry-run now strictly rejects unknown command names when catalog has a definitive match (#55)
- MCP `send_command` dry-run rejects commands sent to read-only sensors (e.g. Meter)
- Previous v2.6.2 fix used lenient `validateCommand` which silently passed when catalog lookup was ambiguous

## [2.6.2] - 2026-04-21

### Fixed

- `scenes execute --dry-run` now outputs structured result on stdout instead of silently exiting (#54)
- MCP `send_command` dry-run validates command name against catalog before returning success (#55)
- MCP `run_scene` dry-run validates sceneId against scene list before returning success (#56)

## [2.6.1] - 2026-04-21

Follow-up to v2.6.0 from the external re-audit. Three real findings
(R-2, R-3, R-4) plus a repo-wide English-only chore; R-1 rejected with
reason.

### Fixed

- **MCP `send_command` now runs the same client-side parameter validator
  as the CLI** (`setBrightness`, `setColor`, AC `setAll`, Curtain /
  Blind Tilt `setPosition`, Relay `setMode`). Out-of-range values fail
  with `isError:true` and `usage` class before the API is called, in
  both the `dryRun:true` and live paths. `setColor` hex / named-colour /
  comma forms are normalised to the `R:G:B` wire format before
  dispatch, and the dry-run `wouldSend.parameter` reflects the
  normalised value. (R-2)

### Documentation

- **`--filter` empty-value rejection** is now called out in the README.
  A clause like `name~` or `type=` with an empty RHS exits `2` — the
  parser refuses to guess between "no constraint" and "match empty
  string". Drop the clause outright to remove the constraint. (R-4)

### Tests

- Added coverage locking in plaintext `scenes describe <unknown>`
  rendering of `Did you mean: <name> (<id>), …?` when candidates are
  present (and suppressing it when the scene list is empty). The
  behaviour already worked in v2.6.0; the re-audit's counter-example
  was a 0-scene account. (R-3)

### Chore

- Stripped Chinese characters from README, source comments, help text,
  and test fixtures in favour of neutral English examples
  (`Living Room AC`, `family=home`, `alias=bedroom-lamp`, etc.).
  The Chinese left in `tests/utils/string.test.ts` is intentional — it
  exercises the CJK branch of `normalizeDeviceName` (`\u4e00-\u9fff`
  in `src/utils/string.ts:20`), which is a supported product feature.

### Rejected

- **R-1 (MCP error envelope for Zod validation failures)** — rejected
  by design. The MCP SDK wraps every tool handler error as
  `CallToolResult.isError:true`; only `UrlElicitationRequired` escapes
  as a JSON-RPC `error`. Faking a JSON-RPC error for Zod failures would
  require forking or monkey-patching the SDK. The text payload already
  carries `"MCP error -32602: …"`, so agents can still extract the
  code from `content[0].text` if they need it.

---

## [2.6.0] - 2026-04-21

Addresses 14 findings from the external v2.5.1 audit (B-1 … B-16, minus
the two declined-as-misread items and four P3 items parked for v3.x).
All in a single minor bump — no staged releases.

### Added

- **`--filter key!=value`** (negated clause) across `devices list`,
  `devices batch`, and `events tail` / `mqtt-tail`. `neq` is a negated
  substring by default; `category` stays exact. (B-5)
- **`--allow-unknown-device`** and **`--skip-param-validation`** on
  `devices command`. Escape hatches for the stricter defaults below. (B-1, B-3)
- **`capabilities --used`** filters the per-type summary to devices
  present in the local cache. Same semantics as `schema export --used`. (B-9)
- **`catalog list`** (alias for `show`) and **`catalog search <keyword>`**
  (fuzzy match across type, aliases, role, commands). (B-8)
- **`--retry-on-5xx <n>`** (default `2`) transparently retries `502`/`503`/
  `504` and request timeouts on idempotent `GET`s with exponential backoff.
  Mutating calls still never auto-retry — use `--idempotency-key` for
  safe `POST` retries. (B-11)
- **`commandMeta` flat manifest** in `capabilities --json`: each subcommand
  leaf now carries
  `{mutating, consumesQuota, idempotencySupported, agentSafetyTier, verifiability, typicalLatencyMs}`,
  and a path-keyed lookup table is published at the top level so agents
  don't have to walk the tree. (B-4)

### Fixed

- **`--flag=value` equals form** is now recognized everywhere.
  `--format=json`, `--timeout=5000`, `--config=/path`, `--fields=a,b,c`
  etc. previously dropped silently through `getFlagValue`; they now work
  identically to the space form. (B-6)
- **`devices commands <type...>`** iterates truly variadic:
  `devices commands Bot Curtain` prints both sections instead of joining
  the tokens as one type name. Multi-word unquoted form still works. (B-7)
- **`scenes describe <unknown>`** plaintext branch now renders
  `Did you mean: …?` candidates — previously only the `--json` branch
  did. (B-10)
- **`setColor`** accepts `R:G:B`, `R,G,B`, `#RRGGBB`, `#RGB`, and 16 CSS
  named colors (`red`, `blue`, `orange`, …); all normalize to `R:G:B`
  before hitting the API. (B-12)
- **Ambiguous `--name` hint** now explicitly lists
  `--name-strategy=fuzzy` / `--name-strategy=first` so users know how to
  break ties. (B-15)
- **Empty results under `--table-style markdown`** render as `_(empty)_`
  rather than a header-only skeleton. (B-16)
- **Error-path formatting** is consistent with `--format=json`: every
  terminal error path now routes through `emitJsonError` / `handleError`,
  so piped consumers can always `JSON.parse` stderr (or stdout in JSON
  mode) without string parsing. (B-14)

### Changed

- **`setBrightness`, `setColor`, and Curtain `setPosition` single-value
  form** are now validated client-side. `setBrightness` requires integer
  `1-100`; `setColor` validates each component `0-255`; `setPosition`
  validates `0-100`. Invalid input exits 2 *before* hitting the network.
  **Soft-breaking**: scripts that relied on the API silently rejecting
  bad input will now see exit 2 earlier. Pass `--skip-param-validation`
  as a narrow escape hatch. (B-1)
- **Unknown `deviceId`** in `devices command` now exits 2 by default with
  a candidate list, rather than warning-and-passing-through. This makes
  `--dry-run` a reliable pre-flight gate for agents and plans.
  **Soft-breaking**: pass `--allow-unknown-device` to restore
  pass-through behavior for scripted workflows. (B-3)

### Documentation

- Roadmap section at the bottom of README for the v3.x track
  (daemon mode, standalone `npx` MCP package, `self-test` harness,
  record/replay) — audit items B-17 / B-18 / B-19 / B-21 are parked there
  rather than folded into this minor.
- Clarified that `devices expand` is intentionally limited to
  multi-parameter commands (`setAll`, `setPosition`, `setMode`);
  single-parameter commands like `setBrightness 50` or `setColor #FF0000`
  don't need semantic flags. (B-13)

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

This version also contains one **breaking change** — the `--filter` grammar
is now unified across `devices list`, `devices batch`, and
`events tail` / `mqtt-tail`. `devices batch` and `events tail` keys that
used to require exact matches are now substrings. See
**Changed (BREAKING)** below for the migration.

### Changed (BREAKING)

- **`--filter` grammar unified across three surfaces** — `devices list`,
  `devices batch`, and `events tail` / `mqtt-tail` now share one DSL:
  `key=value` (case-insensitive substring; exact only for `category`),
  `key~value` (explicit case-insensitive substring), and
  `key=/pattern/` (case-insensitive regex; invalid regex returns a usage
  error). Each command still exposes its own key set — see README
  §"Filter expressions — per-command reference". (bug #39)
  - **Breaking**: `devices batch --filter 'type=Bot'` previously required
    an exact match and now treats `Bot` as a substring (matches `Bot Plus`
    too). Pair `=` with a more specific value, or filter post-hoc, if
    exact match was load-bearing.
  - **Breaking**: `devices batch --filter 'type~=...'` (the `~=` spelling)
    is removed. Use `~` instead: `type~Light`.
  - **Breaking**: `events tail --filter 'deviceId=ABC'` is now a substring
    match (previously exact).

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
  `D:/servicdata/workspace/switchbot-cli-v2.4.0-report.md`.

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

Large agent-experience overhaul driven by third-party agent + Claude integration
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
