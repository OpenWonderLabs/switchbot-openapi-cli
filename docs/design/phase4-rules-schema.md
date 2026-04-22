# Policy schema v0.2 — design notes

> Status: **active (v0.2)**. The schema lives at
> `src/policy/schema/v0.2.json` and is wired into
> `switchbot policy validate`. New policies default to v0.1; run
> `switchbot policy migrate` to upgrade opt-in. This document is kept as
> the historical rationale for the shape.

## Why draft now

The Phase 4 rule engine needs a home in `policy.yaml`. v0.1 already
reserves an `automation` block with `enabled` and a loose `rules` array
of objects, but the item shape was left unspecified — anyone wiring up
a rule engine today would either have to invent a shape and hope it
aligns, or hard-code rules outside `policy.yaml`. Pinning the shape
early lets:

- Phase 4 ship by migrating v0.1 → v0.2 via `switchbot policy migrate`
  without introducing a competing file.
- Doc work on the rule DSL proceed against a concrete schema.
- Policy consumers (skills, tooling) rely on the shape the validator
  will eventually enforce.

## What changes from v0.1

- `version` constant flips to `"0.2"`.
- `automation.rules[]` gains a real item schema (`$defs/rule`) that
  requires `name`, `when`, and `then`.
- `automation.rules` becomes nullable (parity with other top-level
  blocks).
- Every other v0.1 block is **unchanged** and retains its existing
  null-allowance and field types. The migration is additive.

## Rule shape (summary)

```yaml
automation:
  enabled: true
  rules:
    - name: "hallway motion at night"
      when:
        source: mqtt
        event: motion.detected
        device: "hallway sensor"
      conditions:
        - time_between: ["22:00", "07:00"]
      then:
        - command: "devices command <id> turnOn"
          device: "hallway lamp"
      throttle:
        max_per: "10m"
      dry_run: false
```

Fields:

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Unique label; used in audit log and dry-run output |
| `enabled` | no (default `true`) | Disable a single rule without deleting it |
| `when` | yes | Trigger; one of three shapes (mqtt / cron / webhook) |
| `conditions` | no | AND-joined predicates; `time_between` or device-state compare |
| `then` | yes (`minItems: 1`) | Ordered list of actions |
| `throttle.max_per` | no | Min spacing between fires, e.g. `"10m"` |
| `dry_run` | no (default `false`) | Write audit entries but skip the API |

### `when` (trigger) — `oneOf`

1. **mqtt**: `{ source: mqtt, event: <type>, device?: <alias|id> }`
   — consumed from the `switchbot events mqtt-tail --json` stream.
2. **cron**: `{ source: cron, schedule: <5-field expression> }` — local
   system timezone.
3. **webhook**: `{ source: webhook, path: /foo }` — local HTTP path.
   Transport/auth are Phase 3 concerns.

### `conditions[]` — `oneOf`

1. **time_between**: `[start, end]` (HH:MM). Overnight allowed (end <
   start).
2. **device_state**: `{ device, field, op, value }` for comparing a
   status field (e.g. `online == true`, `brightness > 50`).

More shapes (cron within conditions, group membership, etc.) can be
added later without breaking v0.2.

### `then[]` — actions

```json
{ "command": "devices command <id> turnOn", "device": "hallway lamp", "args": {...}, "on_error": "continue" }
```

The engine renders `switchbot <command>` with `<id>` substituted from
the resolved `device`, appends `--audit-log`, and expands `args` to
`--key value` flags. Safety tiers still gate: destructive actions in
`then[]` are rejected at policy validation time, not at run time.

## What is deliberately out of scope for v0.2

- **Cross-rule composition** (one rule triggering another). Rules are
  flat; if chaining is needed, model it as a cron or webhook trigger.
- **State machines / debounce** beyond `throttle`. If a sensor bounces,
  `throttle` covers the common case; more sophisticated behavior stays
  outside the schema.
- **Templating** (Jinja-like syntax in `args`). Opens attack surface;
  revisit in v0.3 if real users demand it.
- **Profile-scoped rules**. Today all profiles share one policy file;
  profile-aware policy paths are a separate enhancement tracked in
  `docs/policy-reference.md`.

## Migration plan (v0.1 → v0.2)

`switchbot policy migrate` will:

1. Read the current file + `version` field.
2. If `version == "0.1"`: rewrite `version: "0.2"` and no-op every
   other block (all v0.1 shapes are strict subsets of v0.2).
3. If `automation.rules` exists but isn't empty, validate each rule
   against the v0.2 rule schema **before** rewriting. If any rule
   fails, abort the migration and print the line-accurate error.
4. If `version == "0.2"`: exit 0 with `status: already-current`.
5. If `version > "0.2"`: exit 6 with `unsupported-version` (the CLI
   refuses to downgrade).

Because v0.2 is purely additive, a v0.1 file with `automation.rules:
[]` or `automation: { enabled: false }` migrates without any user-
visible change except the version constant.

## Validator wiring (when Phase 4 ships)

1. Rename `v0.2.draft.json` → `v0.2.json` in `src/policy/schema/`.
2. Mirror to `examples/policy.schema.json` in the skill repo (CI
   already diffs these).
3. Update `src/policy/validate.ts` to dispatch on `version` and pick
   the right schema (`0.1` or `0.2`).
4. Add a v0.2-specific test matrix under `tests/policy/validate-v0.2.test.ts`.
5. Bump CLI minor: `2.x.y → 2.(x+1).0`. Policy schema versions track
   independently of CLI semver but major CLI releases are a natural
   time to drop old schema support.

## References

- `src/policy/schema/v0.1.json` — the current active schema
- `src/policy/schema/v0.2.draft.json` — this draft
- `docs/design/phase4-rules.md` — the runtime behavior side (not yet
  written)
- `docs/policy-reference.md` — user-facing v0.1 field reference
