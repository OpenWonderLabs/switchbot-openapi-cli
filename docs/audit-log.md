# Audit Log Format

The SwitchBot CLI writes a JSONL audit record for every mutating device or
scene command when either `--audit-log` is passed or a profile sets
`defaults.flags` including `--audit-log`.

- **Default path:** `~/.switchbot/audit.log`
- **Override:** `--audit-log-path <file>`
- **One record per line**, UTF-8, LF newline between lines (`"\n"`), appended.
- **Best-effort:** write failures are swallowed — a command never aborts because
  the audit log cannot be written.

## Schema

Every record is a JSON object with at least the following fields:

| Field          | Type                 | Notes                                                                                  |
|----------------|----------------------|----------------------------------------------------------------------------------------|
| `auditVersion` | number               | Schema version. Current: `1`. Missing on records written before audit versioning.      |
| `t`            | string (ISO-8601)    | Timestamp when the record was written.                                                 |
| `kind`         | `"command"`          | Record discriminator. Currently the only kind is `command`.                            |
| `deviceId`     | string               | Target device ID.                                                                      |
| `command`      | string               | SwitchBot command name (e.g. `turnOn`, `setColor`).                                    |
| `parameter`    | string \| object     | Command parameter as sent — `"default"` when unused.                                   |
| `commandType`  | `"command" \| "customize"` | Matches the upstream SwitchBot API field.                                        |
| `dryRun`       | boolean              | `true` when the command was intercepted by `--dry-run` and never reached the network.  |
| `result`       | `"ok" \| "error"`    | Optional — only present once the command completed (absent for `dryRun: true`).        |
| `error`        | string               | Optional — populated when `result === "error"`.                                        |

### Example

```json
{"auditVersion":1,"t":"2026-04-20T01:23:45.123Z","kind":"command","deviceId":"ABC123","command":"turnOn","parameter":"default","commandType":"command","dryRun":false,"result":"ok"}
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

`switchbot history verify` inspects the log and reports:

- total / parsed / skipped / malformed line counts
- histogram of `auditVersion` values (`unversioned` for pre-v1 records)
- earliest / latest timestamp
- per-line problem details for anything that failed to parse

Exit codes:

| Code | Meaning                                                                          |
|------|----------------------------------------------------------------------------------|
| 0    | Every line parsed; no malformed entries.                                         |
| 1    | File missing OR one or more malformed lines.                                     |

## Rotation

The audit log is not auto-rotated. Use external tooling (e.g. `logrotate`) or
truncate manually. If you migrate to a new file, keep the old one around for
`history verify` / `history replay` reference — the CLI does not require the
log to be contiguous.
