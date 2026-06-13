---
name: switchbot
description: Use when the user mentions SwitchBot devices, smart-home automation, or asks about controlling lights, locks, curtains, sensors, plugs, or IR appliances (TV/AC/fan). Teaches the agent how to drive the authoritative `switchbot` CLI safely, read user preferences from `policy.yaml`, and respect safety tiers.
---

# SwitchBot skill

Drive the user's SwitchBot smart home through the `switchbot` CLI. Always query the CLI for ground truth — never guess commands, deviceIds, or parameter values.

---

## Authority chain

| Question | Authoritative command |
|---|---|
| What can I do (cold start)? | `switchbot agent-bootstrap --compact --json` |
| What commands exist? | `switchbot capabilities --json` |
| What flags does this command take? | `switchbot <cmd> --help --json` |
| What devices does the user have? | `switchbot devices list --json` |
| What's this device doing right now? | `switchbot devices status <id> --json` |
| What can I do with this specific device type? | `switchbot devices describe <id> --json` |
| What scenes are configured? | `switchbot scenes list --json` |
| What's on the user's AI MindClip (recordings, todos, daily/weekly summaries)? | `switchbot mindclip recordings/recording/summary/todos/daily/weekly/urgent-todos --json` |
| What's in the user's `policy.yaml`? | `cat ~/.config/openclaw/switchbot/policy.yaml` |
| Is my quota OK? | `switchbot quota status --json` |
| Is the setup healthy? | `switchbot doctor --json` |
| What automation rules are configured? | `switchbot rules list --json` |
| Are the rules valid? | `switchbot rules lint` |
| Draft an execution plan from intent | `switchbot plan suggest --intent "..." --device <id>` |
| Run a plan with per-step approval | `switchbot plan run <file> --require-approval` |
| Draft an automation rule from intent | `switchbot rules suggest --intent "..." --device <id>` |
| Inject a rule into policy.yaml | `switchbot policy add-rule [--dry-run] [--enable]` (reads YAML from stdin) |

---

## Network requirements

`switchbot codex setup` requires outbound internet (npm registry + GitHub). If it fails with a network error, read `references/codex-network.md` for the `~/.codex/config.toml` fix.

---

## Required bootstrap

Before any action, run:

```bash
switchbot agent-bootstrap --compact
```

The response contains: `cliVersion`, `safetyTiers`, `nameStrategies`, `profile`, `quota`, `devices[]` (cached, with `deviceId`/`type`/`name`/`category`/`roomName`), `catalog`, and `hints[]`.

If devices look stale (user just added one), refresh with `switchbot devices list --json`.

Then read the user's policy:

```bash
cat ~/.config/openclaw/switchbot/policy.yaml 2>/dev/null
```

If the file doesn't exist, proceed with default safety tiers and tell the user once they can create one with `switchbot policy new`.

---

## Resolving a name to a device

When the user says "bedroom light", resolve in this order:

1. **alias** — `policy.yaml` alias map → `<deviceId>`. Most reliable.
2. **exact** — device `name == "bedroom light"` (case-insensitive).
3. **prefix** — name starts with the phrase.
4. **substring** — name contains the phrase.
5. **fuzzy** — Levenshtein distance ≤ 2.
6. **require-unique** — multiple matches at same tier → **stop and ask**. Never pick silently.

---

## Safety gates

| Tier | Examples | Behaviour |
|---|---|---|
| `read` | status, list, quota | Run freely. |
| `ir-fire-forget` | IR power/AC/TV via Hub | Run; warn there is no device-side confirmation. |
| `mutation` | turnOn/Off, setBrightness, setColor | Run. Append to audit log. |
| `destructive` | lock, unlock, delete scenes/webhooks | **Refuse by default.** Confirm explicitly; prefer `--dry-run` first. |
| `maintenance` | (reserved) | Always confirm. |

Policy overrides: `confirmations.always_confirm` forces confirmation; `confirmations.never_confirm` pre-approves (never add `destructive` actions). `quiet_hours` requires confirmation even for `mutation`.

---

## Policy compliance

1. Call `policy_validate` (with `live: true`) once per device-control session.
2. Honour `quiet_hours`, `always_confirm`, and `never_confirm` from the validated policy.
3. No policy file → proceed with default tiers.

Never write to `policy.yaml` without showing a diff and getting explicit approval.

---

## Audit logging

Use `audit_query` and `audit_stats` MCP tools to review past activity. For a full audit trail with CLI, use `switchbot --audit-log devices command <id> <cmd>`.

---

## Output modes

Always use `--json` when parsing output. Use `--format=markdown` for user-facing summaries. Never parse markdown or human tables programmatically — re-run with `--json`.

---

## Credentials

First-time login: `switchbot auth login` (opens browser). Headless: add `--no-open`. Inspect the active keychain backend: `switchbot auth keychain describe --json`. Reset cache without touching credentials: `switchbot reset [--all]`. Never run `auth login` or `auth keychain set` on the user's behalf.

---

## Declarative automations (CLI ≥ 3.7.1)

When the user wants "when X, do Y", author a rule in `policy.yaml` instead of a shell loop. Check schema version first (`head -1 policy.yaml`, must be `"0.2"`; if `"0.1"` run `switchbot policy migrate`).

Start with `dry_run: true`:

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

Trigger kinds: `source: mqtt` (shadow events), `source: cron` (schedule + optional `days:`), `source: webhook` (bearer-token HTTP). Conditions: `time_between`, `{device, field, op, value}`, `all:`, `any:`, `not:`.

The validator rejects any rule with a `destructive` action in `then[]`. Always start dry, confirm firings via `switchbot rules tail --follow`, then remove `dry_run`.

```bash
switchbot policy validate
switchbot rules lint && switchbot rules reload
```

---

## Semi-autonomous workflow — `plan suggest` + `--require-approval`

```bash
switchbot plan suggest --intent "turn off all lights" --device <id1> --device <id2>
# Review/edit the generated JSON
switchbot plan run plan.json --require-approval
```

Non-destructive steps run automatically; destructive steps prompt once. Via MCP: call `plan_suggest`, then have the user run `--require-approval` in a TTY session.

---

## Common pitfalls

1. **Don't parse help text.** Always `--help --json`.
2. **Don't rely on `--name` picking one hit.** Resolve the name yourself; pass `deviceId` directly.
3. **Check `commands[]` before calling a command.** `switchbot devices describe <id> --json` — not every device supports every command.
4. **Quota counts attempts, not successes.** Above 80%, slow down and batch.
5. **`--json` envelope** — every response is `{"schemaVersion":"1.1","data":...}` or `{"error":{...}}`. Read `.data`, check `.error` first. Parsers that read top-level fields silently get `undefined`.

---

## Error handling

```json
{ "error": { "kind": "usage|auth|quota|network|upstream|internal", "message": "...", "hint": "..." } }
```

- `usage` → you called something wrong; re-read help and retry.
- `auth` → run `switchbot doctor --section credentials`.
- `quota` → stop; resets at midnight UTC.
- `network` → retry once, then surface.
- `upstream` → relay verbatim.
- `internal` → ask user to run `switchbot doctor --json` and file an issue.

Never retry `destructive` actions automatically. For `mutation` retries, use a local fingerprint `{deviceId, command, args, minute-bucket}` as an idempotency gate.

---

## Things to never do

- Ask the user for their SwitchBot token or secret.
- Suggest flags that bypass safety tiers (`--skip-confirmation`, `--force`) unless the user named them explicitly.
- Claim IR actions "succeeded" — IR is open-loop; say the signal was sent.
- Write to `policy.yaml` without showing a diff and getting explicit approval.
- Generate a rule with a destructive command in `then[]`.
- Arm a rule (`dry_run: false`) on first author without the user confirming firings.
- Set `automation.enabled: true` without explicitly informing the user.
- Run `switchbot doctor --fix --yes` without the user asking.

---

## Version

Targets `@switchbot/openapi-cli` ≥ 3.7.1. If `switchbot --version` is older: `npm update -g @switchbot/openapi-cli`.

<!-- MAINTENANCE: Identical copy at plugins/switchbot/skills/switchbot/SKILL.md — keep both in sync. -->
