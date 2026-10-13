# Schema Versioning

SwitchBot CLI has separate machine-readable contracts. A version in one
contract does not change the version of another contract.

## Current versions for CLI 3.9.0

| Contract | Location | Version | What it versions |
| --- | --- | --- | --- |
| JSON envelope | top-level JSON success and error output | `1.2` | `{ schemaVersion, data }` and `{ schemaVersion, error }` |
| Discovery export | `schema export` data `version` | `2.0` | the discoverable catalog payload, including resources |
| Resource catalog | `schema export` data `resources.version` | `2.0` | scenes, webhooks, and keypad resource metadata |
| Device entry shape | each item in `schema export` data `types` | `1.0` | device command and status-field descriptors |
| Event payload | streaming event data `payloadVersion` | `1` | normalized event record inside the JSON envelope |

The top-level JSON envelope remains `1.2`. Its version does not mean that
every command payload has the same version or shape.

## Compatibility rules

- Additive optional fields are compatible within the affected contract.
- Removing, renaming, or changing the type or nesting of a field is breaking
  for that contract and requires a major version change there.
- Adding a REST endpoint does not by itself change the JSON envelope version.
- `schema export` 2.0 is a clean cutover for resource discovery. Webhook
  entries now describe the official outer `changeReport` envelope and a nested
  `context`; consumers of export 1.0 must migrate rather than interpret the
  new resource metadata as compatible.
- Device descriptors in `types` retain their 1.0 shape. Resource changes do
  not imply a device-entry change.

## JSON envelope

Every non-streaming JSON success is shaped as follows:

~~~json
{ "schemaVersion": "1.2", "data": { } }
~~~

Every non-streaming JSON error is shaped as follows:

~~~json
{ "schemaVersion": "1.2", "error": { "code": 1, "kind": "runtime", "message": "..." } }
~~~

`schemaVersion` describes this wrapper only. Parse command-specific output
from `data` after selecting the applicable command or discovery version.

## Discovery export migration

A 2.0 export has this version boundary:

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

The resource catalog is descriptive metadata, not a JSON Schema validator.
Fields describe documented webhook examples and can be absent when an official
variant does not include them. In particular, consumers must not infer a
universal MAC address, sample time, or primitive-only context shape.

## Streaming events

Streaming commands first emit a lean header. `devices watch` uses envelope
version `1.2`; `events tail` and `events mqtt-tail` use stream-header version
`1`.

Subsequent event lines from `events tail` and `events mqtt-tail` are normal
JSON envelopes at `schemaVersion` `1.2`. Their `data.payloadVersion` is `1`.
The payload version applies to the normalized event record, not to the outer
JSON envelope or the upstream raw payload.

A historical `batch.summary.schemaVersion` remains a compatibility field.
Prefer the top-level envelope version for CLI output parsing.
