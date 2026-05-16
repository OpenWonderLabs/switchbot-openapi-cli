# Test Coverage Improvement Design

**Date:** 2026-05-16  
**Branch:** fix/v3.6.2-bugs  
**Status:** Approved

## Problem

Five UX bugs shipped in v3.6.2 that existing tests did not catch. Root cause analysis identified three structural gaps — not a lack of test files, but incomplete coverage within existing test files:

1. **Partial exit-code coverage** — `process.exit(1|2)` calls in `src/commands/` have multiple branches; tests only exercised the most common path per command, leaving secondary branches untested.
2. **New options without tests** — `--devices` (plural alias) was added to `plan suggest` with no accompanying smoke test.
3. **Output text not asserted** — Tests verified command structure but not the content of user-visible message lines (e.g., `Remaining budget`, MCP tool count context, completion format values).

Baseline coverage (2026-05-16): **lines 77.66%, branches 79.7%** overall; `src/sinks/**` drags the average down due to external-infrastructure dependencies.

## Solution: Three-Layer Defence

### Layer 1 — Backfill 5 Missing Test Cases

Add one test per confirmed gap, directly in the existing test files. No new files.

| File | Test name | Assertion |
|---|---|---|
| `tests/commands/plan.test.ts` | `plan suggest exits 2 when no --device given` | `exitCode === 2`; stderr contains "at least one --device" |
| `tests/commands/plan.test.ts` | `plan suggest accepts --devices as alias for --device` | `exitCode === 0`; stdout contains the deviceId |
| `tests/commands/doctor.test.ts` | `mcp check message includes default profile context` | `detail.message` contains "default profile" and "24 in 'all'" |
| `tests/commands/quota.test.ts` | `status human output includes Remaining budget line` | stdout contains "Remaining budget" |
| `tests/commands/completion.test.ts` | `bash completion includes all --format values` | stdout contains `format_vals` and each of the 7 format keywords |

### Layer 2 — TESTING.md Convention

Create `TESTING.md` at the project root. Three rules, each mapping directly to a root cause:

**Rule 1: Every `process.exit` path needs its own test**  
Every `process.exit(1)` or `process.exit(2)` in `src/commands/` must have at least one test case in `tests/commands/` that reaches that path and asserts `exitCode`. New branches must be tested in the same commit.

**Rule 2: Every new CLI option/alias needs a smoke test**  
Every new `.option()` declaration (including aliases) must have at least one test that uses the flag and asserts it is parsed or produces the expected behavior.

**Rule 3: Non-trivial user-visible messages need keyword assertions**  
Any `console.log/error` line containing business-semantic keywords (a word whose removal would confuse the user) must have a corresponding test asserting that keyword appears in stdout/stderr.

**PR Checklist** (to be added at the end of TESTING.md):
```
Before merging, verify:
- [ ] New process.exit path → corresponding test added
- [ ] New CLI option/alias → smoke test added
- [ ] Changed user-visible message → keyword assertion updated
```

### Layer 3 — Layered Coverage Threshold in vitest.config.ts

```ts
coverage: {
  provider: 'v8',
  include: ['src/**/*.ts'],
  exclude: ['src/index.ts', 'src/sinks/**'],
  reporter: ['text', 'html'],
  thresholds: {
    lines: 80,       // global: +2pp above current baseline
    branches: 80,    // global: +0.3pp above current baseline
    '**': {
      branches: 75,  // per-file floor: prevents single-file collapse
    },
    'src/commands/**': {
      lines: 85,     // command layer: higher bar, where bugs occur
      branches: 80,
    },
  },
},
```

**Exclusion rationale:** `src/sinks/**` (homeassistant, telegram, openclaw, etc.) requires live external infrastructure and has ~5% coverage today. Including it in thresholds would cause constant false failures unrelated to code quality.

**Threshold rationale:** After the 5 backfill tests are added, `src/commands/**` is expected to clear 85% lines / 80% branches. The global 80% threshold is set 2–3pp above current to block regression without requiring immediate fixes to unrelated low-coverage areas.

## Files Changed

| File | Change |
|---|---|
| `tests/commands/plan.test.ts` | +2 test cases |
| `tests/commands/doctor.test.ts` | +1 test case |
| `tests/commands/quota.test.ts` | +1 test case |
| `tests/commands/completion.test.ts` | +1 test case |
| `TESTING.md` | New file — testing conventions and PR checklist |
| `vitest.config.ts` | Add `thresholds` block; exclude `src/sinks/**` |

## Success Criteria

1. All 2465 existing tests continue to pass.
2. 5 new tests pass and cover the previously untested paths.
3. `npm run test -- --coverage` exits 0 with the new thresholds in place.
4. TESTING.md is present at project root and linked from the PR checklist.
