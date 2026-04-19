# Schema Versioning

This document describes how `schemaVersion` evolves across SwitchBot CLI releases.

## Overview

The CLI emits structured JSON responses wrapped in a top-level envelope that carries a `schemaVersion` field. This field follows semantic versioning to signal compatibility:

- **Additive changes** (new optional fields) → minor version bump (1.1, 1.2)
- **Breaking changes** (field removal, rename, type change) → major version bump (2.0)
- **No compatibility shim** — parsers that pin schemaVersion "1" continue to work against 1.1, 1.2, etc. (backward-compatible)

## Envelope shape (v2.0+)

Every JSON response is one of:

```json
{ "schemaVersion": "1.1", "data": { ... } }
```

```json
{ "schemaVersion": "1.1", "error": { "code": 1, "kind": "...", "message": "..." } }
```

The payload your integration cares about is always nested under `data` (success) or `error` (failure). `schemaVersion` describes the *payload shape*, not the CLI version — the envelope itself is the structural signal introduced in CLI 2.0.

### Historical nested location: `batch.summary.schemaVersion`

Before the top-level envelope existed, the `batch` command nested `schemaVersion` inside `summary`. That nested field is retained for back-compat — both of the following are set, and both equal `"1.1"`:

```json
{
  "schemaVersion": "1.1",
  "data": {
    "summary": { "schemaVersion": "1.1", "total": 3, "ok": 2, "error": 1, "skipped": 0 },
    "succeeded": [ ... ],
    "failed": [ ... ]
  }
}
```

Prefer the top-level `schemaVersion`. The nested copy may be removed in a future major.

## Current Versions

- **v2.0.0**: schemaVersion "1.1" inside a new top-level `{schemaVersion, data|error}` envelope
  - Every `--json` response now has a top-level `schemaVersion` (previously only `batch.summary` had it)
  - Payload lives under `data` for success, `error` for failure
  - Existing payload shapes are unchanged — only the wrapper is new

- **v1.7.0 – v1.12.x (unpublished)**: schemaVersion "1.1"
  - `batch` command: added `failed[].error.retryAfterMs`, `failed[].error.transient`, `failed[].error.errorClass`
  - All new fields are optional

- **v1.0.0 – v1.6.x**: schemaVersion "1"
  - Original unified JSON response structure (no top-level envelope)

## Migration Path

### From v1.x → v2.0

**What changed:**
1. Every `--json` response is now wrapped in `{schemaVersion, data}` (success) or `{schemaVersion, error}` (failure).
2. `batch.failed[].error` is now an object instead of a string (richer error metadata).
3. `switchbot mcp serve` defaults to binding `127.0.0.1`. Pass `--bind 0.0.0.0 --auth-token <token>` to restore external reachability.

**How to update your integration:**
- Unwrap the envelope once: `parsed.data.<field>` instead of `parsed.<field>`, `parsed.error.<field>` for failures.
- For `batch`, read `failed[].error.message` for the previous string content; use `failed[].error.transient` / `retryAfterMs` for retry decisions.
- For MCP HTTP deployments, add explicit `--bind` + `--auth-token` flags if external reachability is required.

### From v1.6 → v1.7 (historical)

**What changed:**
- `batch` failed array entries now include richer error metadata
- Old: `{deviceId, error: "string message"}`
- New: `{deviceId, error: {code, kind, message, errorClass, transient, retryAfterMs, ...}}`

**How to update your integration:**
1. Check if your parser uses `failed[].error`
2. If so, update to read `failed[].error.message` for the error string (same content)
3. Optionally use `failed[].error.transient` to decide retry logic
4. Optionally use `failed[].error.retryAfterMs` to wait before retry

## Schema Pinning (Not Recommended)

Some tools allow pinning to exact schema versions. We recommend against this for `schemaVersion`, since:
- The CLI rarely ships breaking changes
- Pinning to `"1"` means you stay on 1.0-1.9x even when security fixes land in 1.5+
- Pinning to `"1.1"` works until a future v2 of the payload shape, at which point you'd need to update anyway

Instead, test your integration against the current release and trust the semantic versioning signal.
