# Account switching and command safety MVP

## Scope

Follow-up to the API-alignment review on `feat/switchbot-api-alignment`.
Keep the existing CLI commands, JSON envelopes, MCP payloads, policy grammar,
and credential precedence. No release, hardware operation, or upstream API
expansion is part of this work.

## Findings

| Finding | Priority | Observable problem | MVP |
| --- | --- | --- | --- |
| MCP cold-cache type fallback | P1 | A device identified only by `controlType` can pass command validation but skip destructive-command authorization. | 1 |
| Cross-process account cache invalidation | P1 | Saving new credentials removes disk caches but a running process can retain the old account's inventory, status, credentials, or idempotent result. | 1 |
| Two default cache scopes | P2 | Implicit default and `--profile default` share credentials but currently use different device/status caches. | 1 |
| MCP output contract regression coverage | P3 | The current implementation rejects malformed outputs, but permanent protocol tests do not protect all exclusive success/error constraints. | 2 |
| Repeated rule JSON parsing | P3 | A valid JSON rule parameter is parsed before validation, by its validator, and again for dispatch. | 2 |
| Cache publication and replacement races | P1 | Torn disk writes, late responses, or retained clients can mix account data unless revision and request boundaries fail closed. | 1 |
| Keychain recovery and HTTP request errors | P1 | A locked replacement keychain must not expose stale file credentials or prevent offline credential repair; concurrent priming must not terminate MCP. | 1 |

Solar's inventory-dependent automation restriction is intentional: do not
extend it to Video Doorbell by adding a global verb prohibition. Both
`setColor 255 0 0` and `setColor 255:0:0`, and the corresponding
`setColorLightRGB` forms, remain supported. JSON string contents and audit
parameter shapes must remain unchanged.

## MVP 1: safety and account lifecycle

- Use the same resolved device type for MCP validation, normalization, risk,
  direct-execution permission, and confirmation. Cover `deviceType` and
  `controlType`, cold and warm caches, Solar and Lock Ultra Max, and a real IR
  custom command. Default-profile destructive calls must make zero POSTs.
- Publish account-cache invalidation only through the existing credential
  mutation commands. Use a non-secret scope revision, not stored credentials,
  a background polling service, or a new CLI flag. Running processes check the
  revision at their next cache/credential use; an unchanged revision retains
  the existing hot-cache and credential TTL behavior.
- Invalidate device/status and credential snapshots, and prevent reuse of an
  old account's idempotent result. An old in-flight response must not repopulate
  a new account's cache. Do not retry a mutation automatically during an
  account change.
- Atomically replace cache documents with a private, additive
  `_credentialRevision` field so a stale writer cannot attach old data to a
  new account. Existing public cache-return fields and CLI/MCP output remain
  unchanged; missing metadata is accepted only before a revision exists.
- Preserve keychain-first resolution. When a native keychain replacement was
  published, fail closed if that store cannot supply the replacement; never
  fall back to an older file. Publish keychain mutations to the profile they
  actually modify even when an unrelated `--config` is present.
  Keep offline commands and credential repair available if the store is
  locked, while synchronous and asynchronous credential consumers fail closed.
- Unify implicit and explicit default cache storage on the existing
  `~/.switchbot/devices.json` and `status.json` paths. Keep named profiles
  isolated and retain explicit `--config` precedence. Ignore obsolete
  explicit-default cache data rather than restoring it into the active scope.
- Do not delete policy, audit, or event-history data. Environment credentials
  remain highest priority. Direct environment/file edits are not login events;
  document their manual invalidation/restart requirements.

## MVP 2: contracts and rule execution

- Exercise real SDK `listTools` followed by `callTool`, with output validation
  enabled. Protect rejection of missing required success fields, mixed
  success/error objects, and incorrectly typed error fields. Preserve valid
  success and structured-error responses; do not relax schemas.
- Remove the redundant pre-validation wire conversion in rules. Retain
  consumer-visible request parameters and successful/failed audit records,
  including RGB compatibility and JSON objects with spaces or newlines.
- Keep implementation-count/performance probes temporary. Permanent tests
  assert behavior and invariants, not the number of `JSON.parse` calls.

## MVP 3: documentation and verification

- Update README, changelog, agent guidance, and relevant policy/schema notes
  with account switching, scope boundaries, safety behavior, and compatibility.
- Use vertical TDD: one failing consumer regression, the minimal fix, then its
  passing check. Characterization tests for already-correct MCP rejection paths
  need no artificial production failure. Review independent lifecycle slices
  in parallel and run checks centrally.
- Run the full CLI regression suite and Markdown lint after integration;
  update documented test counts from that run, not a prediction.
- Smoke the actual CLI and MCP SDK with isolated HOME/configuration and local
  HTTP adapters. Demonstrate external credential replacement while another
  process is warm, default/profile isolation, no destructive POST on refusal,
  and unchanged rule wire/audit data. Do not claim cloud or hardware validation.

## Delivery evidence

- Full CLI suite: **180 files, 3191 tests passed**; its setup ran the release
  build and TypeScript typecheck. Plugin workspace tests were not rerun.
- `npm run lint:md` passed.
- Isolated real CLI + MCP SDK smoke: a separate `config set-token` process
  changed a warm reader from account A's inventory, status, and keyed command
  result to B's; a cold `controlType`-only lock was refused with zero POSTs.
  Implicit and explicit default shared inventory.
- Rule smoke sent both RGB forms as `255:0:0`; a spaced JSON object and all
  three corresponding audit parameters were unchanged. A 64 KiB JSON payload
  was parsed twice instead of three times; this count probe was temporary.
- Dedicated regressions cover late cache responses and disk writes, keychain
  failure and repair, retained-client/429 races, HTTP MCP recovery including an
  unavailable startup profile, profile scoping, and invalid SDK output. All
  network boundaries were local adapters.
- Follow-up coverage protects failed credential mutations, named-profile and
  config-directory isolation, explicit credential overrides, obsolete default
  caches, dispatched HMAC signatures, and dry-run read/mutation separation.
  Live MCP cases exercise nine Light Bars numeric fields at both endpoints
  and reject out-of-range, fractional, string, null, and missing values.
  Policy and cold-cache rule cases preserve the Solar/Video Doorbell exception;
  RGB and multiline JSON cases assert both wire and audit data, including dry-runs.
- Two new regressions failed before the minimal MCP fixes: named-profile HTTP
  requests ignored `--config`, and tool credential-refresh failures omitted
  structured errors. Both now pass. The ordinal filesystem-read race probe was
  removed; retained HTTP recovery cases verify distinct replacement accounts.
- Built CLI HTTP/stdio smoke verified config-override dispatch, structured
  credential failure with zero API requests, and same-process recovery after
  an external `config set-token` repair. A local HTTP boundary replaced the
  cloud; no real credential store was accessed.
- No real OAuth, cloud API, MQTT broker, camera/image URL, or physical device
  was exercised.
