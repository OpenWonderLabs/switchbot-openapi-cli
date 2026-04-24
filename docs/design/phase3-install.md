# Phase 3 — one-command install design

> Status: **in-CLI shipped (3B-lite) in v2.10.0**. Phase 3A landed
> in v2.8.x: `src/credentials/keychain.ts` abstraction with four
> backends, the `switchbot auth keychain` subcommand group, doctor +
> agent-bootstrap integration, and an in-repo `src/install/` library
> (preflight + rollback-aware step runner). v2.10.0 wraps that
> library as the built-in `switchbot install` / `switchbot uninstall`
> commands — the 7-step Quickstart collapses to a single command
> with rollback on failure. The external `openclaw plugins install`
> wrapper and the ClawHub registry entry remain Phase 3B proper and
> live outside this repo.

## Implementation delta (what changed from this design)

This document was written before `switchbot install` shipped. The body
below describes the original design intent (`openclaw plugins install`
surface). What actually landed in v2.10.0 differs in three ways:

| Design doc says | What shipped |
|---|---|
| Entry point: `openclaw plugins install clawhub:switchbot` | Built-in: `switchbot install` (no ClawHub dependency) |
| Step 2: `npm i -g @switchbot/openapi-cli` | Skipped — CLI already in PATH is the precondition |
| Step 8: `switchbot doctor` failure → full rollback | `--verify` flag makes doctor a warn-only post-step; failure never triggers rollback |
| Uninstall: `openclaw plugins uninstall` | Built-in: `switchbot uninstall [--purge]` |

Additional flags not in this design: `--force` (replace existing
symlink), `--verify` (opt-in post-install doctor check), `--purge`
(shorthand for `--yes --remove-creds --remove-policy`).

## Goal

Today, getting an AI agent to drive SwitchBot is a 15-minute manual
flow: install npm package, set token, create policy, install skill,
restart agent. Phase 3 collapses that to:

```bash
openclaw plugins install clawhub:switchbot
```

On success, every check passes: `switchbot doctor` → all green, the
skill is discoverable from the user's agent of choice, and credentials
live in the OS keychain (not a `0600` JSON on disk).

## Non-goals

- Phase 3 does **not** ship the rule engine (that's Phase 4).
- Phase 3 does **not** rewrite the CLI. Everything it installs is the
  same CLI users install with `npm i -g` today; the plugin just
  automates the bootstrap.
- Phase 3 does **not** manage multiple SwitchBot accounts at install
  time — first account only. A second account is a follow-up install
  with `--profile <name>`.

## High-level flow

```
plugins install switchbot
  │
  ▼
1. Pre-flight checks      (Node >= 18, npm on PATH, agent installed, conflict scan)
  │                          → abort with actionable error if any fails
  ▼
2. CLI install             (`npm i -g @switchbot/openapi-cli`)
  │                          → rollback step: `npm rm -g @switchbot/openapi-cli`
  ▼
3. Credential capture      (interactive prompt; tokens read into memory only)
  │                          → rollback step: delete keychain entry
  ▼
4. Keychain write          (via Keychain abstraction — see below)
  │                          → rollback step: delete the entry
  ▼
5. Bridge CLI → keychain   (CLI reads via `keytar`/native bindings; no
  │                         disk fallback if keychain available)
  ▼
6. Skill install           (symlink skill repo into agent's skills dir)
  │                          → rollback step: remove the symlink
  ▼
7. Policy scaffold         (`switchbot policy new` if file absent)
  │                          → rollback step: remove the file only if WE created it
  ▼
8. Doctor verification     (`switchbot doctor --json` — must report 0 fail)
  │                          → on fail, run full rollback chain
  ▼
9. Summary + next steps    (print the three things the user can say to
                            their agent to confirm it works)
```

Every step records an **undo action**. If any step after step 2 fails,
the installer walks the undo stack in reverse. Failure of an undo
step itself is logged loudly but does not halt the rollback — better
to leave a partial mess than a partial state the user can't reason
about.

## Keychain abstraction

Credentials today live in `~/.switchbot/config.json` with `0600`
permissions. That's fine for developers but leaves tokens on disk,
readable by any process running as the user. Phase 3 moves them to
the native keychain.

Interface (in pseudo-TypeScript; lives in `src/credentials/keychain.ts`
when implemented — not in this repo yet):

```typescript
interface CredentialStore {
  name: 'keychain' | 'credman' | 'secret-service' | 'file';

  get(profile: string): Promise<{ token: string; secret: string } | null>;
  set(profile: string, creds: { token: string; secret: string }): Promise<void>;
  delete(profile: string): Promise<void>;

  // Diagnostics — used by `switchbot doctor` to report which backend
  // the current install is using without leaking the material.
  describe(): { backend: string; writable: boolean; notes?: string };
}
```

Backend selection at runtime:

| OS | First choice | Fallback chain |
|---|---|---|
| macOS | `Keychain` via `security(1)` or `keytar` native | `file` (same 0600 json today) |
| Windows | `Credential Manager` via `CredRead/CredWrite` | `file` |
| Linux | `libsecret` via D-Bus | `file`, with a `doctor` warning |

The fallback exists because Linux desktops without a running
keyring daemon (SSH sessions, headless) would otherwise fail the
install. The `file` backend keeps today's `0600` behavior. `doctor`
surfaces which backend is active so users aren't surprised.

Key naming convention (service = `com.switchbot.skill`; account =
`<profile>:token` and `<profile>:secret`). Two entries per profile,
not one, so `security(1)` scripting doesn't require JSON parsing.

## Pre-flight checks (step 1)

Every check produces either `ok`, `warn` (continue), or `fail` (abort).
Failures must print:

- what failed
- how to fix it manually
- what state the system is in (nothing changed yet)

Checks:

| Check | Pass | Fail action |
|---|---|---|
| `node --version` >= 18 | Continue | Abort, print Node install URL |
| `npm` on PATH | Continue | Abort, print PATH fix hint |
| No existing `switchbot` binary at a different version | Continue | Warn if <2.8.0, offer `--upgrade` |
| No `~/.config/switchbot/policy.yaml` OR the existing one validates | Continue | Warn; skip policy scaffold step |
| Target agent installed (Claude Code / Cursor / Copilot / ...) | Continue | Warn; install anyway, skip step 6 |
| Network to `npmjs.org` + `api.switch-bot.com` | Continue | Abort with diagnostics |

## Credential capture (step 3)

Interactive only. **Tokens MUST NOT** be passed as CLI args (shell
history, process listing). The prompt:

```
Paste your SwitchBot TOKEN  (Profile → App Version x10 → Developer Options):
Paste your SwitchBot SECRET:
```

Input is captured with echo disabled on platforms that support it. On
a TTY-less install (CI-driven?), fail fast with exit code 3 and a hint
pointing at the `plugins install --token-file <path>` escape
hatch (which reads a two-line file and deletes it on success).

## Skill install (step 6)

The installer handles Claude Code natively (`~/.claude/skills/` symlink)
and delegates others to the recipes under
`companion-skill/docs/agents/*.md` — printing the relevant
one-liner rather than automating it. Rationale: Cursor / Copilot /
Gemini / Codex all have different edge cases around where
instructions files live, and automating all of them exceeds the
install-time budget. Printing the recipe gets the user 90% of the way
with zero surprise.

If the user passed `--agent claude-code`, the automation path runs and
records an undo. Otherwise the step is informational.

## Uninstall

Parity with install:

```bash
openclaw plugins uninstall
```

Walks the exact reverse of the install flow. Prompts before each
destructive step (delete keychain entry, remove policy, uninstall CLI)
and defaults the dangerous ones to "no":

```
Remove SwitchBot credentials from keychain? [y/N]
Remove policy.yaml at ~/.config/switchbot/policy.yaml? [y/N]
Uninstall @switchbot/openapi-cli globally? [y/N]
Remove skill link ~/.claude/skills/switchbot? [Y/n]
```

The symlink-removal default flips to yes because it's cheap to
recreate and is almost never what the user wants to preserve.

## Testing strategy

- **Unit**: keychain backends each get a pure-TS test matrix using a
  mock native binding. Real keychain writes only run on CI labeled
  `integration-keychain`.
- **Integration (per OS)**: one VM per target OS in CI runs the full
  install → verify → uninstall cycle against a mock SwitchBot API.
- **Rollback**: every undo step gets a failure-injection test
  (`force: ['step-3']` → install step 3 throws, installer must leave
  steps 1+2 intact and step 4+ un-run).
- **Doctor parity**: a pre-install `doctor --json` vs post-uninstall
  `doctor --json` must differ by exactly the install footprint, no
  stray state left behind.

## Open questions

- Installer language: Node (matches CLI), Go (single binary, easier
  distribution), or shell (zero deps, painful Windows story). Leaning
  **Node** — reuses the CLI's HTTP client, npm install step becomes
  trivial, and we can distribute as another npm package.
- `@switchbot/plugin-skill` vs `registry:switchbot` naming. Defer
  until the external registry is live.
- How does the installer know which skill commit to link? Pin to the
  version in the plugin's own `package.json` (dep on
  `companion-skill@^0.2`)? Git-clone main? Deferred — the
  choice affects reproducibility and update UX.

## Dependencies on other Phase 3 tracks

- The external plugin-manager install command (generic framework)
- An external registry entry for `switchbot`
- Node bindings for each keychain backend (evaluate `keytar`,
  `@napi-rs/keyring`, or a new wrapper — `keytar` is unmaintained)

None of these are in scope for this document; it only covers what the
SwitchBot side of the install needs to look like.
