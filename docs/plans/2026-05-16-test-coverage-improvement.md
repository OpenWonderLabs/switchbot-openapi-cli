# Test Coverage Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill 5 missing test cases, add TESTING.md conventions, and enforce layered coverage thresholds in vitest — preventing the three structural test gaps that let v3.6.2 bugs ship untested.

**Architecture:** Three independent deliverables committed separately. Tests first (Layer 1), convention doc second (Layer 2), CI gate last (Layer 3) — so coverage thresholds are added only after the new tests already pass.

**Tech Stack:** TypeScript, vitest 2.1.9, @vitest/coverage-v8, Commander.js. Tests use in-process `runCli()` helper (not subprocess) — see `tests/helpers/cli.ts`.

---

## File Map

| File | Change |
|---|---|
| `tests/commands/plan.test.ts` | +2 test cases inside existing `describe('plan suggest')` block |
| `tests/commands/doctor.test.ts` | +1 test case inside existing `it('P10: mcp check…')` neighbourhood |
| `tests/commands/quota.test.ts` | +1 test case inside existing `describe('quota command')` block |
| `tests/commands/completion.test.ts` | +1 test case inside existing `describe('completion command')` block |
| `TESTING.md` | New file at project root |
| `vitest.config.ts` | Add `thresholds` block; add `src/sinks/**` to `exclude` |

---

## Task 1: Backfill plan.test.ts — 2 missing cases

**Files:**
- Modify: `tests/commands/plan.test.ts:361-369`

The existing `describe('plan suggest')` block ends at line 369. Append both new tests inside it.

- [ ] **Step 1: Open the file and locate the insertion point**

Find this block near the end of the file:

```ts
describe('plan suggest', () => {
  it('exits 2 for unsupported Chinese command intent instead of defaulting to turnOn', async () => {
    const res = await runCli(registerPlanCommand, [
      'plan', 'suggest', '--intent', '关掉所有灯', '--device', 'BOT1',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/cannot safely infer/i);
  });
});
```

- [ ] **Step 2: Add the two new tests inside the same `describe` block**

Replace the closing `});` of `describe('plan suggest')` with:

```ts
  it('exits 2 when no --device is given', async () => {
    const res = await runCli(registerPlanCommand, [
      'plan', 'suggest', '--intent', 'turn off lights',
    ]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toContain('at least one --device');
  });

  it('accepts --devices as alias for --device', async () => {
    cacheMock.map.set('BOT1', { type: 'Bot', name: 'My Bot', category: 'physical' });
    const res = await runCli(registerPlanCommand, [
      'plan', 'suggest', '--intent', 'turn on the bot', '--devices', 'BOT1',
    ]);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join('\n')).toContain('BOT1');
  });
});
```

- [ ] **Step 3: Run just these new tests**

```bash
npm test -- tests/commands/plan.test.ts
```

Expected: all tests in that file pass, including the 2 new ones.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/plan.test.ts
git commit -m "test: backfill plan suggest exit-code and --devices alias coverage"
```

---

## Task 2: Backfill doctor.test.ts — 1 missing case

**Files:**
- Modify: `tests/commands/doctor.test.ts` — add after the existing `P10: mcp check` test (line ~327)

- [ ] **Step 1: Locate insertion point**

Find the existing test that ends around line 327:

```ts
  it('P10: mcp check is ok and reports a toolCount when the server instantiates', async () => {
    // ...
    expect(mcp.detail.transportsAvailable).toEqual(['stdio', 'http']);
  });
```

- [ ] **Step 2: Add the new test immediately after it**

```ts
  it('P10: mcp check message includes default profile context', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const mcp = payload.data.checks.find((c: { name: string }) => c.name === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp.detail.message).toContain('default profile');
    expect(mcp.detail.message).toContain("24 in 'all'");
  });
```

- [ ] **Step 3: Run just this test file**

```bash
npm test -- tests/commands/doctor.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/doctor.test.ts
git commit -m "test: assert doctor mcp message includes default profile context"
```

---

## Task 3: Backfill quota.test.ts — 1 missing case

**Files:**
- Modify: `tests/commands/quota.test.ts` — add inside existing `describe('quota command')`

- [ ] **Step 1: Locate insertion point**

Find the first `it(...)` inside `describe('quota command')` which starts at line 34:

```ts
describe('quota command', () => {
  it('status prints today usage + endpoint breakdown (human mode)', async () => {
    // ...
  });
```

- [ ] **Step 2: Add the new test after the existing first test**

```ts
  it('status human output includes Remaining budget line with reset time', async () => {
    const result = await runCli(registerQuotaCommand, ['quota', 'status']);
    const out = result.stdout.join('\n');
    expect(out).toContain('Remaining budget:');
    expect(out).toContain('resets at');
  });
```

- [ ] **Step 3: Run just this test file**

```bash
npm test -- tests/commands/quota.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/quota.test.ts
git commit -m "test: assert quota status output contains Remaining budget and reset time"
```

---

## Task 4: Backfill completion.test.ts — 1 missing case

**Files:**
- Modify: `tests/commands/completion.test.ts` — add inside existing `describe('completion command')`

The existing bash test (line 21) checks for `--profile` and `--audit-log-path` but not format values.

- [ ] **Step 1: Locate insertion point**

Find the existing bash test:

```ts
  it('prints a bash completion script', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('_switchbot_completion');
    // ...
  });
```

- [ ] **Step 2: Add new test after it**

```ts
  it('bash completion includes all --format values', async () => {
    const res = await runCli(registerCompletionCommand, ['completion', 'bash']);
    expect(res.exitCode).toBeNull();
    const out = written.join('');
    expect(out).toContain('format_vals');
    for (const fmt of ['table', 'json', 'jsonl', 'tsv', 'yaml', 'id', 'markdown']) {
      expect(out).toContain(fmt);
    }
  });
```

- [ ] **Step 3: Run just this test file**

```bash
npm test -- tests/commands/completion.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/completion.test.ts
git commit -m "test: assert bash completion exposes all --format enum values"
```

---

## Task 5: Create TESTING.md

**Files:**
- Create: `TESTING.md` at project root

- [ ] **Step 1: Create the file with this exact content**

```markdown
# Testing Conventions

This document defines the three rules that prevent the class of bugs identified
in the v3.6.2 post-mortem. Each rule maps to a specific root cause.

---

## Rule 1 — Every `process.exit` path needs its own test

Every `process.exit(1)` or `process.exit(2)` call in `src/commands/` must have
at least one test case in `tests/commands/` that reaches that path and asserts
`exitCode`. New exit branches must be tested in the same commit.

**Why:** v3.6.2 shipped `plan suggest` with a missing-argument branch that exited
with code 1 instead of 2. The existing test only exercised a different branch in
the same command, leaving the new branch invisible to CI.

---

## Rule 2 — Every new CLI option/alias needs a smoke test

Every new `.option()` declaration (including aliases) must have at least one test
that uses the flag and asserts it is parsed or produces the expected behavior.

**Why:** The `--devices` plural alias for `plan suggest` shipped with zero test
coverage. Any rename or collision would have been silent.

---

## Rule 3 — Non-trivial user-visible messages need keyword assertions

Any `console.log/error` line containing a business-semantic keyword — one whose
removal would confuse the user — must have a corresponding test asserting that
keyword appears in `stdout` or `stderr`.

**Why:** The doctor MCP tool-count message and quota reset-time line were changed
without any test catching the change, because tests only checked numeric structure,
not message content.

---

## PR Checklist

Before merging, verify:

- [ ] New `process.exit` path → corresponding test added
- [ ] New CLI option/alias → smoke test added
- [ ] Changed user-visible message → keyword assertion updated
```

- [ ] **Step 2: Verify the file exists**

```bash
cat TESTING.md | head -5
```

Expected output starts with `# Testing Conventions`.

- [ ] **Step 3: Commit**

```bash
git add TESTING.md
git commit -m "docs: add TESTING.md with three coverage conventions and PR checklist"
```

---

## Task 6: Add layered coverage thresholds to vitest.config.ts

**Files:**
- Modify: `vitest.config.ts`

Run the full coverage suite first to confirm the new tests bring `src/commands/**`
above the thresholds before writing the config.

- [ ] **Step 1: Run coverage and inspect the summary**

```bash
npm run test -- --coverage 2>&1 | grep -E "^All files|src/commands"
```

Expected output (approximate — exact numbers depend on which lines the 5 new tests hit):

```
src/commands     |   85.x |    80.x |   ...
All files        |   78.x |    80.x |   ...
```

If `src/commands` lines are below 85 or branches below 80, the thresholds in Step 2
will fail — investigate which file is low before proceeding.

- [ ] **Step 2: Edit `vitest.config.ts` — replace the `coverage` block**

Current content:

```ts
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
    },
```

Replace with:

```ts
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/sinks/**'],
      reporter: ['text', 'html'],
      thresholds: {
        lines: 80,
        branches: 80,
        'src/commands/**': {
          lines: 85,
          branches: 80,
        },
      },
    },
```

- [ ] **Step 3: Run coverage and confirm it passes**

```bash
npm run test -- --coverage 2>&1 | tail -10
```

Expected: exits 0, no threshold violation lines (lines starting with `ERROR`).

If you see `ERROR: Coverage for lines (X%) does not meet global threshold (80%)`,
check which file is dragging the global below 80 — it is likely in `src/lib/` or
`src/rules/`. Address it before merging.

- [ ] **Step 4: Run the full test suite without coverage to confirm no regressions**

```bash
npm test
```

Expected:
```
Test Files  128 passed (128)
Tests       2470 passed (2470)
```

(2465 original + 5 new = 2470)

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts
git commit -m "test: add layered coverage thresholds (global 80%, src/commands 85% lines)"
```

---

## Final Verification

- [ ] Run `npm test` — all tests pass (≥2470)
- [ ] Run `npm run test -- --coverage` — exits 0, no threshold errors
- [ ] Confirm `TESTING.md` exists at project root: `cat TESTING.md | head -1`
- [ ] Confirm `docs/plans/2026-05-16-test-coverage-improvement.md` is committed
