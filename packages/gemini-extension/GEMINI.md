# SwitchBot skill for Gemini CLI

Drive the user's SwitchBot smart home through the `switchbot` CLI and MCP tools. Always query for ground truth — never guess commands, deviceIds, or parameter values.

---

## Authority chain

| Question | Authoritative source |
|---|---|
| What can I do (cold start)? | `account_overview` MCP tool |
| What commands exist? | `switchbot capabilities --json` |
| What flags does this command take? | `switchbot <cmd> --help --json` |
| What devices does the user have? | `list_devices` MCP tool |
| What's this device doing right now? | `get_device_status` MCP tool |
| What can I do with this specific device type? | `describe_device` MCP tool |
| What scenes are configured? | `list_scenes` MCP tool |
| What's in the user's policy? | `switchbot policy validate --live --json` |
| Is my quota OK? | `switchbot quota status --json` |
| Is the setup healthy? | `switchbot doctor --json` |
| What automation rules are configured? | `switchbot rules list --json` |
| Draft an execution plan from intent | `switchbot plan suggest --intent "..." --device <id>` |
| Run a plan with per-step approval | `switchbot plan run <file> --require-approval` |
| Draft an automation rule from intent | `switchbot rules suggest --intent "..." --device <id>` |
| Inject a rule into policy.yaml | `switchbot policy add-rule [--dry-run] [--enable]` (reads YAML from stdin) |

---

## Bootstrap (cold start)

Call the `account_overview` MCP tool on first query:

```
account_overview → devices[], scenes[], quota, mqttConnected
```

If devices look stale (user just added one), call `list_devices` MCP tool to refresh.

CLI fallback when MCP tools are unavailable:

```bash
switchbot agent-bootstrap --compact --json
```

Then validate the user's policy:

```bash
switchbot policy validate --live --json
```

If no policy file exists, proceed with default safety tiers and tell the user they can create one with `switchbot policy new`.

On first use (or if the user reports trouble), verify integration health:

```bash
switchbot gemini doctor --json
```

Report any failing checks to the user with remediation steps.

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

## Output modes

Always use `--json` when parsing output. Use `--format=markdown` for user-facing summaries. Never parse markdown or human tables programmatically — re-run with `--json`.

---

## Credentials

Credentials come from one of two sources (checked in order):
1. `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` environment variables — set via Gemini CLI's extension settings at install time (stored in system keychain by Gemini CLI).
2. OS keychain — populated by `switchbot auth login` (browser OAuth flow).

Never ask the user for their token or secret directly. If credentials are missing, instruct them to run `switchbot auth login` or re-install the extension and complete the settings prompt.

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

Never retry `destructive` actions automatically.

---

## Things to never do

- Ask the user for their SwitchBot token or secret.
- Suggest flags that bypass safety tiers (`--skip-confirmation`, `--force`) unless the user named them explicitly.
- Claim IR actions "succeeded" — IR is open-loop; say the signal was sent.
- Write to `policy.yaml` without showing a diff and getting explicit approval.
- Generate a rule with a destructive command in `then[]`.
- Arm a rule (`dry_run: false`) on first author without the user confirming firings.
- Set `automation.enabled: true` without explicitly informing the user.

---

## Version

Targets `@switchbot/openapi-cli` ≥ 3.7.1. If `switchbot --version` is older: `npm update -g @switchbot/openapi-cli`.
