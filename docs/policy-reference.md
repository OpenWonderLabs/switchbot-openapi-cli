# `policy.yaml` field reference

The `switchbot policy` command group (CLI ≥ 2.8.0) reads and validates a
single YAML file that declares how the `switchbot` CLI and any
connected agent should behave. This document is the field-by-field
spec. If you just want to get started, run `switchbot policy new` and
edit the generated file — every block in it is commented with a
summary.

The JSON Schema that backs this document lives at
`src/policy/schema/v0.1.json` (Draft 2020-12). It is also mirrored to
`examples/policy.schema.json` for editor autocomplete.

---

## File location

| OS | Default path |
|---|---|
| Linux / macOS | `~/.config/openclaw/switchbot/policy.yaml` |
| Windows | `%USERPROFILE%\.config\openclaw\switchbot\policy.yaml` |

Override order (first hit wins):

1. `--policy <path>` flag on the `policy` subcommands
2. `$SWITCHBOT_POLICY` environment variable
3. The default path above

`switchbot policy new` writes to the resolved path; `switchbot policy
validate` reads from it; `switchbot policy migrate` reads, upgrades in
memory, and writes back.

---

## Schema version

The top-level `version` field is **required** and must be the string
`"0.1"` for this release. Any other value fails validation with a
named error. When policy schema v0.2 ships (Phase 4, rule engine),
`switchbot policy migrate` will rewrite `0.1 → 0.2` in place.

```yaml
version: "0.1"
```

---

## Top-level blocks

Every block other than `version` is optional. If absent, or explicitly
set to `null` (e.g. a commented-out body), the CLI falls back to safe
defaults.

| Block | Purpose | Default when missing |
|---|---|---|
| `aliases` | Map user-spoken names to deviceIds | No aliases — name resolution falls through to the CLI's match strategies |
| `confirmations` | Override per-action confirmation policy | Default tier behaviour (see [Safety tiers](./audit-log.md)) |
| `quiet_hours` | Require confirmation during a daily window | No quiet hours |
| `audit` | Where to write and how long to keep the audit log | `~/.switchbot/audit.log`, retention `90d` |
| `automation` | **Reserved** for the Phase 4 rule engine | `enabled: false` |
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
- Values must match `^[A-Z0-9]{2,}-[A-Z0-9-]+$` — SwitchBot deviceIds
  are uppercase. A lowercase deviceId is the #1 cause of validation
  failures.
- Get IDs from `switchbot devices list --format=tsv`.

---

### `confirmations`

Override the default confirmation policy derived from each action's
`safetyTier`.

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
|---|---|---|
| `always_confirm` | Action names that always require explicit confirmation, even when the tier would auto-run | List of strings, unique |
| `never_confirm` | Action names that normally confirm but the user has pre-approved | List of strings, unique. **MUST NOT include destructive actions** |

The destructive blocklist the schema enforces on `never_confirm`:

- `lock`
- `unlock`
- `deleteWebhook`
- `deleteScene`
- `factoryReset`

Attempting to pre-approve any of these is a validation error. This
is deliberate — no YAML edit should silently disable the unlock
confirmation gate.

---

### `quiet_hours`

Window during which every mutation (not just destructive ones)
requires explicit confirmation.

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

Controls the JSONL audit log the CLI writes when you pass
`--audit-log` to a mutating command.

```yaml
audit:
  log_path: "~/.switchbot/audit.log"
  retention: "90d"
```

| Field | Format | Default |
|---|---|---|
| `log_path` | Absolute or `~`-prefixed path | `~/.switchbot/audit.log` |
| `retention` | `never` or `<N>d / <N>w / <N>m` | `90d` |

`retention` is a lexical pattern only — the CLI does not rotate the
file itself today; external log rotation tools (logrotate,
PowerShell scheduled task, etc.) should honour the value.

---

### `automation`

**Reserved for the Phase 4 rule engine.** Leave `enabled: false` for
now. If you set `enabled: true` before Phase 4 lands, the CLI warns
and ignores the block.

```yaml
automation:
  enabled: false
  # rules: []
```

The `rules` subkey shape is deliberately loose in v0.1
(`array of object`) and will be tightened in v0.2. See
[`docs/design/phase4-rules.md`](./design/phase4-rules.md) if you
want to understand the direction early.

---

### `cli`

Optional CLI-level overrides.

```yaml
cli:
  profile: "default"
  cache_ttl: "5m"
```

| Field | Format | Default |
|---|---|---|
| `profile` | Non-empty string | `"default"` |
| `cache_ttl` | `<N>s`, `<N>m`, or `<N>h` | CLI default (typically 5 minutes) |

`profile` must match a profile you've configured with
`switchbot config set-token --profile <name>`.

---

## Validation flow

```bash
switchbot policy validate
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | File is valid and matches schema v0.1 |
| 1 | File is missing |
| 2 | YAML is malformed (parse error, with line/col) |
| 3 | Schema violation (line-accurate error with hint) |

Every non-zero exit prints a compiler-style block:

```
policy.yaml:12:14  error  lowercase deviceId
   |
12 |   "bedroom ac": "02-202502111234-abc123"
   |                                 ^^^^^^^^
   = hint: SwitchBot deviceIds are uppercase. Try "ABC123".
```

For machine consumption, pass `--json`. The envelope is the standard
`{schemaVersion, data|error}` shape:

```json
{
  "schemaVersion": "1.1",
  "error": {
    "kind": "usage",
    "message": "lowercase deviceId at policy.yaml:12:14",
    "hint": "SwitchBot deviceIds are uppercase.",
    "file": "/home/you/.config/openclaw/switchbot/policy.yaml",
    "line": 12,
    "column": 14,
    "rule": "aliases-deviceId-pattern"
  }
}
```

---

## Common errors

| Error | Trigger | Fix |
|---|---|---|
| `missing version` | Top-level `version` is absent | Add `version: "0.1"` |
| `wrong version` | `version` is anything but `"0.1"` | Run `switchbot policy migrate` |
| `lowercase deviceId` | `aliases` value isn't UPPERCASE | Uppercase the ID (it is in `devices list`) |
| `destructive in never_confirm` | `lock`/`unlock`/etc in `confirmations.never_confirm` | Remove it; intentional by design |
| `quiet_hours.start without end` | Only one of the two times is set | Set both, or remove the block |
| `invalid retention` | `audit.retention` isn't `never` / `Nd` / `Nw` / `Nm` | Use one of the documented formats |
| `unknown top-level key` | You misspelled a block (e.g. `alias:` not `aliases:`) | Check the spelling against this reference |

Every error includes the offending line and column, and most include a
machine-readable `rule` field so tooling can suggest fixes.

---

## Migrating between schema versions

v0.1 is the only published schema today. v0.2 (Phase 4) will add a
structured `rules[]` definition under `automation`. When it ships,
`switchbot policy migrate` will:

1. Detect your current `version` field.
2. Apply additive changes only (new optional fields, tighter types on
   reserved blocks).
3. Rewrite the file with the new `version` constant.
4. Refuse to migrate if any user edits conflict, and explain what
   conflicts.

Until then, `policy migrate` is a no-op that verifies the file is
already current.

---

## See also

- [`docs/agent-guide.md`](./agent-guide.md) — how an AI agent should
  read and honour `policy.yaml`.
- [`docs/audit-log.md`](./audit-log.md) — the format of the audit log
  `audit.log_path` points at.
- `switchbot policy --help` — command-line help for the three
  subcommands.
- `examples/policy.schema.json` — JSON Schema for editor autocomplete
  (VS Code `yaml.schemas`, JetBrains, etc.).
