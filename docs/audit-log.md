# Audit Log Format

Pass `--audit-log` to record device commands. A device command with a
`planId` uses the default log even without the flag. Direct scene execution
does not write a command record.

- **Default path:** `~/.switchbot/audit.log`
- **Override:** `--audit-log-path <file>`
- **One record per line**, UTF-8, LF newline between lines (`"\n"`), appended.
- **Best-effort:** write failures are swallowed — a command never aborts because
  the audit log cannot be written.

## Schema

New records share `auditVersion`, `t`, and `kind`. The remaining fields below
describe command records; other kinds have different payloads. For example,
`rule-evaluate` has `rule`, `trigger`, `fireId`, `conditions`, `decision` and
`evaluationMs` instead of command fields.

| Field | Type | Notes |
| --- | --- | --- |
| `auditVersion` | number | Schema version. Current: `2`. Missing on records written before audit versioning. |
| `t` | string (ISO-8601) | Timestamp when the record was written. |
| `kind` | string | Record discriminator. Values: `command`, `rule-fire`, `rule-fire-dry`, `rule-throttled`, `rule-webhook-rejected`, `rule-notify`, `rule-evaluate`, `llm-suggest`, `llm-condition`, `llm-budget-exceeded`. |
| `deviceId` | string | Target device ID. |
| `command` | string | SwitchBot command name (e.g. `turnOn`, `setColor`). |
| `parameter` | JSON value | Device command parameter (for example, a string, number or object). Rule-fire records retain parsed command text, including JSON whitespace; RGB values use `r:g:b`. |
| `commandType` | `"command" \| "customize"` | Matches the upstream SwitchBot API field. |
| `dryRun` | boolean | `true` when the command was intercepted by `--dry-run` and never reached the network. |
| `result` | `"ok"` \| `"error"` \| `"dry-run"` | Optional. An intercepted device command records `"dry-run"`; a successful `rule-fire-dry` records `"ok"`. |
| `error` | string | Optional — populated when `result === "error"`. |

`llm-condition` is a declared kind. Do not expect a separate record for
each LLM call: the evaluator puts condition details in `rule-evaluate`
traces and writes `llm-budget-exceeded` on budget rejection.

### Example

```json
{"auditVersion":2,"t":"2026-04-20T01:23:45.123Z","kind":"command","deviceId":"ABC123","command":"turnOn","parameter":"default","commandType":"command","dryRun":false,"result":"ok"}
```

## Crash safety

- The file is opened with the standard Node `appendFileSync` — each record is
  written atomically with respect to other `append` calls from the same
  process, but there is no fsync between writes. A crash mid-write can
  produce a partial last line; `history verify` detects and reports these.
- The CLI tolerates malformed lines when reading: `history show`, `history
  replay`, and MCP tools skip lines that fail to parse. Versioned records
  coexist with pre-version-1 records without any migration step.

## Versioning policy

- `auditVersion` is an integer that is bumped whenever a breaking change
  lands in the field set — field removal, type change, or renaming.
  Additive changes (a new optional field) do NOT bump the version.
- Old records are never rewritten. The CLI must always be able to read every
  prior `auditVersion` value. `history verify` reports a histogram so you
  can decide when to rotate the file.

## `history verify`

`switchbot history verify` ignores blank lines. Human output includes parsed
and malformed counts, an `auditVersion` histogram, earliest/latest timestamps
when available, and line numbers for malformed JSON. `--json` instead reports
`data.status`, `fileMissing`, `parsed`, `malformed`, `unversioned` and `message`.

Exit codes:

| Code | Meaning |
| --- | --- |
| 0 | No malformed or unversioned entries (`ok`), or file missing (`warn`). |
| 1 | At least one malformed or unversioned entry (`fail`). |

## Rotation

The audit log is not auto-rotated. Use external tooling (e.g. `logrotate`) or
truncate manually. If you migrate to a new file, keep the old one around for
`history verify` / `history replay` reference — the CLI does not require the
log to be contiguous.
