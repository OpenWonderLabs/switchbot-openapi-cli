# JSON Output Contract

`switchbot-cli` emits machine-readable output on **stdout** whenever you pass
`--json` (or the `--format=json` alias once P13 lands). Stderr is reserved for
human-facing progress / warnings and is never part of the contract.

There are two output shapes. You pick the right parser by the shape of the
**first line** emitted on stdout.

---

## 1. Single-object / array commands (non-streaming)

Most commands — `devices list`, `devices status`, `devices describe`,
`capabilities`, `schema export`, `doctor`, `catalog show`, `history list`,
`scenes list`, `webhook query`, etc. — emit **exactly one** JSON envelope on
stdout.

### Success envelope

```json
{
  "schemaVersion": "1.1",
  "data": <command-specific payload>
}
```

- `schemaVersion` tracks the envelope shape, not the inner payload shape.
  The envelope version only bumps when `data` moves or is renamed; inner
  payload changes get called out in `CHANGELOG.md` on a per-command basis.
- `data` is always present on success (never `null`).

### Error envelope

```json
{
  "schemaVersion": "1.1",
  "error": {
    "code": 2,
    "kind": "usage" | "guard" | "api" | "runtime",
    "message": "human-readable description",
    "hint": "optional remediation string",
    "context": { "optional, command-specific": true }
  }
}
```

- Both success and error envelopes are written to **stdout** so a single
  `cli --json ... | jq` pipe can decode either shape (SYS-1 contract).
- `code` is the process exit code. `2` = usage / guard, `1` = runtime / api.
- Additional fields may appear on specific error classes
  (`retryable`, `retryAfterMs`, `transient`, `subKind`, `errorClass`).

---

## 2. Streaming / NDJSON commands

Three commands emit one JSON document per line (NDJSON) instead of a single
envelope:

| Command             | `eventKind` | `cadence` |
|---------------------|-------------|-----------|
| `devices watch`     | `tick`      | `poll`    |
| `events tail`       | `event`     | `push`    |
| `events mqtt-tail`  | `event`     | `push`    |

### Stream header (always the first line under `--json`)

```json
{ "schemaVersion": "1", "stream": true, "eventKind": "tick" | "event", "cadence": "poll" | "push" }
```

- **Must always be the first line** on stdout under `--json`. Consumers
  should read one line, parse, and key on `{ "stream": true }` to confirm
  they are reading from a streaming command.
- `eventKind` picks the downstream parser. `tick` → `devices watch` shape
  with `{ t, tick, deviceId, changed, ... }`. `event` → unified event
  envelope (see below).
- `cadence`:
  - `poll` — the CLI drives timing. One line per `--interval`.
  - `push` — broker/webhook drives timing. Quiet gaps are normal.

### Event envelope (subsequent lines on `events tail` / `events mqtt-tail`)

```json
{
  "schemaVersion": "1",
  "source": "webhook" | "mqtt",
  "kind":   "event" | "control",
  "t":      "2026-04-21T14:23:45.012Z",
  "eventId": "uuid-v4-or-null",
  "deviceId": "BOT1" | null,
  "topic":   "/webhook" | "$aws/things/.../shadow/update/accepted",
  "payload": { /* source-specific */ },
  "matchedKeys": ["deviceId", "type"]
}
```

- `source` and `kind` together tell a consumer how to treat the record.
  Control events (`kind: "control"`) carry a `controlKind` like
  `"connect"`, `"reconnect"`, `"disconnect"`, `"heartbeat"`.
- `matchedKeys` is only populated on webhook events when `--filter` was
  supplied — it lists which filter clauses hit.
- Legacy fields (`body`, `remote`, `path`, `matched`, `type`, `at`) are
  still emitted alongside the unified fields for one minor window. They
  are **deprecated** and will be removed in the next major release; new
  consumers should read only the unified fields above.

### Tick envelope (subsequent lines on `devices watch`)

```json
{
  "schemaVersion": "1.1",
  "data": {
    "t": "2026-04-21T14:23:45.012Z",
    "tick": 1,
    "deviceId": "BOT1",
    "type": "Bot",
    "changed": { "power": { "from": null, "to": "on" } }
  }
}
```

Watch records reuse the single-object envelope (`{ schemaVersion, data }`)
— only the header uses the lean streaming shape. That keeps the existing
watch consumers working: they only need to add a filter that skips the
first header line.

### Errors from a streaming command

If a streaming command hits a fatal error mid-stream, it emits the
**error envelope** (section 1) on stdout and exits non-zero. Consumers
should be prepared to see either `{ stream: true }` or `{ error: ... }`
on any line.

---

## 3. Consumer patterns

**Route by shape** on line 1:

```bash
# generic: peek at line 1, pick parser
first=$(head -n 1)
if echo "$first" | jq -e '.stream == true' >/dev/null; then
  # streaming — subsequent lines are event envelopes
  while IFS= read -r line; do
    echo "$line" | jq 'select(.kind == "event")'
  done
else
  # single-object / array — $first already has the whole payload
  echo "$first" | jq '.data'
fi
```

**Skip the stream header** if you only want events:

```bash
switchbot events mqtt-tail --json | jq -c 'select(.stream != true)'
```

**Detect the error envelope** from any command:

```bash
switchbot devices status BOT1 --json | jq -e '.error' && exit 1
```

---

## 4. Versioning

- The non-streaming envelope is versioned as `schemaVersion: "1.1"`.
- The streaming header and event envelope are versioned as
  `schemaVersion: "1"`.
- The two axes are deliberately separate: adding a field inside `data`
  does **not** bump the envelope, but renaming / removing `data` would.
- Breaking changes land on a major release. Additive fields land on a
  minor release and are listed under `### Added` in `CHANGELOG.md`.

---

## 5. What this contract does NOT cover

- Human-readable (`--format=table` or default) output — may change at any
  time.
- Stderr output — progress strings, deprecation warnings, TTY hints. Do
  not parse stderr.
- In-file history records under `~/.switchbot/device-history/` — see
  `docs/schema-versioning.md`.
