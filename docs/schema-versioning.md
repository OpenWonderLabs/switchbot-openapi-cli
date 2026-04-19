# Schema Versioning

This document describes how `schemaVersion` evolves across SwitchBot CLI releases.

## Overview

The CLI emits structured JSON responses with a `schemaVersion` field. This field follows semantic versioning to signal compatibility:

- **Additive changes** (new optional fields) → minor version bump (1.1, 1.2)
- **Breaking changes** (field removal, rename, type change) → major version bump (2.0)
- **No compatibility shim** — parsers that pin schemaVersion "1" continue to work against 1.1, 1.2, etc. (backward-compatible)

## Current Versions

- **v1.7.0**: schemaVersion "1.1"
  - `batch` command: added `failed[].error.retryAfterMs`, `failed[].error.transient`, `failed[].error.errorClass`
  - All new fields are optional

- **v1.0.0 – v1.6.x**: schemaVersion "1"
  - Original unified JSON envelope structure

## Migration Path

### From v1.6 → v1.7

**What changed:**
- `batch` failed array entries now include richer error metadata
- Old: `{deviceId, error: "string message"}`
- New: `{deviceId, error: {code, kind, message, errorClass, transient, retryAfterMs, ...}}`

**Why it's backward-compatible:**
- The response still has `failed[]`, `succeeded[]`, `summary` at the top level
- Parsers that don't examine error details are unaffected
- Parsers that do examine error details now see structured ErrorPayload

**How to update your integration:**
1. Check if your parser uses `failed[].error`
2. If so, update to read `failed[].error.message` for the error string (same content)
3. Optionally use `failed[].error.transient` to decide retry logic
4. Optionally use `failed[].error.retryAfterMs` to wait before retry

### To v2.0 (Future)

When breaking changes ship, we'll:
1. Announce via GitHub Releases with migration instructions
2. Ship schemaVersion "2" alongside "1" for one release cycle (if feasible)
3. After one cycle, drop the "1" schema

## Schema Pinning (Not Recommended)

Some tools allow pinning to exact schema versions. We recommend against this for `schemaVersion`, since:
- The CLI rarely ships breaking changes
- Pinning to `"1"` means you stay on 1.0-1.9x even when security fixes land in 1.5+
- Pinning to `"1.1"` works until v2.0, at which point you'd need to update anyway

Instead, test your integration against the current release and trust the semantic versioning signal.
