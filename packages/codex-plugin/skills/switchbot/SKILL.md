---
name: switchbot
description: Use when the user mentions SwitchBot devices, smart-home automation, or asks about controlling lights, locks, curtains, sensors, plugs, or IR appliances (TV/AC/fan). Teaches the agent how to drive the authoritative `switchbot` CLI safely, read user preferences from `policy.yaml`, and respect safety tiers.
---

# SwitchBot skill

You are helping the user control their SwitchBot smart home through the
`switchbot` CLI. This skill tells you **how** to do that safely. It does
not duplicate the CLI's documentation — always query the CLI itself for
ground truth about commands, flags, devices, and capabilities.

---

## Authority chain

The `switchbot` CLI is the single source of truth. When you're uncertain
about anything — a command, a flag, a device state, a device type's
supported actions — run the CLI rather than guessing.

| Question | Authoritative command |
|---|---|
| What can I do (cold start)? | `switchbot agent-bootstrap --compact --json` |
| What commands exist? | `switchbot capabilities --json` |
| What flags does this command take? | `switchbot <cmd> --help --json` |
| What devices does the user have? | `switchbot devices list --json` |
| What's this device doing right now? | `switchbot devices status <id> --json` |
| What can I do with this specific device type? | `switchbot devices describe <id> --json` |
| What scenes are configured? | `switchbot scenes list --json` |
| What's in the user's `policy.yaml`? | `cat ~/.config/openclaw/switchbot/policy.yaml` (or the Windows equivalent) |
| Is my quota OK? | `switchbot --json quota status` |
| Is the setup healthy? | `switchbot doctor --json` |
| What automation rules does the user have? | `switchbot rules list --json` |
| Are the rules valid? | `switchbot rules lint` |
| Is the rules engine running? | `switchbot rules tail --follow` (or `rules list --json` for static state) |
| What past events match a rule? | `switchbot rules replay --since <duration> --dry-run` |
| Where do credentials live? | `switchbot auth keychain describe --json` |
| Move credentials into the OS keychain | `switchbot auth keychain migrate` (the user runs this; you don't) |
| Sign in for the first time (browser) | `switchbot auth login` (the user runs this; you don't) |
| Clear local cache / quota / history | `switchbot reset [--all]` (safe — does not delete credentials) |
| Draft an execution plan from intent | `switchbot plan suggest --intent "..." --device <id> [--device <id>…]` |
| Run a plan with per-step approval | `switchbot plan run <file> --require-approval` |
| Draft an automation rule from intent | `switchbot rules suggest --intent "..." [--trigger mqtt|cron|webhook] [--device <id>…]` |
| Inject a rule into policy.yaml | `switchbot policy add-rule [--dry-run] [--enable]` (reads rule YAML from stdin) |
| Why did a rule fire or get blocked? | `switchbot rules trace-explain --rule <name> --last` (or `--fire-id <id>`) |
| Pre-validate rule effect against history | `switchbot rules simulate <rule.yaml> --since 7d` |

Never invent a deviceId, a command name, or a parameter value. If the
CLI doesn't know about it, refuse and explain — don't paper over it.

---

## Required bootstrap (run this first, every session)

Before you take any action, establish context:

```bash
switchbot agent-bootstrap --compact
```

(The output is always JSON; `--json` is redundant here.)

The response is `{ "schemaVersion": "1.1", "data": { ... } }`, and
`data` carries everything you need to orient yourself without burning
quota:

- `cliVersion` — confirm it matches the skill's `authority.cli` range
- `identity` — product, vendor, API version, documentation URL
- `quickReference` — which commands to reach for in common tasks
- `safetyTiers` — the 5-tier enum (see Safety gates below)
- `nameStrategies` — how to resolve a user's spoken name ("bedroom light")
  to a deviceId (ordered list: `["exact", "prefix", "substring", "fuzzy", "first", "require-unique"]`)
- `profile` — which CLI profile is active
- `quota` — today's usage + remaining budget
- `devices[]` — cached devices with `deviceId`, `type`, `name`, `category`, `roomName`
- `catalog` — summary of device types present in the account, with
  safety tiers and supported commands
- `hints[]` — advisory messages the CLI wants the agent to see (possibly empty array; never null)

If `devices[]` looks stale (e.g. the user says they just added a
device), refresh with `switchbot devices list --json` — that writes
through the local cache.

Then read the user's policy:

```bash
cat ~/.config/openclaw/switchbot/policy.yaml 2>/dev/null || \
cat "$HOME/.config/openclaw/switchbot/policy.yaml" 2>/dev/null || \
cat "$USERPROFILE/.config/openclaw/switchbot/policy.yaml" 2>/dev/null
```

If the file doesn't exist, proceed with defaults from the safety section
below — but tell the user once that they don't have a policy yet and
point them at `switchbot policy new` (requires CLI ≥ 3.7.1).

If the user asks whether their policy file is correct, run:

```bash
switchbot policy validate
```

Exit 0 means the file is valid; any other code means the CLI printed
line-accurate errors — relay those errors to the user rather than
trying to read the YAML yourself.

---

## Resolving a name to a device

When the user says "turn on the bedroom light", resolve the name in this
order (this is what `agent-bootstrap` means by `nameStrategies`):

1. **alias** — if `policy.yaml` maps `"bedroom light"` → `<deviceId>`, use that. **This is the most reliable path.**
2. **exact** — if a device has `name == "bedroom light"` (case-insensitive), use that.
3. **prefix** — one device whose name starts with the phrase.
4. **substring** — one device whose name contains the phrase.
5. **fuzzy** — Levenshtein distance ≤ 2.
6. **require-unique** — if more than one device matches at the same tier, **stop and ask** which one the user meant. Do not pick.

If the user's phrase resolves to multiple devices at the same tier, list
them (name + room + type) and ask. Do not pick the first one and
proceed — this is a known CLI footgun (the `--name` flag used to match
the first result silently; don't rely on that behaviour).

---

## Safety gates

Every action carries a `safetyTier`, surfaced by
`switchbot capabilities --json` and per-device by
`switchbot devices describe <id> --json`. Honour these tiers:

| Tier | Examples | Behaviour |
|---|---|---|
| `read` | `devices status`, `devices list`, `quota`, `scenes list` | Run freely. |
| `ir-fire-forget` | IR `power`, IR `setAll`, AC/TV/fan via Hub | Run, but tell the user there is no device-side confirmation — you have to trust the IR signal was received. |
| `mutation` | `turnOn`, `turnOff`, `setBrightness`, `setColor` | Run. Append to the audit log (see below). |
| `destructive` | `lock`, `unlock`, deleting scenes/webhooks, anything the user can't trivially undo | **Refuse by default.** Ask the user to confirm explicitly. Even then, run with `--dry-run` first if the CLI supports it for that action. |
| `maintenance` | (reserved — no action uses it today) | Always confirm. |

The user's `policy.yaml` can override this:

- `confirmations.always_confirm: ["lock", "unlock", ...]` — forces
  confirmation even for tiers that would normally auto-run.
- `confirmations.never_confirm: ["turnOn", "turnOff"]` — loosens
  confirmation for non-destructive actions. **Never add a `destructive`
  action to `never_confirm`**, even if the user asks in passing — push
  back and ask them to say so explicitly in the policy file.
- `quiet_hours: { start, end }` — during quiet hours, even `mutation`
  actions need confirmation.

---

## Policy compliance

Before executing any mutation or destructive action, check whether the user
has a policy file:

1. Call `policy_validate` (with `live: true`) at the start of each session
   that will involve device control — not on every single command.
2. If `policy_validate` returns a valid policy, honour these fields:
   - `quiet_hours` — during the window, ask the user for explicit confirmation
     before any mutation, even if the tier would normally auto-run.
   - `confirmations.always_confirm` — treat listed commands as destructive
     (require explicit user confirmation).
   - `confirmations.never_confirm` — treat listed commands as pre-approved
     by the user; skip the confirmation prompt.
3. If no policy file exists (`ENOENT` or `present: false`), proceed with the
   default safety tiers — no additional prompt needed.

Never write to policy.yaml without showing the user a diff and getting
explicit approval first.

---

## Audit logging

When operating through the MCP tools (`send_command`, `run_scene`), the CLI
does not automatically write an audit log entry. To review past activity use
the built-in audit tools:

- `audit_query` — filter audit log entries by time range, device, or result.
- `audit_stats` — summarise counts by command, device, and result.

If the user asks for a full audit trail, advise them to run mutation commands
directly via the CLI with `--audit-log`:

```bash
switchbot --audit-log devices command <id> turnOn
```

---

## Output modes

The CLI supports `--format=json|yaml|tsv|id|markdown`. `--json` is an
alias for `--format=json`. Always use JSON when you're going to parse
the output; use `markdown` when you're summarising for the user as chat
output.

Never parse `markdown` or human tables programmatically — they're not
stable. If you find yourself regex-extracting from a table, stop and
re-run with `--json`.

---

## Streaming events

If the user wants real-time reactions (motion, door contact, button
press), start the MQTT stream:

```bash
switchbot events mqtt-tail --json
```

Every line is one event in the unified envelope:

```json
{"schemaVersion":"1.1","t":"2026-04-22T...","source":"mqtt",
 "deviceId":"...","topic":"...","type":"device.shadow","payload":{...}}
```

The first line is a stream header with `{"stream":true, "eventKind":..., "cadence":...}` — consume it, then iterate.

If the user is running this inside an OpenClaw-aware setup, the CLI has
an `--sink openclaw` mode that POSTs events to a local gateway directly;
check `switchbot events mqtt-tail --help` for current flags rather than
assuming.

---

## Declarative automations (CLI ≥ 3.7.1, policy v0.2)

When the user wants "when X happens, do Y" rather than one-shot commands,
author a rule in the `automation:` block of `policy.yaml` instead of
spawning a shell loop. This repo requires `@switchbot/openapi-cli` 3.7.1+
and runs the rules engine in the same process that reads the policy.

Before you touch `policy.yaml`, check the schema version:

```bash
cat ~/.config/openclaw/switchbot/policy.yaml | head -1   # version: "0.2" ?
switchbot policy validate                                # exit 0 means good
```

If the user is on `version: "0.1"`, they need `switchbot policy migrate`
first — do **not** hand-edit the version line.

### Authoring a rule

Keep the first rule tiny and start with `dry_run: true`. The engine
will log firings to the audit log without touching the device, so the
user can verify before arming:

```yaml
automation:
  enabled: true
  rules:
    - name: "hallway motion at night"
      when: { source: mqtt, event: motion.detected, device: "hallway sensor" }
      conditions:
        - time_between: ["22:00", "07:00"]
      then:
        - { command: "devices command <id> turnOn", device: "hallway lamp" }
      throttle: { max_per: "10m" }
      dry_run: true
```

Show the user the diff before writing. After they approve, validate +
reload:

```bash
switchbot policy validate
switchbot rules lint               # catches cron typos, unknown aliases
switchbot rules reload             # SIGHUP on Unix / pid-file on Windows
switchbot rules tail --follow      # watch fires arrive (dry-run fires too)
```

### Trigger kinds

- `source: mqtt` — reacts to shadow events. `event` is
  `motion.detected`, `contact.open`, etc. (check the device's
  `describe --json` for the exact event names it emits.)
- `source: cron` — `schedule: "0 8 * * *"` style expressions in local
  time. Optional `days: [mon, wed, fri]` list (weekday names `mon`–`sun`
  or full names, case-insensitive) applied *after* the cron fires —
  firings on unlisted days are suppressed without writing throttle or
  audit entries.
- `source: webhook` — bearer-token HTTP ingest on a configurable port.
  The token lives in the OS keychain (`switchbot auth keychain set`),
  **never** in `policy.yaml`.

### Conditions

Top-level `conditions[]` entries are AND-joined. Each entry is one of:

- `time_between: ["22:00", "07:00"]` — local time; midnight-crossing
  is supported.
- `{ device, field, op, value }` — per-tick cached device status
  lookup; e.g. `{ device: "front lock", field: "online", op: "==", value: true }`.
  Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`.
- `all: [condition, ...]` — all sub-conditions must pass (logical AND
  over a sub-list).
- `any: [condition, ...]` — at least one sub-condition must pass (OR).
- `not: condition` — inverts a single condition.

Composites nest arbitrarily via `$ref`. Example: `[A, { any: [B, C] }]`
evaluates as `A AND (B OR C)`.

### Rules the engine will refuse to accept

The validator rejects any rule whose `then.command` would fire a
destructive action (`unlock`, `garage-door open`, `keypad createKey`,
etc.). The rejection is a schema error at `policy validate` time — not
a runtime surprise. If the user asks for "auto-unlock when I arrive
home", push back and explain: destructive actions must be driven by a
human, not a rule.

### When to recommend a rule vs. a shell loop

Recommend a rule when:
- The logic is declarative (one trigger + one-or-two conditions + one
  command).
- The user wants it to survive a reboot (pair with the systemd unit in
  the CLI repo's `examples/quickstart/mqtt-tail.service.example` and
  a similar `switchbot rules run --audit-log` unit).

Recommend a shell loop when:
- The logic needs multi-step branching you'd build with `jq` + `if`.
- The user wants a one-off transient thing that doesn't live in policy.

---

## Credentials in the keychain (CLI ≥ 3.7.1)

**First-time login (recommended path):**
`switchbot auth login` opens a browser window to the SwitchBot login page. After the user signs in, the CLI stores `token` and `secret` directly in the OS keychain and verifies them automatically. The skill never needs to be involved — the user runs this once.

If the browser cannot open (CI, headless, or SSH), pass `--no-open`:
```bash
switchbot auth login --no-open
```
The CLI prints a URL; the user opens it in any browser on any machine.

**Moving existing credentials into the keychain:**
If the user already has credentials in `~/.switchbot/config.json`, point them at `switchbot auth keychain migrate` — it moves token + secret to the OS keychain (macOS `security(1)`, Windows `CredRead`/`CredWrite`, Linux `secret-tool`) and deletes the plain-text file on success.

**Inspecting the active backend:**
```bash
switchbot auth keychain describe --json
```
Relay the `backend` and `writable` fields verbatim — downstream troubleshooting steps depend on knowing which backend is active.

**Resetting local state without touching credentials:**
```bash
switchbot reset          # clears device cache, quota counter, history
switchbot reset --all    # also clears audit log and device metadata
```
`reset` never touches keychain entries. Suggest it when the user reports stale device state or a corrupted cache, **before** suggesting re-login.

The skill does **not** run `auth login`, `auth keychain set`, or `migrate` on the user's behalf — the user always runs credential commands. You may run `auth keychain describe --json` to diagnose which backend is active.

---

## Common pitfalls (from CLI audit)

Read these once and avoid them:

1. **Don't parse help output as text.** Always `--help --json`. The
   text version is for humans and changes between releases.
2. **Don't rely on `name` matching first hit.** Resolve the name
   yourself (see "Resolving a name to a device"), or pass `deviceId`
   directly.
3. **Don't assume a command exists on every device.** Before calling
   `setBrightness`, check `switchbot devices describe <id> --json`
   and confirm `commands[]` includes `setBrightness`. Not every bulb
   supports every command.
4. **Quota counts attempts, not successes.** A burst of failed calls
   still eats the daily 10 000 budget. If `switchbot quota --json`
   shows you're above 80%, slow down and batch.
5. **`--json` envelope — read `.data`, check `.error` first.** Every
   `--json` response is wrapped: `{"schemaVersion":"1.1","data":...}` on
   success, `{"schemaVersion":"1.1","error":{...}}` on failure. This was
   a breaking envelope change — parsers that reach for top-level fields
   (e.g. `obj.devices` instead of `obj.data.devices`) silently get
   `undefined`.
6. **Some fields are deprecated.** Prefer `safetyTier` over
   `destructive:boolean`; prefer `statusQueries` over `statusFields`.
   The old fields still appear in CLI 2.7.x output but are removed in
   v3.0. Bootstrap payload already uses the new names.
7. **Cold-start the cache when the user adds a device.** The cache
   doesn't auto-refresh; when a user says "I just added a new
   sensor", run `switchbot devices list --json` first.
<!-- TODO: revisit when @switchbot/openapi-cli fixes the cache bug (expected in 3.3.1+). Delete this pitfall entirely if upstream fix is verified; keep cross-link to troubleshooting.md if that section is retained. -->
8. **Force `--no-cache` on batch/long-lived reads** *(temporary — remove
   when upstream cache bug is fixed)*. Loops, fan-outs, and reads after
   long idle hit a cache bug returning stale state. Don't substitute by
   lowering `cli.cache_ttl` — that's durable config; `--no-cache` is a
   per-call flag. See `troubleshooting.md` §&nbsp;*Batch or long-lived calls return stale device state*.
9. **Validate deviceId shape yourself before writing rules.** The
   policy schema patterns only the `aliases` map
   (`^[A-Z0-9]{2,}-[A-Z0-9-]+$`); `device:` on triggers, conditions, and
   actions is a plain string. `switchbot policy validate` will accept
   `01-abc` and fail at runtime. Before authoring a rule, if the value
   is not a known alias key from `policy.yaml`, match it against the
   same regex yourself and reject on mismatch.

---

## Things to never do

- Never ask the user for their SwitchBot token or secret. If
  `switchbot config show` fails because credentials are missing, tell
  the user to run `switchbot config set` themselves — they input the
  credentials into the CLI, not into you.
- Never suggest commands that bypass safety tiers
  (`--skip-confirmation`, `--force`, etc.) unless the CLI documents
  them and the user asked for them by name.
- Never claim an IR action "succeeded" in the sense of device
  confirmation — IR is open-loop. Say the signal was sent; if the user
  cares whether the TV actually turned on, they need a sensor loop.
- Never write to `policy.yaml` without showing the user the diff and
  getting an explicit yes.
- Never generate a rule with a destructive command in `then[]` (e.g. `unlock`,
  `deleteScene`, `factoryReset`). The CLI's lint step will reject it, but
  the skill must not attempt it in the first place.
- Never arm a rule (`dry_run: false`) on first author — always start dry,
  confirm firings via `switchbot rules tail --follow`, then transition.
- Never set `automation.enabled: true` without explicitly informing the user.
- Never run `switchbot doctor --fix --yes` without the user asking for
  it. `--fix` mutates state (clears caches, rewrites config); it needs
  intent.

---

## If the CLI returns an error

The envelope looks like:

```json
{
  "schemaVersion": "1.1",
  "error": {
    "kind": "usage" | "auth" | "quota" | "network" | "upstream" | "internal",
    "message": "...",
    "hint": "..."
  }
}
```

- `kind: "usage"` — you (the agent) called something wrong. Re-read the
  help for that subcommand and retry.
- `kind: "auth"` — token is missing/invalid/expired. Tell the user to
  run `switchbot doctor --section credentials`.
- `kind: "quota"` — daily 10 000 calls exceeded. Stop, tell the user
  when it resets (midnight UTC).
- `kind: "network"` — transient. Retry once, then surface the error.
- `kind: "upstream"` — SwitchBot cloud is unhappy. Surface the message
  verbatim; don't paraphrase.
- `kind: "internal"` — CLI bug. Ask the user to run
  `switchbot doctor --json` and file an issue.

Never retry `destructive` actions automatically — that's how you unlock
a door twice.

<!-- TODO: revisit when @switchbot/openapi-cli documents --idempotency-key as reliable. When reliable, replace the fingerprint guidance with a brief note to use the flag. -->
For `mutation` retries, gate with your own idempotency layer — a local
fingerprint (e.g. `{deviceId, command, args, minute-bucket}`) + short
TTL. Do **not** rely on `--idempotency-key` for dedupe *(temporary —
revisit when CLI idempotency is documented as reliable)*; a retry after
a `network` or `internal` error can double-fire without a local gate.

---

## Semi-autonomous workflow — `plan suggest` + `--require-approval` (CLI ≥ 3.7.1)

When the user wants to review each dangerous step rather than confirm
each command interactively, use the Plan workflow:

```bash
# 1. Draft a plan from intent
switchbot plan suggest \
  --intent "turn off all lights" \
  --device <id1> --device <id2>

# 2. Inspect the generated JSON; edit if needed
# 3. Run with per-step approval
switchbot plan run plan.json --require-approval
```

`plan suggest` uses keyword heuristics (on/off/press/lock/open/close/pause)
to pick the right command for each device. If the intent is ambiguous,
it defaults to `turnOn` with a warning on stderr — edit the plan before
running.

`plan run --require-approval` prompts once per destructive step:

```
  Approve step 1 — unlock on <deviceId>? [y/N]
```

Non-destructive steps run without prompting. A rejected step is logged
as `decision: "rejected"` and skipped; the remaining steps continue
(unless `--continue-on-error` is unset, in which case the run halts).

When used via MCP, call the `plan_suggest` tool (safety tier `read`) to
produce the draft plan JSON, then have the user run it interactively
with `--require-approval` in a TTY session.

**Constraints:**

- `--require-approval` is mutually exclusive with `--json`.
- `--yes` overrides `--require-approval` — blanket approval, no prompts.
- In non-TTY environments (CI, pipes), all destructive steps auto-reject.

---

## L3 · Proactive rule authoring (CLI ≥ 3.7.1)

### When to proactively suggest a rule

- User says "every time X happens, do Y" → prefer a rule over a one-shot command.
- User has run the same command manually three or more times → offer to automate it.
- User describes a time-based habit → offer a cron rule.
- **Do NOT** suggest a rule for a one-off action or when the user explicitly asks for a single command.

### Authoring + approval workflow

```bash
# Step 1: Generate rule YAML (no side effects)
switchbot rules suggest \
  --intent "turn on hallway light when motion detected at night" \
  --trigger mqtt \
  --device "hallway sensor" --device "hallway lamp"

# Step 2: Dry-run diff — ALWAYS show this to the user before writing
switchbot rules suggest --intent "..." | switchbot policy add-rule --dry-run

# Step 3: After user approves, inject and reload
switchbot rules suggest --intent "..." | switchbot policy add-rule [--enable]
switchbot rules lint      # must exit 0 before proceeding
switchbot rules reload
```

When using MCP (no shell access), substitute `rules_suggest` and `policy_add_rule` tools:

1. Call `rules_suggest` to get the rule YAML.
2. Call `policy_add_rule` with `dry_run: true` — show the diff to the user.
3. After user approves, call `policy_add_rule` with `dry_run: false`.

When investigating why a rule fired or was blocked, use `rules_explain`:

- `rules_explain` with `rule_name` + `last: true` → most recent evaluation
- `rules_explain` with `fire_id` → specific evaluation by ID
- Returns per-condition ✓/✗ trace, decision, and timing

To pre-validate a new or modified rule against historical events before arming:

- `rules_simulate` with `rule_yaml` + `since: "7d"` → replay last 7 days
- Returns `wouldFire`, `blockedByCondition`, `throttled`, `topBlockReason`
- Always simulate before removing `dry_run: true` from a rule

### Dry-run → arm transition

Rules start as `dry_run: true`; the engine logs firings without touching devices.
After injection, direct the user to run:

```bash
switchbot rules tail --follow
```

Confirm that firings look correct for at least one real event. Only after the
user confirms: edit `dry_run: true` → remove the field (or set to `false`) in
policy.yaml, show diff, wait for approval, reload:

```bash
switchbot rules lint && switchbot rules reload
```

Run `switchbot rules replay --since 24h --json` regularly to surface misfires.

---

## Version pinning

This skill targets `@switchbot/openapi-cli` **≥ 3.7.1** and has been
validated against `3.7.x`.

This repo standardizes on CLI 3.7.1+ for all installation, upgrade, and
support paths. Earlier 3.x versions (3.0.0–3.6.x) silently return the
wrong envelope shape, have a known cache bug on batch/long-lived reads,
and accept malformed policy files — the four pitfalls §5–§9 below all
assume 3.7.1 behavior.

If `switchbot --version` prints an older version, tell the user to run:

```bash
npm update -g @switchbot/openapi-cli
```

The skill already expects the v3 capability schema. If you see examples in the
wild that still rely on old 2.x fields, prefer the current `switchbot
capabilities --json` output over those examples.

This skill declares `autonomyLevel: "L2"` in its `manifest.json`.
L2 means the skill can draft a plan from intent and run it with
per-step approval (`plan suggest` + `plan run --require-approval`).
Rules authored by the skill default to `dry_run: true` until the user
flips them on. L3 (fully autonomous inside policy envelope) remains
out of scope for this skill version.
