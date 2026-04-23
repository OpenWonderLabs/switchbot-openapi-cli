# Roadmap — Phase 1 through Phase 4

> **Status as of 2026-04-23:** Phase 1 complete, Phase 2 complete,
> Phase 3A complete (keychain + install library), Phase 3B tracked in
> the separate
> [`openclaw-switchbot-skill`](https://github.com/OpenWonderLabs/openclaw-switchbot-skill)
> repo, Phase 4 shipped at v0.2 (rules engine with MQTT + cron +
> webhook triggers). Track β / γ / δ are reserved for post-v2.9.0 work.

This file is the **single source of truth** for phase numbering across
the two repos in this project:

| Repo                                   | What it delivers                          | Uses phases?                              |
|----------------------------------------|-------------------------------------------|-------------------------------------------|
| `switchbot-openapi-cli` (this repo)    | CLI binary, MCP server, rules engine      | **Yes** — Phase 1/2/3/4 are defined here  |
| `openclaw-switchbot-skill` (sibling)   | Conversational skill packaging of the CLI | **No** — uses orthogonal `autonomyLevel`  |

The skill repo does **not** re-number phases. It declares
`tracksCliPhase: ">=4"` and an autonomy dimension
(`autonomyLevel: L1 | L2 | L3`). The phase table below is what it
points back to.

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
- `~/.config/openclaw/switchbot/policy.yaml` discovery rules
- Aliases (human-readable device names)
- Quiet hours (local-time windows, midnight-crossing supported)
- Confirmation tiers (destructive / mutation / read)
- Audit log path + retention hint
- `policyStatus` in `agent-bootstrap` output + MCP tool
- Destructive-command guard (rejects dangerous commands in rules)

### Phase 3 — One-command install + secure credential storage

Phase 3 is **split in two**, with 3A shipped in this repo and 3B
published as a separate skill repo.

**Phase 3A — Keychain + install orchestrator library *(shipped, v2.8.x)*:**

- `src/credentials/keychain.ts` abstraction with four backends: macOS
  `security`, Windows `cmdkey`, Linux `secret-tool` (libsecret), and a
  `0600` file fallback
- `switchbot auth keychain describe | get | set | delete | migrate`
- `doctor` + `agent-bootstrap` report the active credential source
- `src/install/` preflight + rollback-aware step runner (library only;
  external `openclaw plugins install` calls into it)

**Phase 3B — Skill packaging + ClawHub registry:**

- Tracked in the sibling
  [`openclaw-switchbot-skill`](https://github.com/OpenWonderLabs/openclaw-switchbot-skill)
  repo
- `SKILL.md` + `manifest.json` + skill-side examples
- Publishing to ClawHub / Claude Desktop / other agent surfaces

### Phase 4 — Rules engine v0.2 *(shipped, v2.8.x → v2.9.0)*

**What it is:** the declarative leap. Rules live in the same
`policy.yaml`, and the engine executes them without a separate daemon.

Surfaces:

- `switchbot rules lint | list | run | reload | tail | replay`
- Triggers: `mqtt` (shadow events), `cron` (local time), `webhook`
  (bearer-token HTTP ingest)
- Conditions: `time_between` (quiet-hours-aware), `device_state`
  (per-tick cache)
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

## Reserved tracks (not yet started)

These are the next candidates after v2.9.0. Each is a standalone
track, not a dependency of another:

- **Track β — one-command install surface.** A top-level
  `switchbot install` wrapper around the Phase 3A library. Requires
  ClawHub registry infra (Phase 3B) to be callable end-to-end.
- **Track γ — rules v0.3.** User-reported missing pieces:
  `day_of_week`, `and`/`or` composition, per-trigger debounce,
  profile-scoped rules, templating in `then.command`.
- **Track δ — semi-autonomous workflow (L2).** A `plan suggest` →
  `plan run --require-approval` pairing so an agent can draft a
  multi-step plan, surface the full diff, and fire on a single Y/N.
- **Track ε — cross-OS CI matrix for keychain.** The four backends
  are unit-tested; end-to-end matrix (macOS GH runner + Windows GH
  runner + Linux libsecret container) is still deferred.

None of β/γ/δ/ε ship in v2.9.0. They are listed here so future
planning uses the same labels.

---

## Versioning rules this repo follows

- **CLI semver:** Phase milestones map to minor bumps (Phase 2 →
  v2.8.0; Phase 3A + Phase 4 landing together → v2.9.0). No phase
  bump forces a major bump on its own.
- **Policy schema:** `0.1 → 0.2` is a minor. A major schema bump
  happens only if the top-level shape breaks (no planned v1.x yet).
- **Skill manifest:** the skill repo owns its own semver track,
  independent of CLI version. `authority.cli` in
  `manifest.json` narrows the compatible CLI range per skill release.
- **`CATALOG_SCHEMA_VERSION === AGENT_BOOTSTRAP_SCHEMA_VERSION`** is
  a hard sentinel — a mismatch fails `doctor`'s `catalog-schema`
  check. Agents SHOULD poll that check each session.
