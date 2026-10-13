# `policy.yaml` field reference

The `switchbot policy` command group (CLI ≥ 2.8.0) reads and validates a
single YAML file that declares how the `switchbot` CLI and any
connected agent should behave. This document is the field-by-field
spec. If you just want to get started, run `switchbot policy new` and
edit the generated file — every block in it is commented with a
summary.

The JSON Schema that backs this document lives at
`src/policy/schema/v0.2.json` (Draft 2020-12). It is also mirrored to
`examples/policy.schema.json` for editor autocomplete.

---

## File location

| OS | Default path |
| --- | --- |
| Linux / macOS | `~/.config/openclaw/switchbot/policy.yaml` |
| Windows | `%USERPROFILE%\.config\openclaw\switchbot\policy.yaml` |

Override order (first hit wins):

1. The explicit positional policy path (or `policy new --output <path>`)
2. `$SWITCHBOT_POLICY_PATH` environment variable
3. The default path above

`switchbot policy new` writes to the resolved path; `switchbot policy
validate` reads from it; `switchbot policy migrate` reads, upgrades in
memory, and writes back.

---

## Schema version

The top-level `version` field is **required**. This CLI validates only v0.2; v0.1 is a legacy migration prerequisite:

| Version | Status | What it adds |
| --- | --- | --- |
| `"0.1"` | **Removed in v3.0** — migrate with `policy migrate` (CLI ≤2.15) | aliases, confirmations, quiet_hours, audit, cli |
| `"0.2"` | **Current (required)** | typed `automation.rules[]` for the rules engine |

A file with anything other than `"0.2"` fails validation
with a named `unsupported-version` error. v0.2 is the default emitted
by `switchbot policy new`. Existing v0.1 files must be migrated using
CLI ≤2.15 before upgrading to v3.0+:

```bash
# On a temporary legacy CLI <=2.15, before upgrading:
switchbot policy migrate
```

`policy migrate` applies additive changes only (new optional fields,
tighter types on reserved blocks), rewrites the `version` constant, and
refuses to migrate if any user edits would conflict (exit code 7).

```yaml
version: "0.2"  # current default
# version: "0.1"  # legacy — upgrade with `switchbot policy migrate`
```

---

## Top-level blocks

Every block other than `version` is optional. If absent, or explicitly
set to `null` (e.g. a commented-out body), the CLI falls back to safe
defaults.

| Block | Purpose | Default when missing |
| --- | --- | --- |
| `aliases` | Map user-spoken names to deviceIds | No aliases — name resolution falls through to the CLI's match strategies |
| `confirmations` | Override per-action confirmation policy | Default tier behaviour (see [Safety tiers](./audit-log.md)) |
| `quiet_hours` | Require confirmation during a daily window | No quiet hours |
| `audit` | Where to write and how long to keep the audit log | `~/.switchbot/audit.log`, retention `90d` |
| `automation` | Configure the v0.2 rule engine and its triggers, conditions, and actions | `enabled: false` |
| `cli` | CLI-level overrides (profile, cache TTL) | CLI defaults |

---

### `aliases`

Map of friendly names → deviceIds. Recommended for anything an agent
or human will refer to by name, because it removes the ambiguity in
the CLI's match-by-name path.

```yaml
aliases:
  "living room light": "01-202407090924-26354212"
  "bedroom AC":        "02-202502111234-85411230"
  "front door lock":   "03-202501201700-99887766"
```

Rules:

- Keys are free-form strings. Quote them if they contain spaces or
  non-ASCII characters.
- Values must match `^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$` — also accepts
  hex MAC format and hyphenated multi-segment IDs.
  Get IDs from `switchbot devices list --format=tsv`.

---

### `confirmations`

Agent-facing confirmation preferences derived from each action's `safetyTier`.
They do not bypass the native CLI's destructive approval workflow.

```yaml
confirmations:
  always_confirm:
    - "setTargetTemperature"
    - "setThermostatMode"
  never_confirm:
    - "turnOn"
    - "turnOff"
```

| Subkey | Meaning | Constraints |
| --- | --- | --- |
| `always_confirm` | Action names that always require explicit confirmation, even when the tier would auto-run | List of strings, unique |
| `never_confirm` | Action names that normally confirm but the user has pre-approved | List of strings, unique. **MUST NOT include destructive actions** |

The destructive blocklist the schema enforces on `never_confirm`:

- `lock`
- `unlock`
- `deadbolt` (releases the door latch)
- `nightLatchUnlock`
- `createKey`
- `deleteKey`
- `deleteWebhook`
- `deleteScene`
- `factoryReset`

Attempting to pre-approve any of these is a validation error. This
is deliberate — no YAML edit should silently disable the unlock
confirmation gate.

---

### `quiet_hours`

Agent preference for a time window in which mutations should require explicit
confirmation. It is enforced by agents that honor the policy, not a blanket
native CLI/MCP mutation gate; native destructive-command checks still apply.

```yaml
quiet_hours:
  start: "22:00"
  end:   "08:00"
```

- `start` and `end` are `HH:MM` 24-hour local system time.
- `start` and `end` are mutually required (JSON Schema
  `dependentRequired`): set both, or neither.
- Overnight ranges (`start > end`) are allowed and interpreted as
  crossing midnight.

---

### `audit`

Agent-facing audit preferences. The native CLI does not automatically apply `audit.log_path`; pass `--audit-log --audit-log-path <path>` explicitly for a custom log, or `--audit-log` for the default path.

```yaml
audit:
  log_path: "~/.switchbot/audit.log"
  retention: "90d"
```

| Field | Format | Default |
| --- | --- | --- |
| `log_path` | Absolute or `~`-prefixed path | `~/.switchbot/audit.log` |
| `retention` | `never` or `<N>d / <N>w / <N>m` | `90d` |

`retention` is a lexical pattern only — the CLI does not rotate the
file itself today; external log rotation tools (logrotate,
PowerShell scheduled task, etc.) should honour the value.

---

### `automation`

Rule engine block. Available in **v0.2** — set `enabled: true` to activate `switchbot rules run`. This CLI rejects v0.1 policies rather than ignoring their automation block. Migrate with CLI <=2.15 before upgrading.

```yaml
automation:
  enabled: true             # must be true for `rules run` to do anything
  audit:
    evaluate_trace: sampled  # full | sampled | off (default sampled)
    evaluate_retention_days: 7  # min 1 (default 7)
  llm_budget:
    max_calls_per_hour: 60   # global limit across all LLM conditions (default 60)
  rules:
    - name: hallway motion at night   # unique per file; audit label
      enabled: true                   # default true; false silences the rule
      when:                           # trigger — exactly one source
        source: mqtt                  # mqtt | cron | webhook
        event: motion.detected        # classifier output (see below)
        device: hallway motion        # optional alias/deviceId filter
      conditions:                     # optional; AND-joined
        - time_between: ["22:00", "07:00"]   # local-time window, overnight OK
      then:                           # one or more actions, run in order
        - command: "devices command <id> turnOn"
          device: hallway lamp        # alias resolves to deviceId at fire time
          args: null                  # optional map of verb arguments
          on_error: continue          # continue (default) | stop
        - type: notify
          channel: webhook            # webhook | file | openclaw
          to: https://your.host/hook
          template: '{"rule":"{{ rule.name }}","fired":"{{ rule.fired_at }}"}'
          on_failure: log             # log | retry | ignore
      throttle:
        max_per: "10m"                # minimum spacing: \d+[smh]
        dedupe_window: null           # event deduplication window
      cooldown: null                  # shorthand for throttle.max_per
      requires_stable_for: null       # hysteresis guard duration
      maxFiringsPerHour: null         # per-hour rate limit
      suppressIfAlreadyDesired: false # skip if device already in desired state
      dry_run: true                   # default true in v0.2; writes audit but skips the API call
```

`suppressIfAlreadyDesired` checks the target's REST status `power` value,
case-insensitively, before `turnOn` or `turnOff`. An unknown power state or
failed status request keeps the existing best-effort behavior: the action proceeds.

**Trigger sources (v0.2).**

| `source` | Required fields | Status |
| --- | --- | --- |
| `mqtt` | `event` (+ `device?`) | **active** — fires on shadow MQTT |
| `cron` | `schedule` (5-field) | **active** — local time, optional `days` weekday filter |
| `webhook` | `path` | **active** — bearer-token HTTP ingest |

MQTT event names classified today: `motion.detected`,
`motion.cleared`, `contact.opened`, `contact.closed`. Unmatched
payloads classify as `device.shadow` — you can match that catch-all
too.

**Conditions (v0.2).**

| Keyword | Meaning | Status |
| --- | --- | --- |
| `time_between` | `[HH:MM, HH:MM]` local-time window, `start > end` → overnight | active |
| `device_state` | `{ device, field, op, value }` read device status inline | active |
| `event_count` | Count events in a rolling window over device history | active |
| `all` | AND-join multiple sub-conditions | active |
| `any` | OR-join multiple sub-conditions | active |
| `not` | Negate a sub-condition | active |
| `llm` | AI judgement — prompt an LLM before firing (see below) | active |

**`event_count` condition fields:**

```yaml
conditions:
  - event_count:
      device: hallway-motion       # alias or deviceId (required)
      event: motion.detected       # MQTT event name; omit to count all
      window: "5m"                 # rolling window: \d+[smh] (required)
      min: 3                       # fire only if count >= min (required)
      max: 10                      # optional upper bound (count <= max)
```

Reads the selected profile's device-history JSONL: `~/.switchbot/device-history/` for default and `~/.switchbot/profiles/<name>/device-history/` for a named profile. This is the same log `events mqtt-tail` writes. Lints flag a missing history file
(`condition-event-count-no-history` — likely typo) and a `max < min`
inversion (`condition-event-count-max-below-min`). For the LLM-free
path: an "alarm if motion ≥3 times in 5m" guard does not need a model.

**LLM condition fields:**

```yaml
conditions:
  - llm:
      prompt: "Is the temperature above normal comfort range?"
      provider: auto          # auto | openai | anthropic | local
      timeout_ms: 5000        # 500–10000 (default 5000)
      cache_ttl: 5m           # none | \d+[smh] (default 5m)
      recent_events: 5        # 0–20 (default 5) — last N events of the
                              # trigger device included verbatim in prompt
      budget:
        max_calls_per_hour: 10        # per-condition limit (default 10)
        max_tokens_per_hour: 100000   # optional rolling 1h token cap
        max_cost_per_day_usd: 1.00    # optional rolling 24h USD cap
      on_error: fail          # fail | pass | skip (default fail)
```

Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for the cloud providers.
For `provider: local`, point `SWITCHBOT_LOCAL_LLM_URL` at any
OpenAI-compatible `/v1/chat/completions` endpoint (Ollama defaults
to `http://localhost:11434/v1`, llama.cpp / vLLM / LM Studio also
work). Models without tool-use call into a structured-output
fallback (JSON instruction prompt + lenient parser + one repair
retry); set `SWITCHBOT_LOCAL_LLM_TOOL_USE=1` if your local model
does support tool use.

`rules lint` flags misconfigured LLM conditions, including
`condition-llm-tokens-budget-zero` (token cap set to 0 — never
allowed) and `condition-llm-cost-without-known-model` (cost cap on a
model not in the pricing table — won't be enforced).

The audit log records every LLM condition outcome as
`kind: llm-condition` with `usage: { tokensIn, tokensOut, costUsd? }`
and emits `kind: llm-budget-exceeded` with
`dimension: "calls" | "tokens" | "cost"` when a cap fires.

Global LLM budget (applied across all LLM conditions, in addition to
each condition's per-rule budget):

```yaml
automation:
  llm_budget:
    max_calls_per_hour: 60        # default 60
    max_tokens_per_hour: 1000000  # optional
    max_cost_per_day_usd: 10.00   # optional
```

**Destructive commands are refused.** The v0.2 validator rejects `lock`,
`unlock`, `deadbolt`, `nightLatchUnlock`, `createKey`, `deleteKey`,
`deleteWebhook`, `deleteScene`, and `factoryReset` in any `then[].command`.
Inventory-aware validation also rejects device-specific destructive actions,
including Garage Door Opener `turnOn`/`turnOff`; ordinary light power actions remain allowed.
Before a live rule mutation, the executor resolves missing device metadata and
checks the catalog safety tier. Unknown devices/commands fail closed. Dry-run
does not fetch inventory or mutate devices.

**Hot-path behaviour.** Every fire is serialised through a dispatch
queue so two MQTT events arriving in the same tick respect throttle
windows. Rules are executed in the order declared; `on_error: stop`
halts the remaining actions in a single rule's `then[]` but doesn't
affect other rules.

See [`docs/design/phase4-rules.md`](./design/phase4-rules.md) for the
pipeline and [`examples/policies/automation.yaml`](../examples/policies/automation.yaml)
for a working walkthrough.

---

### `cli`

Optional agent-facing CLI preferences; pass the chosen profile/cache flags explicitly.

```yaml
cli:
  profile: "default"
  cache_ttl: "5m"
```

| Field | Format | Default |
| --- | --- | --- |
| `profile` | Non-empty string | `"default"` |
| `cache_ttl` | `<N>s`, `<N>m`, or `<N>h` | CLI default (typically 5 minutes) |

`profile` must match a profile you've configured with
`switchbot config set-token --profile <name>`.

> **Note:** the policy file path is **not** profile-aware today —
> every profile shares the same `~/.config/openclaw/switchbot/policy.yaml`.
> If you need separate policies per profile, point each to its own
> file via the `$SWITCHBOT_POLICY_PATH` environment variable when you
> run the CLI. Tracking profile-scoped paths as a future enhancement.

---

## Validation flow

```bash
switchbot policy validate
```

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | File is valid and matches schema v0.2 |
| 1 | Schema violation (line-accurate error with hint) |
| 2 | File is missing |
| 3 | YAML is malformed (parse error, with line/col) |
| 4 | Internal error |

Every non-zero exit prints a compiler-style block:

```text
policy.yaml:12:14  error  lowercase deviceId
   |
12 |   "bedroom ac": "02-202502111234-abc123"
   |                                 ^^^^^^^^
   = hint: SwitchBot deviceIds are uppercase. Try "ABC123".
```

For machine consumption, pass `--json`. Schema violations exit `1` with
`data.valid: false` and `data.errors[]`; file/parse/internal failures use
the standard `{schemaVersion, error}` envelope. Validation is offline unless
live inventory validation is explicitly requested.

```json
{
  "schemaVersion": "1.2",
  "data": {
    "policyPath": "/home/you/.config/openclaw/switchbot/policy.yaml",
    "schemaVersion": "0.2",
    "validationScope": "schema+offline-semantics",
    "limitations": [
      "Does not resolve aliases against the live device inventory.",
      "Does not verify commands against the real target device, live capabilities, or current firmware."
    ],
    "valid": false,
    "errors": [
      {
        "path": "",
        "line": 2,
        "col": 1,
        "keyword": "additionalProperties",
        "message": "unknown property \"unknown\"",
        "schemaPath": "#/additionalProperties"
      }
    ]
  }
}
```

---

## Common errors

| Error | Trigger | Fix |
| --- | --- | --- |
| `missing version` | Top-level `version` is absent | Add `version: "0.2"` |
| `unsupported version` | `version` is not `"0.2"` | Use a supported policy schema; v0.1 requires a legacy CLI <=2.15 for migration |
| `wrong version` | `version: "0.1"` on this CLI | Migrate with CLI <=2.15, then upgrade back |
| `lowercase deviceId` | `aliases` value doesn't match the accepted patterns | Copy the exact ID from `devices list` |
| `destructive in never_confirm` | `lock`/`unlock`/etc in `confirmations.never_confirm` | Remove it; intentional by design |
| `quiet_hours.start without end` | Only one of the two times is set | Set both, or remove the block |
| `invalid retention` | `audit.retention` isn't `never` / `Nd` / `Nw` / `Nm` | Use one of the documented formats |
| `unknown top-level key` | You misspelled a block (e.g. `alias:` not `aliases:`) | Check the spelling against this reference |

Every error includes the offending line and column, and most include a
machine-readable `rule` field so tooling can suggest fixes.

---

## Migrating between schema versions

v0.2 is the current required schema. This CLI cannot migrate v0.1. Use CLI <=2.15 to migrate the old file first, then return to the current release:

```bash
# Run with the legacy CLI, not the current release:
switchbot policy migrate
```

`policy migrate`:

1. Detects your current `version` field.
2. Applies additive changes only (new optional fields, tighter types on
   reserved blocks).
3. Rewrites the file with the new `version` constant.
4. Refuses to migrate if any user edits conflict, and explains what
   conflicts (exit code 7).

After migrating, run `switchbot policy validate` to confirm the file is
valid before using the rules engine.

---

## See also

- [`examples/policies/`](../examples/policies/) — four annotated
  starter files (minimal / cautious / permissive / rental), each with
  a rationale for when to pick it.
- [`docs/agent-guide.md`](./agent-guide.md) — how an AI agent should
  read and honour `policy.yaml`.
- [`docs/audit-log.md`](./audit-log.md) — the format of the audit log
  `audit.log_path` points at.
- `switchbot policy --help` — command-line help for the three
  subcommands.
- `examples/policy.schema.json` — JSON Schema for editor autocomplete
  (VS Code `yaml.schemas`, JetBrains, etc.).
