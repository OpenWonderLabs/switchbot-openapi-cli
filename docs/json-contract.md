# JSON Output Contract

Pass `--json` to write machine-readable output to stdout. Stderr is not part
of this contract.

## 1. Non-streaming commands

Commands such as `devices list`, `schema export`, `scenes list`, and `webhook
query` emit one JSON envelope.

### Success

~~~json
{
  "schemaVersion": "1.2",
  "data": { }
}
~~~

### Error

~~~json
{
  "schemaVersion": "1.2",
  "error": {
    "code": 2,
    "kind": "usage",
    "message": "human-readable message"
  }
}
~~~

`schemaVersion` is the version of the outer envelope. It changes only if the
outer success or error shape changes. A command payload can have an additional
version inside `data`.

For example, schema discovery in CLI 3.10.0 is an envelope at `1.2`, an export
at `2.0`, and a resource catalog at `2.0`:

~~~json
{
  "schemaVersion": "1.2",
  "data": {
    "version": "2.0",
    "types": [],
    "resources": { "version": "2.0" }
  }
}
~~~

The webhook resource catalog is descriptive discovery metadata. It models the
upstream outer envelope separately from `context.deviceType`, and may describe
nested context objects. It is not a validator or a promise that every listed
field appears in every payload variant.

`agent-bootstrap --compact` reports cached device types only: a cold cache has
`data.catalog.scope: "used"` and `data.catalog.types: []`. This is not a live
device count. A single-model `schema export --type S30` includes that model's
webhook contracts; omit `--type` for the full resource catalog. Compact CLI
parameter examples remain strings; S30 `selfClean` sends a JSON number.

### Device inventory and command results

In unprojected `devices list --json`, a Vision Doorbell entry in
`data.deviceList` can have a string `lockDeviceId` (bound Lock MAC), an
explicit `null` (no Lock bound), or no field (not reported). Physical-device
cache and MCP inventory preserve that distinction. Requesting
`--fields deviceId,lockDeviceId` explicitly projects missing values as `null`;
do not use projected output to distinguish missing from unbound.

`switchbot --json devices command <id> <cmd> [parameter] --explain` sends no command. `data.idempotent`
is `true` if repeating the command has the same effect, `false` if it can
change the result again (as with Art Frame `deleteImage`), or `null` if the
catalog does not say. A custom IR button has unknown behavior even if its
name matches a built-in command. This field is not an approval or a retry policy.
In MCP `riskProfile`, the existing two-valued `idempotencyHint` reports
`non-idempotent` for both false and unknown. The generic command manifest
uses `caution` when it cannot know more. A key deduplicates a cached success;
it neither authorizes a mutation nor resolves an uncertain outcome.

For an authorized, executed `deleteImage`, the SwitchBot response **body**
contains integer `deletedImageIndex` and `remainingCount`. Read them at the
location appropriate to the caller:

- CLI `devices command --json`: directly in `data`, alongside `ok`, `deviceId`
  and `command`.
- CLI `plan execute --json`: in `data.results[].result` on the successful
  command step.
- MCP (when execution is permitted): `send_command` uses
  `structuredContent.result`; `plan_run` uses `structuredContent.results[].result`
  on the successful command step. Dry-runs and skipped steps have no cloud result.

For example, `{"deletedImageIndex":0,"remainingCount":1}` means only the
displayed image remains and nothing was deleted. With both values `0`, the
album was empty. Do not treat zero as missing. The count is for the **cloud
album**, including images not downloaded to the frame. A successful deletion
means the cloud removed the image and sent the instruction, not that the frame
has finished. See the [pinned device evidence](openapi-alignment-ambiguities.md#2026-11-20-upstream-snapshot-unreleased).

## 2. Streaming commands

`devices watch`, `events tail`, and `events mqtt-tail` emit NDJSON. The first
line is always a lean stream header.

| Command | Header schemaVersion | eventKind | cadence |
| --- | --- | --- | --- |
| `devices watch` | `1.2` | `tick` | `poll` |
| `events tail` | `1` | `event` | `push` |
| `events mqtt-tail` | `1` | `event` | `push` |

~~~json
{ "schemaVersion": "1", "stream": true, "eventKind": "event", "cadence": "push" }
~~~

The header is not a normal success envelope. Route it by `stream: true`.

### Event lines

After an `events tail` or `events mqtt-tail` header, each normalized event line
is a normal envelope at `1.2`. The event record has its own payload version:

~~~json
{
  "schemaVersion": "1.2",
  "data": {
    "payloadVersion": "1",
    "source": "webhook",
    "kind": "event",
    "t": "2026-04-21T14:23:45.012Z",
    "eventId": null,
    "deviceId": "BOT1",
    "topic": "/webhook",
    "payload": { },
    "matchedKeys": ["deviceId"]
  }
}
~~~

`payload` preserves the source-specific raw webhook or MQTT payload. The CLI
does not rewrite a webhook `context`. `payloadVersion` versions the normalized
record inside `data`; it is not the raw SwitchBot webhook event version.

Control records from `events mqtt-tail` use the same outer and payload
versions, with `kind: "control"` and a `controlKind` such as `connect` or
`disconnect`.

### Watch lines

After the `devices watch` header, each tick is a normal `1.2` envelope:

~~~json
{
  "schemaVersion": "1.2",
  "data": {
    "t": "2026-04-21T14:23:45.012Z",
    "tick": 1,
    "deviceId": "BOT1",
    "type": "Bot",
    "changed": { "power": { "from": null, "to": "on" } }
  }
}
~~~

### Streaming errors

A fatal streaming error is emitted as the normal `1.2` error envelope and the
process exits nonzero. Consumers must accept a header followed by an error
envelope.

## 3. Consumer guidance

1. Parse the first line. If `stream` is true, select a stream parser.
2. For non-streaming output, inspect the `1.2` envelope and read `data` or
   `error`.
3. For event streams, unwrap `data` and use `payloadVersion` for the normalized
   event record.
4. For schema discovery, select on `data.version` and
   `data.resources.version`, not on the outer envelope version.

Human-readable output and stderr are not versioned machine contracts.
