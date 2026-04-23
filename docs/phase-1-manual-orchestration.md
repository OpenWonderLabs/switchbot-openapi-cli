# Phase 1 is not half-shipped — it is the whole manual-orchestration contract

Before Phase 4 (the rules engine) landed, it was easy to read the
roadmap and conclude Phase 1 was "the part before the good stuff."
This document pushes back on that framing. **Phase 1 is complete on
its own terms.** It is the manual-orchestration experience, sized and
shaped around one specific use case: a human or an L1 agent that
issues one command at a time and watches what happens.

If you never enable `automation:` in your policy, you are a Phase 1
user. That is a supported configuration, not a transitional state.

---

## What Phase 1 delivers end-to-end

Every capability below exists in the shipped CLI today. None of them
depends on Phase 2/3/4 being present or enabled.

### Read the home state

```bash
switchbot devices list --json
switchbot devices status "hallway lamp" --json
switchbot scenes list --json
```

`devices list` hits the SwitchBot Cloud API once and caches the
catalog; `devices status` reads either the API or the locally
updated `status.json` cache populated by `events mqtt-tail`. Either
path returns the same JSON envelope.

### Send a command and verify it

```bash
switchbot devices command "hallway lamp" turnOn --dry-run
switchbot devices command "hallway lamp" turnOn --audit-log
switchbot history show --since 5m --json | jq '.data[-1]'
```

Dry-run prints the exact HTTP body that would have been sent, writes
no audit entry, burns no quota. The real fire appends one JSONL line
to `~/.switchbot/audit.log`. `history show` reads the log back.

### Watch the home in real time

```bash
switchbot events mqtt-tail --json --max 3     # sanity check
switchbot devices watch AA-BB-CC-DD-EE-FF --via-mqtt --json
```

`mqtt-tail` subscribes to the cloud-issued MQTT broker (credentials
fetched automatically, cached to `~/.switchbot/mqtt-credential.json`,
refreshed 10 minutes before expiry). Shadow events stream as JSONL.
`devices watch --via-mqtt` is the same stream filtered to one
deviceId.

### Execute a plan instead of a single command

```bash
cat plan.json
# { "steps": [
#     { "device": "hallway lamp", "command": "turnOn" },
#     { "device": "bedside lamp", "command": "turnOff" }
#   ] }
switchbot plan run plan.json --dry-run
switchbot plan run plan.json --audit-log
```

`plan run` is the **manual equivalent** of a single rule firing —
a batch of commands, confirmed up front, logged the same way. An L1
agent can generate the plan, show it to the user, and run it on
approval.

### Feed an AI agent

```bash
switchbot agent-bootstrap --compact | jq '.identity, .schemaVersion'
switchbot mcp serve                              # stdio
switchbot mcp serve --transport http --port 3100 # Streamable HTTP
switchbot doctor --json | jq '.overall'
```

MCP exposes the same operations as the CLI. `agent-bootstrap`
supplies the one-shot cold-start snapshot. `doctor` reports the
system's health in a machine-readable form.

### Know the history, know the quota

```bash
switchbot history show --since 24h
switchbot history replay --dry-run
switchbot quota status --json
```

Every API call counts against the 10,000-req/day SwitchBot quota.
The CLI tracks that locally and exposes the server's
`X-Ratelimit-Remaining` header in both JSON and table output.

---

## What Phase 1 deliberately does NOT include

These are **not** Phase 1 deficiencies — they are Phase 1's scope.

- **No declarative automations.** If you want "when motion at night,
  turn on the lamp," that is Phase 4. An L1 agent running a Phase 1
  install can fake it with a shell loop, but the supported path is
  Phase 4.
- **No cross-device conditions.** `devices command` does not take a
  `--if-state` flag. `plan run` is linear. The device_state guard is
  a Phase 4 primitive.
- **No hot reload of configuration.** Reloading `policy.yaml` mid-run
  is a Phase 4 feature (SIGHUP / pid-file). In Phase 1, you restart.
- **No bearer-token webhook intake.** Shadow events come in via MQTT
  only. The HTTP webhook trigger is Phase 4.

These boundaries are the contract. Phase 1 does the things in the
first list exceptionally well; it does not try to do things in the
second list at all.

---

## Why this framing matters

A lot of the design pressure on Phase 2/3/4 would push back into
Phase 1 if we thought of Phase 1 as a prototype. It isn't. It is the
**steady-state surface** that every later phase sits on top of. When
Phase 4's rules engine fires a command, it reaches the device through
the Phase 1 command-dispatch path. When Phase 2's policy validator
checks a quiet-hours rule, it uses the same time library Phase 1
`watch` uses. The phase numbering is about when capability arrived,
not about quality tiers.

The corollary: **a PR that improves Phase 1 is not second-class
work.** The manual-orchestration experience is the single longest
code path in the repo, has the most tests (1624 at v2.8.0), and is
what an L1 agent actually runs. If a user reports a bug against
`devices watch` or `agent-bootstrap`, it is a first-class issue even
if Phase 4 is available.

---

## How to think about Phase 1 in a roadmap review

Ask: *"Can an L1 agent complete a full day's worth of user requests
against Phase 1 alone, without writing a single rule?"*

The answer today is yes. That is what "Phase 1 is complete" means.
