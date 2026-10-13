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

For example, schema discovery in CLI 3.9.0 is an envelope at `1.2`, an export
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
