# Roadmap — Phase 1 through Phase 4

> **Status as of 2026-04-23:** Phase 1 complete, Phase 2 complete,
> Phase 3A complete (keychain + install library + built-in CLI install
> command), Phase 3B tracked in the separate companion skill repo,
> Phase 4 shipped at v0.2 (rules engine with MQTT + cron +
> webhook triggers, condition composition, weekday filter).
> Tracks β / γ / δ / ε all shipped between v2.10.0 and v2.12.0.
> Note: Track γ is a runtime capability increment on the v0.2 rule
> model, not a separate policy schema version.

This file is the **single source of truth** for phase numbering across
the two repos in this project:

| Repo                                   | What it delivers                          | Uses phases?                              |
|----------------------------------------|-------------------------------------------|-------------------------------------------|
| `switchbot-openapi-cli` (this repo)    | CLI binary, MCP server, rules engine      | **Yes** — Phase 1/2/3/4 are defined here  |
| companion skill repo (sibling)         | Conversational skill packaging of the CLI | **No** — uses orthogonal `autonomyLevel`  |

The skill repo does **not** re-number phases. It declares
`tracksCliPhase: ">=4"` and an autonomy dimension
(`autonomyLevel: L1 | L2 | L3`). The phase table below is what it
points back to.

## Completion matrix (scope clarity)

| Capability | This repo (`switchbot-openapi-cli`) | Cross-repo (`+ companion skill repo`) | Notes |
|---|---|---|---|
| Phase 1 (manual orchestration) | Shipped | Shipped | Stable in v2.7.x |
| Phase 2 (policy tooling) | Shipped | Shipped | v0.1 + v0.2 policy schema support |
| Phase 3A (keychain + install CLI) | Shipped | Shipped | `switchbot install` / `switchbot uninstall` |
| Phase 3B (skill packaging + external registry) | External tracking only | In progress outside this repo | Owned by companion skill repo |
| Phase 4 (rules engine, v0.2 model) | Shipped | Shipped | MQTT/cron/webhook + `days` + `all`/`any`/`not` |
| Track β / γ / δ / ε | Shipped | Shipped (β partially external for registry publish) | γ is a v0.2 capability increment |

---

## The four phases (delivery dimension)

Each phase is a **shipped capability**, not a time box. The CLI binary
at the phase's tag is usable end-to-end on its own — there is no phase
that requires a later phase to be useful.

### Phase 1 — Manual orchestration foundation *(shipped, v2.7.x)*

**What it is:** the stable CLI that an operator (or agent) can drive
command by command. Read device state, send commands, watch events,
keep an audit trail. Everything an agent needs to *execute* — nothing
that *decides*.

Surfaces that landed in Phase 1:

- `devices list | status | command | batch | watch`
- `events tail | mqtt-tail` (cloud-issued MQTT, no extra broker)
- `scenes list | run`
- `webhook setup | query | delete`
- `plan run | validate` (JSON batch executor with dry-run preview)
- `history show | replay`, `audit.log` JSONL writer
- `catalog show | diff`, `schema export`, `capabilities --json`
- `doctor` smoke test
- `mcp serve` (stdio + Streamable HTTP) for AI agents
- `agent-bootstrap --compact` cold-start snapshot
- Global flags: `--json`, `--format`, `--dry-run`, `--verbose`,
  `--audit-log`, `--profile`

Phase 1 is the **manual-orchestration experience in full**. See
`docs/phase-1-manual-orchestration.md` for why this is not a
half-shipped state — it is the whole contract for L1 (manual-agent)
use and the foundation every later phase composes on top of.

### Phase 2 — Policy tooling *(shipped, v2.8.0)*

**What it is:** the one file an operator edits to express preferences
without touching code or CLI flags. The CLI reads it, the rules engine
reads it, the MCP server reads it, and `doctor` reports on it.

Surfaces:

- `policy new | validate | migrate` (v0.1 and v0.2 schemas)
- Default `policy.yaml` discovery rules
- Aliases (human-readable device names)
- Quiet hours (local-time windows, midnight-crossing supported)
- Confirmation tiers (destructive / mutation / read)
- Audit log path + retention hint
- `policyStatus` in `agent-bootstrap` output + MCP tool
- Destructive-command guard (rejects dangerous commands in rules)

### Phase 3 — One-command install + secure credential storage

Phase 3 is **split in two**, with 3A shipped in this repo and 3B
published as a separate skill repo.

**Phase 3A — Keychain + install CLI *(shipped, v2.8.x → v2.10.0)*:**

- `src/credentials/keychain.ts` abstraction with four backends: macOS
  `security(1)`, Windows PowerShell + Win32 `CredRead`/`CredWrite`,
  Linux `secret-tool` (libsecret), and a `0600` file fallback
- `switchbot auth keychain describe | get | set | delete | migrate`
- `doctor` + `agent-bootstrap` report the active credential source
- `src/install/` preflight + rollback-aware step runner (library)
- `switchbot install` / `switchbot uninstall` built-in CLI commands
  (v2.10.0): one-command Quickstart → doctor → all-green; rollback on
  any step failure. `--agent claude-code` auto-symlinks the skill;
  other agents print a recipe. `--purge` for one-flag full teardown.

**Phase 3B — Skill packaging + external registry:**

- Tracked in the sibling companion skill repo
- `SKILL.md` + `manifest.json` + skill-side examples
- Publishing to Claude Desktop / other agent surfaces + external registries

### Phase 4 — Rules engine v0.2 *(shipped, v2.8.x → v2.11.0)*

**What it is:** the declarative leap. Rules live in the same
`policy.yaml`, and the engine executes them without a separate daemon.

Surfaces (v2.9.0 baseline + v2.11.0 additions):

- `switchbot rules lint | list | run | reload | tail | replay`
- Triggers: `mqtt` (shadow events), `cron` (local time, optional
  `days` weekday filter), `webhook` (bearer-token HTTP ingest)
- Conditions: `time_between` (quiet-hours-aware), `device_state`
  (per-tick cache), `all` / `any` / `not` logical composition
- Per-rule `throttle` (`max_per: "10m"` style)
- Per-rule `dry_run` (plan without firing)
- Hot reload: `SIGHUP` on Unix, pid-file sentinel on Windows
- Audit log v2: `rule-fire`, `rule-fire-dry`, `rule-throttled`,
  `rule-webhook-rejected` records

Phase 4 is **opt-in**. Existing Phase 1/2 users who never enable
`automation:` in their policy pay zero cost for it being present.

---

## Autonomy dimension (skill side)

The skill repo uses an orthogonal label — `autonomyLevel` — so that
skill releases do not need to wait on CLI phase boundaries.

| Level | Meaning                                          | What the skill does                                                      | CLI phase it requires |
|-------|--------------------------------------------------|--------------------------------------------------------------------------|-----------------------|
| **L1** | Manual orchestration, one command at a time    | Skill turns NL into CLI calls; user confirms each mutation               | Phase 1 or later      |
| **L2** | Semi-autonomous, propose-then-approve            | Skill composes multi-step plans; `--require-approval` gates each step   | Phase 2 or later      |
| **L3** | Fully autonomous inside the policy envelope     | Skill writes a rule, the engine owns execution without further prompts  | Phase 4 or later      |

The mapping from `autonomyLevel` to `tracksCliPhase` is declared in
the skill's `manifest.json` `roadmap` block, which points back here.

---

## Completed tracks (shipped post-v2.9.0)

- **Track β — one-command install surface *(shipped, v2.10.0)*.**
  Top-level `switchbot install` / `switchbot uninstall` wrapping the
  Phase 3A library. CLI assumed already in PATH; doctor runs as
  warn-only post-step. Phase 3B (registry entry) still external.
- **Track γ — rules v0.2 capability increment *(shipped, v2.11.0)*.**
  `days` weekday filter on cron triggers; `all` / `any` / `not`
  condition composition. Per-trigger debounce and profile-scoped rules
  remain deferred.
- **Track δ — semi-autonomous workflow L2 *(shipped, v2.12.0)*.**
  `plan suggest --intent <text> --device <id>...` scaffolds a Plan
  JSON from natural language. `plan run --require-approval` gates each
  destructive step with a TTY prompt. MCP tool `plan_suggest` available.
- **Track ε — cross-OS CI matrix for keychain *(shipped, v2.11.0)*.**
  GitHub Actions matrix: macOS (temp keychain), Linux (D-Bus +
  gnome-keyring), Windows (native Credential Manager).

---

## Versioning rules this repo follows

- **CLI semver:** Phase milestones map to minor bumps (Phase 2 →
  v2.8.0; Phase 3A + Phase 4 landing together → v2.9.0). No phase
  bump forces a major bump on its own.
- **Policy schema:** `0.1 → 0.2` is a minor. A major schema bump
  happens only if the top-level shape breaks (no planned v1.x yet).
- **Rules track labels vs schema versions:** Track names (for example
  γ) describe runtime increments and do not imply a policy schema bump;
  current schema line remains `0.1 | 0.2`.
- **Skill manifest:** the skill repo owns its own semver track,
  independent of CLI version. `authority.cli` in
  `manifest.json` narrows the compatible CLI range per skill release.
- **`CATALOG_SCHEMA_VERSION === AGENT_BOOTSTRAP_SCHEMA_VERSION`** is
  a hard sentinel — a mismatch fails `doctor`'s `catalog-schema`
  check. Agents SHOULD poll that check each session.
