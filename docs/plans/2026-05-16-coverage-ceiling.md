# Coverage Ceiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push overall line coverage from 79% to ~85–88% by backfilling tests for the six lowest-coverage technically-testable files, then raising vitest thresholds to lock in the gains.

**Architecture:** Six independent test-addition tasks (Tasks 1–6) followed by a threshold-bump task (Task 7). Each task modifies exactly one existing test file and commits separately. Tasks 1–6 can be done in any order; Task 7 must be last.

**Tech Stack:** TypeScript, vitest 2.1.9, @vitest/coverage-v8. All tests use in-process patterns (no subprocess spawn). Tasks 1 uses `vi.spyOn` on `fs` exports. Task 2 adds a `vi.mock` for the keychain module to config.test.ts. Tasks 3–6 use the existing local `runCli()` helper pattern already established in each file.

---

## Hard Coverage Ceiling Reference

These areas are **deliberately excluded** — testing them requires live infrastructure:

| File | Coverage | Reason excluded |
|---|---|---|
| `src/sinks/mqtt/client.ts` | 1% | MQTT broker |
| `src/lib/llm/anthropic.ts` | 15% | Anthropic API |
| `src/lib/llm/openai.ts` | 15% | OpenAI API |
| `src/commands/rules.ts` simulate | — | Full engine simulation |
| `src/commands/install.ts` | — | OS privilege, already excluded |
| `src/commands/uninstall.ts` | — | OS privilege, already excluded |

---

## File Map

| File | Change |
|---|---|
| `tests/lib/plan-store.test.ts` | +4 tests after existing 3 |
| `tests/commands/config.test.ts` | +hoisted keychain mock + 3 tests |
| `tests/commands/doctor.test.ts` | +3 tests inside existing `describe('doctor command')` |
| `tests/commands/rules.test.ts` | +4 tests: 2 summary + 2 last-fired |
| `tests/commands/auth.test.ts` | +2 tests inside `describe('auth keychain migrate')` |
| `vitest.config.ts` | Bump thresholds 75% → 80% |

---

## Task 1: Backfill plan-store.ts (43% → ~80%)

**Files:**
- Modify: `tests/lib/plan-store.test.ts` — add 4 tests after the existing `describe('plan-store security')` block

**Background:** `plan-store.ts` has only 3 path-traversal security tests covering the input-validation guard. The actual write path (`savePlanRecord`), the "not found" error path (`updatePlanRecord`), and the directory-reading path (`listPlanRecords`) are completely uncovered.

- [ ] **Step 1: Open the file and locate the insertion point**

`tests/lib/plan-store.test.ts` currently ends at line 18 with `});`. Insert all new tests after that closing brace, still in the same file.

- [ ] **Step 2: Add the four new tests**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import {
  loadPlanRecord,
  updatePlanRecord,
  savePlanRecord,
  listPlanRecords,
  type PlanRecord,
} from '../../src/lib/plan-store.js';
import type { Plan } from '../../src/commands/plan.js';
```

**Note:** The existing file already imports `describe`, `it`, `expect` from `vitest` and imports `loadPlanRecord`/`updatePlanRecord`. You need to ADD the new imports `vi`, `afterEach`, `savePlanRecord`, `listPlanRecords`, `PlanRecord`, and `Plan` at the top of the file. Do not duplicate existing imports.

Then append the following after the existing `describe('plan-store security', ...)` block:

```ts
describe('plan-store write + list paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('savePlanRecord returns a pending record with a UUID v4 planId', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const plan: Plan = { version: '1.0', steps: [] };
    const record = savePlanRecord(plan);

    expect(record.status).toBe('pending');
    expect(record.plan).toBe(plan);
    expect(record.planId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
  });

  it('updatePlanRecord throws when the plan record does not exist on disk', () => {
    expect(() =>
      updatePlanRecord('00000000-0000-4000-8000-000000000001', { status: 'approved' }),
    ).toThrow(/not found/i);
  });

  it('listPlanRecords returns empty array when PLANS_DIR is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValueOnce(false);
    expect(listPlanRecords()).toEqual([]);
  });

  it('listPlanRecords returns records sorted oldest-first by createdAt', () => {
    const older: PlanRecord = {
      planId: '00000000-0000-4000-8000-000000000001',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'pending',
      plan: { version: '1.0', steps: [] },
    };
    const newer: PlanRecord = {
      planId: '00000000-0000-4000-8000-000000000002',
      createdAt: '2024-01-02T00:00:00Z',
      status: 'pending',
      plan: { version: '1.0', steps: [] },
    };

    vi.spyOn(fs, 'existsSync').mockReturnValueOnce(true);
    // readdirSync returns newer first to verify sorting is applied
    vi.spyOn(fs, 'readdirSync').mockReturnValueOnce(
      ['newer.json', 'older.json'] as unknown as ReturnType<typeof fs.readdirSync>,
    );
    vi.spyOn(fs, 'readFileSync')
      .mockReturnValueOnce(JSON.stringify(newer))
      .mockReturnValueOnce(JSON.stringify(older));

    const result = listPlanRecords();
    expect(result).toHaveLength(2);
    expect(result[0].planId).toBe(older.planId);
    expect(result[1].planId).toBe(newer.planId);
  });
});
```

- [ ] **Step 3: Run the test file**

```bash
npm test -- tests/lib/plan-store.test.ts
```

Expected: all 7 tests pass (3 original + 4 new).

- [ ] **Step 4: Commit**

```bash
git add tests/lib/plan-store.test.ts
git commit -m "test: backfill plan-store savePlanRecord, updatePlanRecord not-found, listPlanRecords paths"
```

---

## Task 2: Backfill config.ts platform hints (65% → ~78%)

**Files:**
- Modify: `tests/commands/config.test.ts` — add a keychain mock + 3 new tests

**Background:** `config.ts` lines 277–293 show a platform-specific keychain tip after `set-token` succeeds when the credential backend is `'file'`. The keychain store is loaded via a dynamic `await import()`. These three branches (darwin/win32, linux, and non-file backend → no tip) are completely uncovered.

- [ ] **Step 1: Add the keychain mock declaration**

At the top of `tests/commands/config.test.ts`, just before the existing `const configMock = vi.hoisted(...)` block, add:

```ts
const keychainMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/credentials/keychain.js', () => ({
  selectCredentialStore: keychainMock,
}));
```

The existing `configMock` block and `vi.mock('../../src/config.js', ...)` stay unchanged below it.

- [ ] **Step 2: Add the three platform hint tests**

Append the following new `describe` block at the end of the file (after the last existing `describe` block closes):

```ts
describe('set-token platform keychain hint', () => {
  let savedPlatformDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    // Reset configMock so set-token saves successfully
    configMock.saveConfig.mockReset();
    savedPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    // Default: backend is file so hints are eligible
    keychainMock.mockResolvedValue({
      name: 'file',
      describe: () => ({ backend: 'file', tag: 'file', writable: true }),
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    });
  });

  afterEach(() => {
    if (savedPlatformDescriptor) {
      Object.defineProperty(process, 'platform', savedPlatformDescriptor);
    }
  });

  it('emits native-keychain tip to stderr on darwin when backend is file', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      writable: false,
    });
    const res = await runCli(registerConfigCommand, ['config', 'set-token', 'T', 'S']);
    expect(res.exitCode).toBeNull();
    expect(res.stderr.join('\n')).toContain('native keychain');
  });

  it('emits GNOME Keyring tip to stderr on linux when backend is file', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
      writable: false,
    });
    const res = await runCli(registerConfigCommand, ['config', 'set-token', 'T', 'S']);
    expect(res.exitCode).toBeNull();
    expect(res.stderr.join('\n')).toContain('GNOME Keyring');
  });

  it('emits no keychain tip when the backend is not file', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      writable: false,
    });
    keychainMock.mockResolvedValue({
      name: 'keychain',
      describe: () => ({ backend: 'keychain', tag: 'keychain', writable: true }),
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    });
    const res = await runCli(registerConfigCommand, ['config', 'set-token', 'T', 'S']);
    expect(res.exitCode).toBeNull();
    expect(res.stderr.join('\n')).not.toContain('native keychain');
    expect(res.stderr.join('\n')).not.toContain('GNOME');
  });
});
```

**Important:** Make sure `beforeEach` and `afterEach` are imported in the existing import line at the top of the file if not already present.

- [ ] **Step 3: Run the test file**

```bash
npm test -- tests/commands/config.test.ts
```

Expected: all tests pass including the 3 new ones. The existing set-token tests must also still pass — the keychainMock is cleared between tests by `clearMocks: true` in vitest.config.ts, so existing tests that don't configure it see `keychainMock()` return `undefined`, which causes the `try/catch` in config.ts to silently skip the hint (correct behavior).

- [ ] **Step 4: Commit**

```bash
git add tests/commands/config.test.ts
git commit -m "test: backfill config set-token platform keychain hints (darwin, linux, non-file)"
```

---

## Task 3: Backfill doctor.ts human-mode output (71% → ~79%)

**Files:**
- Modify: `tests/commands/doctor.test.ts` — add 3 tests inside the existing `describe('doctor command')` block

**Background:** Every existing doctor test uses `--json`. Lines 1221–1227 (non-JSON `--list`) and 1302–1324 (non-JSON icon/summary output including `--quiet` suppression) are completely uncovered.

The `describe('doctor command')` block already has:
- `beforeEach` that deletes `SWITCHBOT_TOKEN`/`SWITCHBOT_SECRET`, mocks `os.homedir`, sets `SWITCHBOT_POLICY_PATH`
- `afterEach` that cleans up

All three new tests go inside that same describe block.

- [ ] **Step 1: Locate the insertion point**

Find the last `it(...)` test inside `describe('doctor command')` (currently at the bottom of the block). The new tests go after the last existing test but still inside the outer `describe` block.

- [ ] **Step 2: Add the three new tests**

```ts
  it('non-JSON --list prints "Available checks:" followed by check names', async () => {
    const res = await runCli(registerDoctorCommand, ['doctor', '--list']);
    expect(res.exitCode).toBeNull();
    const out = res.stdout.join('\n');
    expect(out).toContain('Available checks:');
    expect(out).toContain('credentials');
    expect(out).toContain('mcp');
    expect(out).toContain('catalog-schema');
  });

  it('non-JSON output shows icon (✓/!) per check and a summary line', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(
      registerDoctorCommand,
      ['doctor', '--section', 'catalog-schema,mcp'],
    );
    // human mode — no JSON parsing
    const out = res.stdout.join('\n');
    expect(out).toMatch(/[✓!✗]\s+catalog-schema/);
    expect(out).toMatch(/[✓!✗]\s+mcp/);
    expect(out).toMatch(/\d+ ok, \d+ warn, \d+ fail/);
  });

  it('--quiet suppresses ok checks but keeps failing checks and the summary', async () => {
    // No credentials → credentials check fails; catalog-schema does not need live API
    const res = await runCli(
      registerDoctorCommand,
      ['doctor', '--section', 'catalog-schema,credentials', '--quiet'],
    );
    const out = res.stdout.join('\n');
    // The credentials check line (fail/warn) must appear
    expect(out).toMatch(/[!✗]\s+credentials/);
    // The catalog-schema ok check must be suppressed
    expect(out).not.toMatch(/✓\s+catalog-schema/);
    // Summary is always shown
    expect(out).toMatch(/\d+ ok, \d+ warn, \d+ fail/);
  });
```

- [ ] **Step 3: Run the test file**

```bash
npm test -- tests/commands/doctor.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/doctor.test.ts
git commit -m "test: backfill doctor human-mode output: --list, icon format, --quiet suppression"
```

---

## Task 4: Backfill rules.ts summary + last-fired (57% → ~63%)

**Files:**
- Modify: `tests/commands/rules.test.ts` — add 4 tests at the end of the existing `describe('switchbot rules (commander surface)')` block

**Background:** `rules.ts` lines 800–868 contain the `summary` and `last-fired` subcommands. These are read-only audit-log queries that work fine with a non-existent log (they return empty state). No mocking needed — just pass `--file` pointing at a non-existent tmpDir path.

- [ ] **Step 1: Locate the insertion point**

In `tests/commands/rules.test.ts`, find the end of the outermost `describe('switchbot rules (commander surface)')` block. The existing `describe('rules doctor', ...)` block is the last nested describe. Insert two new `describe` blocks after it, still inside the outer describe.

- [ ] **Step 2: Add the four new tests**

```ts
  describe('rules summary', () => {
    it('returns total:0 and empty summaries under --json when log is absent', async () => {
      const logFile = path.join(tmpDir, 'noaudit.log');
      const res = await runCli(['--json', 'rules', 'summary', '--file', logFile]);
      expect(res.exitCode).toBe(0);
      const body = JSON.parse(res.stdout[0]) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(body, ['total', 'summaries']) as {
        total: number;
        summaries: unknown[];
      };
      expect(data.total).toBe(0);
      expect(data.summaries).toEqual([]);
    });

    it('prints "no rule activity" in human mode when log is absent', async () => {
      const logFile = path.join(tmpDir, 'noaudit.log');
      const res = await runCli(['rules', 'summary', '--file', logFile]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.join('\n')).toContain('no rule activity');
    });
  });

  describe('rules last-fired', () => {
    it('returns count:0 and empty entries under --json when log is absent', async () => {
      const logFile = path.join(tmpDir, 'noaudit.log');
      const res = await runCli(['--json', 'rules', 'last-fired', '--file', logFile]);
      expect(res.exitCode).toBe(0);
      const body = JSON.parse(res.stdout[0]) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(body, ['count', 'entries']) as {
        count: number;
        entries: unknown[];
      };
      expect(data.count).toBe(0);
      expect(data.entries).toEqual([]);
    });

    it('prints "no rule-fire entries" in human mode when log is absent', async () => {
      const logFile = path.join(tmpDir, 'noaudit.log');
      const res = await runCli(['rules', 'last-fired', '--file', logFile]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout.join('\n')).toContain('no rule-fire entries');
    });
  });
```

- [ ] **Step 3: Run the test file**

```bash
npm test -- tests/commands/rules.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/commands/rules.test.ts
git commit -m "test: backfill rules summary and last-fired empty-log paths"
```

---

## Task 5: Backfill auth.ts migrate error paths (65% → ~70%)

**Files:**
- Modify: `tests/commands/auth.test.ts` — add 2 tests inside the existing `describe('auth keychain migrate')` block (after the last existing test at ~line 340)

**Background:** `auth.ts` lines 339–344 (catch block when `store.set()` throws during migrate) and 352–353 (warning log when `--delete-file` cleanup fails) are uncovered.

The existing `describe('auth keychain migrate')` block already has a `beforeEach`/`afterEach` that sets up `tmpHome` as `process.env.HOME`, and `makeStore()` + `selectMock` are available at file scope.

- [ ] **Step 1: Add the two new tests inside `describe('auth keychain migrate')`**

```ts
  it('exits 1 when the keychain write fails during migrate', async () => {
    const store = makeStore({
      writable: true,
      setImpl: async () => {
        throw new Error('permission denied');
      },
    });
    selectMock.mockResolvedValue(store);

    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token: 't-src', secret: 's-src' }));

    const res = await runCli(['auth', 'keychain', 'migrate']);
    expect(res.exitCode).toBe(1);
    expect(res.stderr.join('\n')).toContain('keychain write failed');
  });

  it('exits 0 but logs a warning when --delete-file cleanup throws', async () => {
    const store = makeStore({ writable: true });
    selectMock.mockResolvedValue(store);

    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Only token+secret → no metadata → cleanup tries fs.unlinkSync
    fs.writeFileSync(file, JSON.stringify({ token: 't-src', secret: 's-src' }));

    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted');
    });
    try {
      const res = await runCli(['auth', 'keychain', 'migrate', '--delete-file']);
      expect(res.exitCode).toBe(0);
      expect(res.stderr.join('\n')).toContain('warning: could not remove');
    } finally {
      unlinkSpy.mockRestore();
    }
  });
```

- [ ] **Step 2: Run the test file**

```bash
npm test -- tests/commands/auth.test.ts
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/commands/auth.test.ts
git commit -m "test: backfill auth migrate keychain-write-fail and cleanup-warning paths"
```

---

## Task 6: Raise vitest coverage thresholds

**Files:**
- Modify: `vitest.config.ts`

Run coverage first to verify the new tests have pushed the numbers above the new targets before editing the config.

- [ ] **Step 1: Run coverage and inspect current numbers**

```bash
npm run test -- --coverage 2>&1 | grep -E "All files|src/commands"
```

Expected (approximate — exact numbers depend on which lines the new tests hit):

```
 src/commands      |   79.x |    78.x |  ...
All files          |   82.x |    80.x |  ...
```

If `src/commands` lines are below 78 or branches below 75, investigate which file is dragging it down before proceeding.

- [ ] **Step 2: Edit `vitest.config.ts` — update only the `thresholds` block**

Current content:

```ts
      thresholds: {
        lines: 75,
        branches: 75,
        'src/commands/**': {
          lines: 75,
          branches: 75,
        },
      },
```

Replace with:

```ts
      thresholds: {
        lines: 79,
        branches: 78,
        'src/commands/**': {
          lines: 78,
          branches: 76,
        },
      },
```

The comment block above `thresholds` should be updated to reflect current reality:

```ts
      // Thresholds locked to current actual coverage after 2026-05-16 backfill.
      // Raise incrementally: rules.ts (57%), mcp.ts (68%) still have room.
```

- [ ] **Step 3: Run coverage and confirm no threshold violations**

```bash
npm run test -- --coverage 2>&1 | tail -15
```

Expected: exits 0, no lines starting with `ERROR: Coverage for`.

If you see a threshold violation, check which specific file is below the threshold and either:
- Lower that specific threshold to match reality (with a comment explaining why), OR
- Add a targeted test to bring that file above the threshold

- [ ] **Step 4: Run the full test suite without coverage to confirm no regressions**

```bash
npm test
```

Expected: all tests pass, no failures.

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts
git commit -m "test: raise coverage thresholds to match post-backfill actuals"
```

---

## Final Verification

- [ ] Run `npm test` — all tests pass
- [ ] Run `npm run test -- --coverage` — exits 0, no threshold errors
- [ ] `src/commands` line coverage ≥ 78%
- [ ] Global line coverage ≥ 79%
- [ ] Confirm `docs/plans/2026-05-16-coverage-ceiling.md` is committed
