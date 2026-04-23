# Phase 4 — rule engine design

> Status: **Shipped (v0.2, extended in v2.11.0)**. The engine is
> implemented in `src/rules/engine.ts` and wired to the CLI via
> `switchbot rules lint | list | run | reload | tail | replay`. All
> three triggers (MQTT / cron / webhook) + conditions (see below) +
> per-rule `throttle` + `dry_run` fire end-to-end. v2.11.0 added
> `days` weekday filter on cron triggers and `all`/`any`/`not`
> condition composition. Companion to
> `docs/design/phase4-rules-schema.md`, which specifies the
> `automation.rules[]` shape in `policy.yaml`.

## Goal

Let users express automations declaratively in `policy.yaml`:

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
```

…and have the engine execute them without the user writing a shell
pipeline, without a separate daemon, and without losing the safety
rails (`audit-log`, `--dry-run`, tier gates) the CLI already has.

## Non-goals

- **Cross-device state machines**. If a rule needs "armed → triggered →
  disarmed" transitions, model each transition as a separate rule. If
  that's not enough, use a real automation platform (Home Assistant,
  Node-RED) and let it call the CLI.
- **UI for editing rules**. Rules live in `policy.yaml`. Editors use
  VS Code + the JSON Schema mirror for autocomplete.
- **Templating inside commands**. The v0.2 schema deliberately has no
  `{{ vars }}` syntax in `args`. Attack surface is too big. Revisit
  in v0.3 only if concrete demand appears.

## Architecture

```
                ┌────────────────────────────────────┐
                │ switchbot rules run                │
                │   (one foreground process)         │
                └──────────────┬─────────────────────┘
                               │
  ┌────────────┬───────────────┼─────────────┐
  │            │               │             │
  ▼            ▼               ▼             ▼
MQTT source   Cron scheduler   HTTP listener  Signal handler
(events mqtt-tail)  (node-cron or equivalent) (webhook path)  (SIGHUP = reload)
  │            │               │             │
  └──────────┬─┴───────────────┴─────────────┘
             ▼
    ┌─────────────────────┐
    │   rule matcher      │   — does any rule's `when` match this event?
    └────────┬────────────┘
             ▼
    ┌─────────────────────┐
    │ condition evaluator │   — do all `conditions` pass?
    └────────┬────────────┘
             ▼
    ┌─────────────────────┐
    │ throttle gate       │   — is the rule's throttle window clear?
    └────────┬────────────┘
             ▼
    ┌─────────────────────┐
    │ action executor     │   — render `switchbot <cmd>` per action
    └────────┬────────────┘
             ▼
    audit log (kind=rule-fire) + stderr summary
```

Single foreground process. No daemon, no IPC, no database. State the
engine needs (throttle timers, last-fire times, dedup window) lives in
memory. Restart = state reset — documented behavior.

## Triggers

### `source: mqtt`

The engine opens its own MQTT connection (same broker the CLI uses
today) rather than piping from `events mqtt-tail`. Rationale:

- Shared credential + reconnect logic with the rest of the CLI
- No subprocess management; one less failure mode
- `events mqtt-tail` continues to exist for interactive use; the rule
  engine is a peer consumer, not a downstream consumer

Event match is exact string on the `event` field (`motion.detected`,
`contact.opened`, etc.) and, if `device` is set, the resolved deviceId
or alias must match the event's `deviceId`.

### `source: cron`

Standard 5-field cron, evaluated in the local system timezone. Uses
`node-cron` or equivalent; no DST cleverness (cron inherits the usual
"run twice on fall-back, skipped on spring-forward" behavior — we
don't silently paper over this).

Optional `days` filter (v2.11.0): a list of weekday names
(`mon`–`sun` or `monday`–`sunday`, case-insensitive) applied *after*
the cron fires. Firings on unlisted weekdays are suppressed before
dispatch — throttle counters and audit entries are not written for
suppressed firings.

### `source: webhook`

The engine binds an HTTP listener on localhost (port from CLI config,
default 18790 to avoid conflict with a local agent gateway on 18789).
Authentication is a static bearer token generated at first run and
stored alongside credentials. External callers (IFTTT, HA, whatever)
POST JSON to the configured `path`; the body becomes the trigger
payload available to `conditions`.

## Conditions

Evaluated and AND-joined at the top level; all failures are collected
and surfaced together (not short-circuited on the first). Four shapes:

- **`time_between: [start, end]`** — HH:MM, local system time.
  Overnight crossing supported.
- **`{ device, field, op, value }`** — reads `switchbot devices status
  <device> --json` (cached per-tick; see performance below) and
  applies the comparison. Operators: `==`, `!=`, `<`, `>`, `<=`, `>=`.
- **`all: [condition, ...]`** *(v2.11.0)* — all sub-conditions must
  pass (logical AND over a sub-list).
- **`any: [condition, ...]`** *(v2.11.0)* — at least one sub-condition
  must pass (logical OR).
- **`not: condition`** *(v2.11.0)* — inverts a single condition.

Composites nest arbitrarily. The top-level `conditions[]` array remains
AND-joined across its entries, so `conditions: [A, any: [B, C]]`
means `A AND (B OR C)`.

A future v0.3 might add more leaf shapes (`and`/`or` at the leaf level
were folded into the composite nodes above).

## Actions

Each `then[]` entry renders to:

```
switchbot <command with <id> substituted> <args rendered as --key value> --audit-log
```

Rules:

1. **Safety tier gates still apply.** If the rendered command is
   tier `destructive`, the engine refuses to run it unless
   `confirmations.never_confirm` explicitly allows it — and even
   then, destructive actions in `never_confirm` are blocked by the
   policy validator (see policy-reference.md). Effectively, no
   destructive automations ship in v0.2.
2. **IR "fire and forget"** actions run, but the audit entry records
   `verified: false` because no post-action status check is possible.
3. **`on_error: continue`** (default) runs the remaining `then[]`
   entries after a failure. `on_error: stop` halts the rule after the
   first failing action and records subsequent actions as `skipped`.

## Throttling

Per-rule, keyed by `(rule.name, triggerDeviceId or '')`. When a rule
fires, a timer starts; subsequent matches within `max_per` are
suppressed. Suppressed events are audit-logged with
`kind: rule-throttled` so users can see what got dropped.

## `dry_run: true`

When set, the engine:

1. Evaluates trigger + conditions normally.
2. Renders the action command.
3. Writes `kind: rule-fire-dry` to the audit log with the rendered
   command and the reason it would have fired.
4. Does **not** hit the SwitchBot API.

Used for validating a rule in production without side effects. The
CLI grows a `switchbot rules lint` command that performs a static
check (policy valid + all aliases resolve + no destructive actions),
but dry-run is the live complement.

## Audit replay

```bash
switchbot rules replay --since 24h --json
```

Reads `audit.log`, filters for `kind: rule-fire` and `kind:
rule-throttled`, and emits a summary per rule (fire count, throttle
count, first/last times, success rate). Read-only, no side effects,
fast.

## Hot reload

`SIGHUP` to the running `switchbot rules run` process:

1. Re-reads `policy.yaml` + re-validates.
2. If valid, swaps the rule set atomically.
3. If invalid, prints the error and keeps the old rules live.

No restart required for common edits. `SIGTERM` triggers a graceful
shutdown (drain pending actions, close MQTT, exit 0).

## Performance and resource budget

- Cold start to first fire: < 5s on a 10-rule policy.
- Per-event latency (MQTT arrival → action executed): < 500ms p95.
- Memory ceiling: < 100 MB resident, regardless of event rate.
- CPU: idle < 1%, p95 < 5% during burst.
- Device-state reads (for `{device,field,op,value}` conditions) go
  through the cache with a 5s coalescing window — two rules needing
  the same device's state in the same tick share one API call.

These are targets, not hard gates. A single failing run on a slow
Pi 3 shouldn't block the release — but if the median run fails them,
we've mis-designed.

## Observability

- Every rule fire, throttle, or failure appends a structured line to
  `audit.log`. Schema is the existing audit envelope + a new `rule`
  block with `{name, triggerSource, matchedDevice, fire_id}`.
- `switchbot rules list` — static view of loaded rules + their last
  fire time from audit log.
- `switchbot rules tail` — stream-mode view of firings, like `tail -f`
  but parsed.

No Prometheus, no OpenTelemetry in v0.2. Users who want metrics scrape
audit.log with `jq` or ship it to their existing stack.

## Security considerations

- Webhook listener binds `127.0.0.1` only; no exposed ports without
  explicit CLI config.
- Bearer token for webhook is rotated with `switchbot rules webhook-
  rotate-token`. Stored in keychain (Phase 3 dependency).
- Rule files are user-readable `policy.yaml`; no privilege escalation
  risk.
- No arbitrary shell execution — the `command` field is parsed, not
  `eval`'d. Only `switchbot <subcommand> ...` shapes are allowed.

## Testing strategy

- **Unit**: trigger matchers, condition evaluators, throttle gate,
  action renderer — each in isolation with mocked inputs.
- **Integration**: full engine spun up against a mock MQTT broker and
  mock SwitchBot API. Rule firings asserted by audit-log tail.
- **Fuzz**: random valid rule sets + random event streams → no
  crashes, no memory growth, audit log lines always parse.
- **Dry-run**: for every integration case, also run with
  `dry_run: true` and assert the API mock saw zero mutating calls.

## Open questions

- Where does `switchbot rules run` live on disk? As a subcommand of
  the CLI (simplest, one binary) or a sibling package
  `@switchbot/rules-engine`? Leaning **subcommand** — it shares the
  HTTP client, audit log writer, and cache with the rest of the CLI.
- How do we signal rule-engine health to `switchbot doctor`? Add a
  `rules: ok|fail|disabled` row when Phase 4 ships.
- Should `dry_run: true` still write to the audit log under the same
  retention as real fires, or go to a side file? Current design says
  same file, tagged — simpler, and the user already tails that file.

## Dependencies on other work

- **Phase 3 install flow** — keychain for webhook bearer token, plugin
  surface for exposing `switchbot rules run` as a service.
- **Policy schema v0.2** — specified in `phase4-rules-schema.md`;
  must be validator-active before the engine ships.
- **CLI MQTT client generalization** — currently wired for `events
  mqtt-tail`. Need a shared connector so the engine and the CLI
  surface can coexist cleanly.
