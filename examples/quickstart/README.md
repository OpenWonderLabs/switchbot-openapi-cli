# Quickstart — the 7 steps from zero to verified automation

A copy-and-paste walkthrough of the full first-day path. Runs entirely
against your own SwitchBot account and leaves a live audit trail. Every
step is observable from a second terminal so you can verify the
previous one before continuing.

| Step | What you do | How to verify |
|------|-------------|---------------|
| 1 | Install the CLI | `switchbot --version` |
| 2 | Save credentials | `switchbot config show` |
| 3 | Cold-start snapshot | `agent-bootstrap --compact \| jq .identity` |
| 4 | Scaffold policy | `switchbot policy validate` |
| 5 | Stream events | first JSON line arrives within seconds |
| 6 | Fire a command | audit log has one new entry |
| 7 | Smoke test | `doctor --json \| jq '.overall'` prints `"ok"` |

---

## 1. Install the CLI

```bash
# Stable release from npm:
npm install -g @switchbot/openapi-cli

# Or from source (if you want the bleeding edge):
git clone https://github.com/OpenWonderLabs/switchbot-openapi-cli.git
cd switchbot-openapi-cli
npm ci && npm run build && npm link
```

Verify:

```bash
switchbot --version
```

## 2. Save credentials

Get token + secret from SwitchBot mobile app → Profile → Preferences →
Developer Options → Get Token. Pick one storage backend:

```bash
# Option A — environment variables (CI friendly, no disk writes):
cp examples/quickstart/config.env.example ~/.switchbot/.env
chmod 0600 ~/.switchbot/.env
$EDITOR ~/.switchbot/.env
set -a; . ~/.switchbot/.env; set +a

# Option B — native OS keychain (macOS / Windows Credential Manager /
# libsecret). Survives reboots, no file on disk.
switchbot auth keychain set

# Option C — 0600 JSON file fallback (default if you do nothing):
switchbot config set-token <token> <secret>
```

Confirm which source is active:

```bash
switchbot config show
switchbot auth keychain describe   # shows the active backend
```

## 3. Cold-start snapshot for an agent

Even if you don't plan to wire an agent yet, this proves the CLI can
read its cache and catalog without spending API quota:

```bash
switchbot agent-bootstrap --compact | jq '.identity, .devices.total, .schemaVersion'
```

## 4. Scaffold a policy file

The policy is the one place you edit to express user preferences: name
aliases, quiet hours, destructive-command confirmations, audit log
location, and (v0.2 only) automation rules.

```bash
mkdir -p ~/.config/openclaw/switchbot
cp examples/quickstart/policy.yaml.example \
   ~/.config/openclaw/switchbot/policy.yaml

# Replace the sample deviceId under `aliases` with a real one:
switchbot devices list --json | jq '.data[] | {id: .deviceId, name: .deviceName}'
$EDITOR ~/.config/openclaw/switchbot/policy.yaml

switchbot policy validate
```

If you don't need the rules engine yet, edit `version:` back to `"0.1"`
and drop the `automation:` block — the rest of the file stays valid for
both schemas.

## 5. Stream real-time events

Open a second terminal and watch the shadow-event stream. First run
with `--max` to sanity-check, then move to the background when you
trust the flow.

```bash
# Sanity check — exits after 3 events or Ctrl-C.
switchbot events mqtt-tail --json --max 3

# Long-running: run `rules run` or mqtt-tail as a systemd unit. See
# examples/quickstart/mqtt-tail.service.example for a reference unit
# file (systemd / Linux) or Task Scheduler (Windows).
```

## 6. Fire a command, with audit

Use an aliased device name from your policy so the agent path works
identically later. `--audit-log` appends one JSONL entry to
`~/.switchbot/audit.log`.

```bash
# Dry-run first (prints what would hit the API, writes no audit entry):
switchbot devices command "hallway lamp" turnOn --dry-run

# Real fire, recorded in the audit log:
switchbot devices command "hallway lamp" turnOn --audit-log

# Verify the audit entry landed:
switchbot history show --since 5m --json | jq '.data[-1]'
```

## 7. Smoke test — everything healthy

`doctor` runs every check the CLI knows how to run and prints the ones
that aren't green. Empty array means you're done.

```bash
switchbot doctor --json | jq '.checks[] | select(.status != "ok")'

# Specifically confirm the catalog ↔ agent-bootstrap schema sync check
# an agent should poll each session:
switchbot doctor --json | jq '.checks[] | select(.name == "catalog-schema")'
```

---

## Optional: rules engine (v0.2)

Once steps 1–7 pass, you can enable an automation using the rule in
`policy.yaml.example` (currently `dry_run: true`):

```bash
# Static checks before you commit to running the engine:
switchbot rules lint
switchbot rules list --json | jq '.data.rules[] | {name, trigger, dry_run}'

# Run the engine in dry-run mode for 5 firings, then stop:
switchbot rules run --dry-run --max-firings 5

# From another shell, tail only rule-* audit lines to see fires arrive:
switchbot rules tail --follow
```

When you're ready, remove `dry_run: true` from the rule and restart
with `rules reload` — no process restart needed (SIGHUP on Unix,
sentinel file on Windows).
