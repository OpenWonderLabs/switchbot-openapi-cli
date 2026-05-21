# MCP Test Coverage Gap Design

**Date:** 2026-05-21  
**Context:** After fixing 10 smoke-test bugs, two testing patterns were identified that allowed type bugs to slip through. This spec adds targeted tests to close both gaps.

---

## Root Cause Summary

### A: Schema boundary gap (caused F-3)

`list_devices` and other MCP tools declare nullable/optional fields in their Zod outputSchema (e.g. `roomID: z.string().nullable().optional()`). All test mocks use "happy path" data — fields either have a value or are omitted. No mock ever passes `null` through the outputSchema validation path. When the real API returns `null` for `roomID`, Zod rejects the value and the entire tool call fails.

### B: Implicit error format contract (caused F-2 follow-up breakage)

`mcpError()` in `src/commands/mcp.ts` returns `content[0].text` in a specific multi-line format:
```
<kind> error (code N): <message>
[optional hint]
--- structured ---
{ "error": { ... } }
```

No test pins this format. When T5 changed the format from raw JSON to this new layout, `mcp.test.ts` was updated but `dry-run.test.ts` was not — because `parseErrorText()` lived only inside `mcp.test.ts` and the two files had diverged in their parsing assumptions.

---

## Design

### Component 1: `tests/mcp/output-schema-boundary.test.ts` (new file)

**Purpose:** Verify that Zod outputSchema validation passes for all realistic API data shapes, including nullable fields and fully-omitted optional fields.

**What it tests:**
- `list_devices` with a physical device where `roomID: null` and `roomName: null`
- `list_devices` with a physical device where all optional fields are omitted (`deviceType`, `roomID`, `roomName`, `familyName`, `controlType` all absent)
- `list_devices` with an IR device where `controlType: null`
- `list_devices` with a mixed payload: one device with nulls + one without

**Pattern:** Uses the same `pair()` / `apiMock.__instance.get.mockResolvedValueOnce()` pattern already established in `tests/commands/mcp.test.ts`. Each test asserts `result.isError` is falsy and `structuredContent.deviceList` has the expected length. A Zod rejection would surface as `isError: true`.

**Why a new file (not extending mcp.test.ts):** `mcp.test.ts` is 1300+ lines. Boundary validation tests belong alongside the existing `tool-schema-completeness.test.ts` and `tool-meta.test.ts` in `tests/mcp/` — that directory is already the home for "schema contract" tests.

---

### Component 2: `tests/helpers/mcp-test-utils.ts` (new file)

**Purpose:** Single source of truth for MCP error response parsing, shared across all test files.

**Exports:**
```typescript
/** Extract the structured JSON from an mcpError content[0].text response. */
export function parseErrorText(text: string): unknown {
  const marker = '--- structured ---\n';
  const idx = text.indexOf(marker);
  if (idx === -1) return JSON.parse(text); // fallback: old format or non-error
  return JSON.parse(text.slice(idx + marker.length));
}
```

**Migration:** Update `tests/commands/mcp.test.ts` and `tests/commands/dry-run.test.ts` to import `parseErrorText` from this helper instead of defining/inlining it. The function signatures and behavior are identical — this is a pure extract-and-import refactor, no behavioral change.

---

### Component 3: `tests/mcp/error-format-contract.test.ts` (new file)

**Purpose:** Pin the exact text format of `mcpError()` output. Any change to the format in `src/commands/mcp.ts` must update this test, making the implicit contract explicit.

**What it tests:**
- Calls a tool that will return an error (e.g. `describe_device` with an ID that causes the mock API to reject with `ApiError`)
- Asserts `result.isError === true`
- Asserts `content[0].text` matches the summary line format: `/^(api|runtime|usage|guard) error \(code \d+\): /`
- Asserts `content[0].text` contains the `--- structured ---` separator
- Asserts the text after `--- structured ---\n` is valid JSON with an `error` key
- Asserts `structuredContent.error` exists (the parallel structured payload is unchanged)

**Why a separate file:** This is explicitly a "contract test" — it documents an interface boundary, not a feature behavior. Placing it in `tests/mcp/` next to `tool-schema-completeness.test.ts` makes the intent clear.

---

## Files Changed

| File | Action | Purpose |
|---|---|---|
| `tests/mcp/output-schema-boundary.test.ts` | Create | Boundary value tests for nullable/optional fields |
| `tests/helpers/mcp-test-utils.ts` | Create | Shared `parseErrorText` helper |
| `tests/commands/mcp.test.ts` | Modify | Import `parseErrorText` from shared helper |
| `tests/commands/dry-run.test.ts` | Modify | Import `parseErrorText` from shared helper |
| `tests/mcp/error-format-contract.test.ts` | Create | Contract test for `mcpError()` text format |

No production source files are changed. All changes are in test infrastructure.

---

## Verification

After implementation:

1. `npm test` — full suite passes, no regressions
2. Manually break the format: change `mcpError()` to return `JSON.stringify({error:obj})` as text (the old format) → `error-format-contract.test.ts` should fail immediately
3. Manually break a schema: change `roomID: z.string().nullable().optional()` back to `z.string().optional()` → `output-schema-boundary.test.ts` should fail on the `roomID: null` test case
4. Confirm `parseErrorText` is no longer defined inline in either `mcp.test.ts` or `dry-run.test.ts`
