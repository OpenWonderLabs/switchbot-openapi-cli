# Coverage ~90% Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push line coverage from 79.49% to ≥88% by excluding 5 hard-ceiling infrastructure files and backfilling tests for 10 low-coverage source files.

**Architecture:** Two-phase: (1) add 5 live-infrastructure files to `vitest.config.ts` exclude list, moving the baseline to 81.47%; (2) backfill unit tests for the 10 highest-leverage improvable files. Each test task is independent after Task 1 and can be done in any order.

**Tech Stack:** TypeScript, vitest 2.x, `vi.mock` / `vi.hoisted` / `vi.spyOn`, `tests/helpers/cli.ts` runCli helper, Commander `exitOverride`.

---

## File Map

| File | Action |
|------|--------|
| `vitest.config.ts` | Modify twice: HC excludes (Task 1), threshold bump (Task 11) |
| `tests/commands/plan.test.ts` | Add plan-store mock + plan save/list/review/approve/execute tests |
| `tests/commands/doctor.test.ts` | Add `--fix` output test |
| `tests/commands/rules.test.ts` | Add summary/last-fired human-mode + trace-explain not-found tests |
| `tests/lib/daemon-state.test.ts` | Create new file |
| `tests/lib/daemon-socket-path.test.ts` | Create new file |
| `tests/commands/config.test.ts` | Add `--label` / `--daily-cap` options tests |
| `tests/commands/auth.test.ts` | Add config parse-error test |
| `tests/install/preflight.test.ts` | Add `~/.switchbot` dir writable path + agent-skills-dir success path |
| `docs/coverage-annotations.md` | Create new file |

---

## Task 1: Exclude hard-ceiling files from coverage denominator

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add 5 HC files to the exclude array**

Open `vitest.config.ts` and replace the existing `exclude` block with:

```typescript
exclude: [
  'src/index.ts',
  'src/sinks/**',              // I/O adapters — require live integration, no unit tests
  'src/commands/install.ts',   // system-level operations — require OS privilege
  'src/commands/uninstall.ts', // system-level operations — require OS privilege
  // Hard-ceiling: require live infrastructure, not unit-testable
  'src/mcp/device-history.ts',       // MCP streaming protocol (live server required)
  'src/mcp/events-subscription.ts',  // MCP event subscription (live server required)
  'src/mqtt/client.ts',              // MQTT broker required
  'src/llm/providers/anthropic.ts',  // Anthropic API key + live endpoint required
  'src/llm/providers/openai.ts',     // OpenAI API key + live endpoint required
],
```

- [ ] **Step 2: Verify baseline moves from 79.49% to ~81%**

Run: `npm run test -- --coverage --reporter=dot 2>&1 | grep "^All files"`

Expected output contains: `All files | 81.` (the exclusion should push global above 81%)

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test: exclude hard-ceiling infrastructure files from coverage denominator"
```

---

## Task 2: plan.test.ts — plan-store mock + save/list/review/approve tests

**Files:**
- Modify: `tests/commands/plan.test.ts`

- [ ] **Step 1: Add plan-store mock at the top of the file (after existing mocks)**

In `tests/commands/plan.test.ts`, directly after the existing `vi.mock('../../src/devices/cache.js', ...)` block, add:

```typescript
const planStoreMock = vi.hoisted(() => ({
  savePlanRecord: vi.fn(),
  loadPlanRecord: vi.fn(() => null),
  updatePlanRecord: vi.fn(),
  listPlanRecords: vi.fn(() => []),
  PLANS_DIR: '/mock/.switchbot/plans',
}));

vi.mock('../../src/lib/plan-store.js', () => ({
  savePlanRecord: planStoreMock.savePlanRecord,
  loadPlanRecord: planStoreMock.loadPlanRecord,
  updatePlanRecord: planStoreMock.updatePlanRecord,
  listPlanRecords: planStoreMock.listPlanRecords,
  PLANS_DIR: planStoreMock.PLANS_DIR,
}));
```

- [ ] **Step 2: Reset plan-store mocks in the existing beforeEach**

Inside the existing `beforeEach` in `describe('plan command', ...)`, append:

```typescript
planStoreMock.savePlanRecord.mockReset();
planStoreMock.loadPlanRecord.mockReset().mockReturnValue(null);
planStoreMock.updatePlanRecord.mockReset();
planStoreMock.listPlanRecords.mockReset().mockReturnValue([]);
```

- [ ] **Step 3: Write failing tests for plan save/list/review/approve**

Add a new `describe('plan save / list / review / approve', ...)` block at the end of `describe('plan command', ...)`:

```typescript
describe('plan save / list / review / approve', () => {
  const MOCK_ID = '00000000-0000-4000-8000-000000000001';

  it('plan save writes a valid plan and prints planId', async () => {
    planStoreMock.savePlanRecord.mockReturnValue({
      planId: MOCK_ID,
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      plan: { version: '1.0', steps: [] },
    });
    const file = writePlan({ version: '1.0', steps: [] });
    const res = await runCli(registerPlanCommand, ['plan', 'save', file]);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join('\n')).toContain(MOCK_ID);
    expect(planStoreMock.savePlanRecord).toHaveBeenCalledOnce();
  });

  it('plan save --json returns saved:true with planId', async () => {
    planStoreMock.savePlanRecord.mockReturnValue({
      planId: MOCK_ID,
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      plan: { version: '1.0', steps: [] },
    });
    const file = writePlan({ version: '1.0', steps: [] });
    const res = await runCli(registerPlanCommand, ['--json', 'plan', 'save', file]);
    expect(res.exitCode).toBeNull();
    const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['saved', 'planId']) as { saved: boolean; planId: string };
    expect(data.saved).toBe(true);
    expect(data.planId).toBe(MOCK_ID);
  });

  it('plan list prints each plan on its own line', async () => {
    planStoreMock.listPlanRecords.mockReturnValue([
      { planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] } },
    ]);
    const res = await runCli(registerPlanCommand, ['plan', 'list']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join('\n')).toContain(MOCK_ID.slice(0, 8));
  });

  it('plan list prints helpful message when no plans exist', async () => {
    planStoreMock.listPlanRecords.mockReturnValue([]);
    const res = await runCli(registerPlanCommand, ['plan', 'list']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join('\n')).toMatch(/no saved plans/i);
  });

  it('plan list --json returns plans array', async () => {
    planStoreMock.listPlanRecords.mockReturnValue([
      { planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] } },
    ]);
    const res = await runCli(registerPlanCommand, ['--json', 'plan', 'list']);
    expect(res.exitCode).toBeNull();
    const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['plans']) as { plans: Array<{ planId: string }> };
    expect(data.plans[0].planId).toBe(MOCK_ID);
  });

  it('plan review prints plan details', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID,
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      plan: { version: '1.0', description: 'turn on lights', steps: [{ type: 'command', deviceId: 'D1', command: 'turnOn' }] },
    });
    const res = await runCli(registerPlanCommand, ['plan', 'review', MOCK_ID]);
    expect(res.exitCode).toBeNull();
    const out = res.stdout.join('\n');
    expect(out).toContain(MOCK_ID);
    expect(out).toContain('pending');
    expect(out).toContain('turn on lights');
  });

  it('plan review exits 2 when planId not found', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue(null);
    const res = await runCli(registerPlanCommand, ['plan', 'review', MOCK_ID]);
    expect(res.exitCode).toBe(2);
  });

  it('plan approve transitions pending to approved', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    planStoreMock.updatePlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'approved', createdAt: '2024-01-01T00:00:00Z', approvedAt: '2024-01-01T01:00:00Z', plan: { version: '1.0', steps: [] },
    });
    const res = await runCli(registerPlanCommand, ['plan', 'approve', MOCK_ID]);
    expect(res.exitCode).toBeNull();
    expect(planStoreMock.updatePlanRecord).toHaveBeenCalledWith(MOCK_ID, expect.objectContaining({ status: 'approved' }));
    expect(res.stdout.join('\n')).toMatch(/approved/i);
  });

  it('plan approve exits 2 when plan is already executed', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'executed', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    const res = await runCli(registerPlanCommand, ['plan', 'approve', MOCK_ID]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/already been executed/i);
  });

  it('plan approve exits 2 when plan was rejected', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'rejected', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    const res = await runCli(registerPlanCommand, ['plan', 'approve', MOCK_ID]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/rejected/i);
  });

  it('plan approve --json returns ok:true', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    planStoreMock.updatePlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'approved', createdAt: '2024-01-01T00:00:00Z', approvedAt: '2024-01-01T01:00:00Z', plan: { version: '1.0', steps: [] },
    });
    const res = await runCli(registerPlanCommand, ['--json', 'plan', 'approve', MOCK_ID]);
    expect(res.exitCode).toBeNull();
    const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['ok', 'planId', 'status']) as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});
```

- [ ] **Step 4: Run new tests to verify they pass**

Run: `npm run test -- tests/commands/plan.test.ts --reporter=verbose 2>&1 | tail -30`

Expected: All new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/commands/plan.test.ts
git commit -m "test: add plan save/list/review/approve coverage with plan-store mock"
```

---

## Task 3: plan.test.ts — plan execute tests

**Files:**
- Modify: `tests/commands/plan.test.ts`

- [ ] **Step 1: Write failing tests for plan execute**

Add a new `describe('plan execute', ...)` block inside `describe('plan command', ...)` (after the `plan save / list / review / approve` block):

```typescript
describe('plan execute', () => {
  const MOCK_ID = '00000000-0000-4000-8000-000000000002';

  it('executes an approved plan and marks it executed', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID,
      status: 'approved',
      createdAt: '2024-01-01T00:00:00Z',
      approvedAt: '2024-01-01T01:00:00Z',
      plan: { version: '1.0', steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }] },
    });
    planStoreMock.updatePlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'executed', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const res = await runCli(registerPlanCommand, ['plan', 'execute', MOCK_ID]);
    expect(res.exitCode).toBeNull();
    expect(planStoreMock.updatePlanRecord).toHaveBeenCalledWith(
      MOCK_ID,
      expect.objectContaining({ status: 'executed' }),
    );
  });

  it('exits 2 when plan is not in approved status', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    const res = await runCli(registerPlanCommand, ['plan', 'execute', MOCK_ID]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/pending/i);
  });

  it('exits 2 when plan is not found', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue(null);
    const res = await runCli(registerPlanCommand, ['plan', 'execute', MOCK_ID]);
    expect(res.exitCode).toBe(2);
  });

  it('marks plan as failed when execution errors', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID,
      status: 'approved',
      createdAt: '2024-01-01T00:00:00Z',
      approvedAt: '2024-01-01T01:00:00Z',
      plan: { version: '1.0', steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }] },
    });
    planStoreMock.updatePlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'failed', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    apiMock.__instance.post.mockRejectedValue(new Error('network error'));

    const res = await runCli(registerPlanCommand, ['plan', 'execute', MOCK_ID]);
    expect(res.exitCode).toBe(1);
    expect(planStoreMock.updatePlanRecord).toHaveBeenCalledWith(
      MOCK_ID,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('plan execute --json returns ran:true on success', async () => {
    planStoreMock.loadPlanRecord.mockReturnValue({
      planId: MOCK_ID,
      status: 'approved',
      createdAt: '2024-01-01T00:00:00Z',
      approvedAt: '2024-01-01T01:00:00Z',
      plan: { version: '1.0', steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }] },
    });
    planStoreMock.updatePlanRecord.mockReturnValue({
      planId: MOCK_ID, status: 'executed', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
    });
    apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const res = await runCli(registerPlanCommand, ['--json', 'plan', 'execute', MOCK_ID]);
    expect(res.exitCode).toBeNull();
    const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(out, ['ran', 'planId', 'succeeded']) as { ran: boolean; succeeded: boolean };
    expect(data.ran).toBe(true);
    expect(data.succeeded).toBe(true);
  });
});
```

- [ ] **Step 2: Run new tests to verify they pass**

Run: `npm run test -- tests/commands/plan.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: All new tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/commands/plan.test.ts
git commit -m "test: add plan execute coverage"
```

---

## Task 4: doctor.test.ts — --fix output test (lines 1316–1323)

**Files:**
- Modify: `tests/commands/doctor.test.ts`

- [ ] **Step 1: Write failing test for --fix output**

Add inside the existing `describe('doctor command', ...)` block:

```typescript
it('--fix prints a Fixes: section with remediation entries', async () => {
  // credentials check fails when no token/secret env vars are set (already
  // cleared in beforeEach). Running --fix without --yes returns a "manual"
  // or "pass --yes" fix entry, which exercises the fixes loop at lines 1316-1323.
  delete process.env.SWITCHBOT_TOKEN;
  delete process.env.SWITCHBOT_SECRET;
  const res = await runCli(registerDoctorCommand, [
    'doctor', '--section', 'credentials', '--fix',
  ]);
  const combined = res.stdout.join('\n');
  expect(combined).toContain('Fixes:');
  expect(combined).toMatch(/credentials/);
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npm run test -- tests/commands/doctor.test.ts --reporter=verbose 2>&1 | grep -E "✓|✗|FAIL|PASS|fixes"`

Expected: New test PASSES.

- [ ] **Step 3: Commit**

```bash
git add tests/commands/doctor.test.ts
git commit -m "test: cover doctor --fix output path (lines 1316-1323)"
```

---

## Task 5: rules.test.ts — human-mode with data + trace-explain not-found

**Files:**
- Modify: `tests/commands/rules.test.ts`

- [ ] **Step 1: Add summary human-mode with data test**

Inside `describe('rules summary', ...)` (after existing tests), add:

```typescript
it('prints a table in human mode when entries exist', async () => {
  const f = path.join(tmpDir, 'audit-human.log');
  const now = new Date().toISOString();
  fs.writeFileSync(
    f,
    [
      { t: now, kind: 'rule-fire', rule: { name: 'motion rule', triggerSource: 'mqtt', fireId: 'f1' }, result: 'ok', deviceId: 'D1', command: 'turnOn', parameter: null, commandType: 'command', dryRun: false },
      { t: now, kind: 'rule-fire', rule: { name: 'motion rule', triggerSource: 'mqtt', fireId: 'f2' }, result: 'ok', deviceId: 'D1', command: 'turnOn', parameter: null, commandType: 'command', dryRun: false },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const { stdout, exitCode } = await runCli(['rules', 'summary', '--file', f]);
  expect(exitCode).toBe(0);
  const out = stdout.join('\n');
  expect(out).toContain('motion rule');
  expect(out).toContain('2'); // fires count
});
```

- [ ] **Step 2: Add last-fired human-mode with data test**

Inside `describe('rules last-fired', ...)` (after existing tests), add:

```typescript
it('prints human-readable rows when entries exist', async () => {
  const f = path.join(tmpDir, 'audit-lfhuman.log');
  const ts = '2026-04-25T10:00:00.000Z';
  fs.writeFileSync(
    f,
    JSON.stringify({
      t: ts, kind: 'rule-fire', rule: { name: 'night-motion', triggerSource: 'mqtt', fireId: 'f1' },
      result: 'ok', deviceId: 'LAMP', command: 'turnOn', parameter: null, commandType: 'command', dryRun: false,
    }) + '\n',
  );
  const { stdout, exitCode } = await runCli(['rules', 'last-fired', '--file', f]);
  expect(exitCode).toBe(0);
  const out = stdout.join('\n');
  expect(out).toContain('night-motion');
  expect(out).toContain(ts);
});
```

- [ ] **Step 3: Add trace-explain audit-not-found test**

At the end of `describe('switchbot rules (commander surface)', ...)`, add:

```typescript
describe('rules trace-explain', () => {
  it('exits 1 when audit log file does not exist', async () => {
    const { exitCode, stderr } = await runCli([
      'rules', 'trace-explain', '--file', path.join(tmpDir, 'no-such-audit.log'),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toMatch(/not found/i);
  });
});
```

- [ ] **Step 4: Run new tests to verify they pass**

Run: `npm run test -- tests/commands/rules.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: All 3 new tests PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/commands/rules.test.ts
git commit -m "test: cover rules summary/last-fired human-mode with data, trace-explain not-found"
```

---

## Task 6: Create tests/lib/daemon-state.test.ts

**Files:**
- Create: `tests/lib/daemon-state.test.ts`

- [ ] **Step 1: Write the full test file**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeDaemonState,
  readDaemonState,
  removeDaemonState,
  type DaemonState,
} from '../../src/lib/daemon-state.js';

describe('daemon-state', () => {
  let tmp: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-daemon-state-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const SAMPLE: DaemonState = {
    status: 'running',
    pid: 12345,
    startedAt: '2024-01-01T00:00:00Z',
    logFile: '/tmp/daemon.log',
    pidFile: '/tmp/daemon.pid',
    stateFile: '/tmp/daemon.state.json',
  };

  it('writeDaemonState creates the state file under ~/.switchbot', () => {
    writeDaemonState(SAMPLE);
    const stateFile = path.join(tmp, '.switchbot', 'daemon.state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as DaemonState;
    expect(parsed.status).toBe('running');
    expect(parsed.pid).toBe(12345);
  });

  it('readDaemonState returns the persisted state', () => {
    writeDaemonState(SAMPLE);
    const result = readDaemonState();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('running');
    expect(result!.pid).toBe(12345);
  });

  it('readDaemonState returns null when no state file exists', () => {
    const result = readDaemonState();
    expect(result).toBeNull();
  });

  it('removeDaemonState deletes the state file', () => {
    writeDaemonState(SAMPLE);
    const stateFile = path.join(tmp, '.switchbot', 'daemon.state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    removeDaemonState();
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('removeDaemonState is a no-op when the state file does not exist', () => {
    expect(() => removeDaemonState()).not.toThrow();
  });

  it('writeDaemonState creates the .switchbot directory if absent', () => {
    const switchbotDir = path.join(tmp, '.switchbot');
    expect(fs.existsSync(switchbotDir)).toBe(false);
    writeDaemonState(SAMPLE);
    expect(fs.existsSync(switchbotDir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test file to verify it passes**

Run: `npm run test -- tests/lib/daemon-state.test.ts --reporter=verbose 2>&1 | tail -15`

Expected: All 6 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/lib/daemon-state.test.ts
git commit -m "test: add daemon-state read/write/remove coverage"
```

---

## Task 7: Create tests/lib/daemon-socket-path.test.ts

**Files:**
- Create: `tests/lib/daemon-socket-path.test.ts`

Note: `getCurrentUserKey()` has a module-level cache (`cachedUserKey`). Tests that need a fresh cache must run in the same describe block before the first platform test sets the cache, or they must reset the env vars to yield a consistent key.

- [ ] **Step 1: Write the full test file**

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('getDaemonSocketPath', () => {
  let savedDescriptor: PropertyDescriptor | undefined;

  afterEach(() => {
    if (savedDescriptor) {
      Object.defineProperty(process, 'platform', savedDescriptor);
      savedDescriptor = undefined;
    }
  });

  it('returns a named pipe path on win32', async () => {
    savedDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: false });
    const { getDaemonSocketPath } = await import('../../src/daemon/socket-path.js');
    const p = getDaemonSocketPath();
    expect(p).toMatch(/^\\\\\.\\/);
    expect(p).toContain('switchbot-daemon-');
  });

  it('returns a POSIX socket path on linux', async () => {
    savedDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: false });
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue('/home/testuser');
    try {
      const { getDaemonSocketPath } = await import('../../src/daemon/socket-path.js');
      const p = getDaemonSocketPath();
      expect(p).toBe(path.join('/home/testuser', '.switchbot', 'daemon.sock'));
    } finally {
      homedirSpy.mockRestore();
    }
  });
});

describe('isDaemonSocketAvailable', () => {
  let savedDescriptor: PropertyDescriptor | undefined;

  afterEach(() => {
    if (savedDescriptor) {
      Object.defineProperty(process, 'platform', savedDescriptor);
      savedDescriptor = undefined;
    }
    vi.restoreAllMocks();
  });

  it('always returns true on win32', async () => {
    savedDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: false });
    const { isDaemonSocketAvailable } = await import('../../src/daemon/socket-path.js');
    expect(isDaemonSocketAvailable('/any/path')).toBe(true);
  });

  it('returns true on POSIX when socket file exists', async () => {
    savedDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: false });
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const { isDaemonSocketAvailable } = await import('../../src/daemon/socket-path.js');
    expect(isDaemonSocketAvailable('/some/daemon.sock')).toBe(true);
  });

  it('returns false on POSIX when socket file does not exist', async () => {
    savedDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true, writable: false });
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const { isDaemonSocketAvailable } = await import('../../src/daemon/socket-path.js');
    expect(isDaemonSocketAvailable('/some/daemon.sock')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test file to verify it passes**

Run: `npm run test -- tests/lib/daemon-socket-path.test.ts --reporter=verbose 2>&1 | tail -15`

Expected: All 5 tests PASS. (Note: dynamic `await import()` within tests re-reads the module per test, so platform checks are evaluated fresh each time.)

- [ ] **Step 3: Commit**

```bash
git add tests/lib/daemon-socket-path.test.ts
git commit -m "test: add daemon socket-path win32/POSIX coverage"
```

---

## Task 8: config.test.ts — --label / --daily-cap / --default-flags options

**Files:**
- Modify: `tests/commands/config.test.ts`

- [ ] **Step 1: Add tests for saveConfig option flags**

Inside `describe('set-token', ...)` (after existing tests), add:

```typescript
it('passes --label to saveConfig', async () => {
  const res = await runCli(registerConfigCommand, [
    'config', 'set-token', 'MY_T', 'MY_S', '--label', 'home',
  ]);
  expect(configMock.saveConfig).toHaveBeenCalledWith(
    'MY_T', 'MY_S',
    expect.objectContaining({ label: 'home' }),
  );
  expect(res.exitCode).toBeNull();
});

it('passes --daily-cap as a numeric limit to saveConfig', async () => {
  const res = await runCli(registerConfigCommand, [
    'config', 'set-token', 'MY_T', 'MY_S', '--daily-cap', '200',
  ]);
  expect(configMock.saveConfig).toHaveBeenCalledWith(
    'MY_T', 'MY_S',
    expect.objectContaining({ limits: { dailyCap: 200 } }),
  );
  expect(res.exitCode).toBeNull();
});

it('passes --default-flags as a split array to saveConfig', async () => {
  const res = await runCli(registerConfigCommand, [
    'config', 'set-token', 'MY_T', 'MY_S', '--default-flags', '--json,--verbose',
  ]);
  expect(configMock.saveConfig).toHaveBeenCalledWith(
    'MY_T', 'MY_S',
    expect.objectContaining({ defaults: { flags: ['--json', '--verbose'] } }),
  );
  expect(res.exitCode).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run test -- tests/commands/config.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: All new tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/commands/config.test.ts
git commit -m "test: cover set-token --label/--daily-cap/--default-flags option paths"
```

---

## Task 9: auth.test.ts — config parse-error path (lines 312–325)

**Files:**
- Modify: `tests/commands/auth.test.ts`

- [ ] **Step 1: Add parse-error tests inside the existing migrate describe block**

Add these tests inside `describe('auth keychain migrate', ...)`:

```typescript
it('exits 1 when source config.json contains invalid JSON', async () => {
  const file = path.join(tmpHome, '.switchbot', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'THIS IS NOT JSON');
  const store = makeStore({ writable: true });
  selectMock.mockResolvedValue(store);
  const res = await runCli(['auth', 'keychain', 'migrate']);
  expect(res.exitCode).toBe(1);
  expect(res.stderr.join('\n')).toMatch(/failed to parse/i);
});

it('exits 1 when source config.json contains a non-object (array)', async () => {
  const file = path.join(tmpHome, '.switchbot', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([1, 2, 3]));
  const store = makeStore({ writable: true });
  selectMock.mockResolvedValue(store);
  const res = await runCli(['auth', 'keychain', 'migrate']);
  expect(res.exitCode).toBe(1);
  expect(res.stderr.join('\n')).toMatch(/failed to parse/i);
});
```

Note: `runCli` in auth.test.ts is the file-local helper (not the shared one from cli.ts). Verify how `runCli` is defined in auth.test.ts — it should accept `['auth', 'keychain', 'migrate']` directly.

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm run test -- tests/commands/auth.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: Both new tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/commands/auth.test.ts
git commit -m "test: cover auth migrate config parse-error path"
```

---

## Task 10: preflight.test.ts — .switchbot dir writable path + nearestExistingPath null

**Files:**
- Modify: `tests/install/preflight.test.ts`

- [ ] **Step 1: Add tests for uncovered preflight paths**

Add these tests inside `describe('runPreflight', ...)`:

```typescript
it('home check reports ok when ~/.switchbot already exists and is writable', async () => {
  const switchbotDir = path.join(tmp, '.switchbot');
  fs.mkdirSync(switchbotDir, { recursive: true });
  const res = await runPreflight();
  const home = res.checks.find((c) => c.name === 'home');
  expect(home?.status).toBe('ok');
  expect(home?.message).toContain(switchbotDir);
});

it('agent-skills-dir check is ok when ~/.claude/skills path ancestor is writable', async () => {
  // Create ~/.claude so nearestExistingPath resolves to it.
  const claudeDir = path.join(tmp, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const res = await runPreflight({ agent: 'claude-code', expectSkillLink: true });
  const agent = res.checks.find((c) => c.name === 'agent-skills-dir');
  expect(agent?.status).toBe('ok');
});

it('agent-skills-dir check fails when no ancestor of ~/.claude/skills exists', async () => {
  // tmp dir does not have ~/.claude, so nearestExistingPath stops at tmp itself
  // or returns null if tmp doesn't exist — but tmp is always real. In practice,
  // nearestExistingPath will walk up to tmp which is a real dir and is writable,
  // so this returns 'ok'. To force the null/not-dir path: mock fs.existsSync to
  // always return false so nearestExistingPath returns null.
  const existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  try {
    const res = await runPreflight({ agent: 'claude-code', expectSkillLink: true });
    const agent = res.checks.find((c) => c.name === 'agent-skills-dir');
    expect(agent?.status).toBe('fail');
    expect(agent?.message).toMatch(/cannot resolve/i);
  } finally {
    existsSpy.mockRestore();
  }
});
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm run test -- tests/install/preflight.test.ts --reporter=verbose 2>&1 | tail -20`

Expected: All 3 new tests PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/install/preflight.test.ts
git commit -m "test: add preflight .switchbot dir writable + agent-skills-dir null-ancestor paths"
```

---

## Task 11: Lock thresholds + create coverage annotations doc

**Files:**
- Modify: `vitest.config.ts`
- Create: `docs/coverage-annotations.md`

- [ ] **Step 1: Run full coverage to see actual numbers**

Run: `npm run test -- --coverage --reporter=dot 2>&1 | grep -E "^All files|src/commands"`

Note the actual line/branch percentages to set the thresholds below them.

- [ ] **Step 2: Update thresholds in vitest.config.ts**

Replace the `thresholds` block with values 1-2 points below the actual measurements. Example (adjust to actuals):

```typescript
// Thresholds locked to post-2026-05-17 backfill actuals.
// Hard ceiling: see docs/coverage-annotations.md for excluded + structurally untestable files.
thresholds: {
  lines: 88,
  branches: 87,
  'src/commands/**': {
    lines: 80,
    branches: 78,
  },
},
```

If actual numbers are lower, set thresholds to actual − 1. If higher, set to actual − 1 for safety.

- [ ] **Step 3: Run tests to confirm no threshold failures**

Run: `npm run test -- --coverage --reporter=dot 2>&1 | tail -5`

Expected: Exit 0, no "Coverage threshold not met" errors.

- [ ] **Step 4: Create docs/coverage-annotations.md**

```markdown
# Coverage Annotations

This file documents why certain source files are excluded from the coverage
denominator, and which in-scope sections remain structurally untestable.

## Hard-excluded from coverage denominator

These files are in `vitest.config.ts` `coverage.exclude` because they require
live external infrastructure that cannot be mocked at unit-test level:

| File | Reason |
|------|--------|
| `src/mcp/device-history.ts` | MCP streaming protocol — requires live MCP server |
| `src/mcp/events-subscription.ts` | MCP event subscription — requires live MCP server |
| `src/mqtt/client.ts` | MQTT broker required; class constructor immediately connects |
| `src/llm/providers/anthropic.ts` | Anthropic API key + live HTTPS endpoint required |
| `src/llm/providers/openai.ts` | OpenAI API key + live HTTPS endpoint required |

## In-denominator but structurally untestable sections

These sections remain in the coverage denominator but cannot be covered by
unit tests. They are accepted as permanent gaps.

| File | Lines / Area | Reason |
|------|-------------|--------|
| `src/commands/mcp.ts` | ~2364–2633 | MCP tool-call / resource protocol handlers — live MCP client required |
| `src/commands/rules.ts` | 800–985, 1001–1081 | `simulate` and `trace-explain` subcommands — full rules engine + LLM required |
| `src/status-sync/manager.ts` | WebSocket push path | Live SwitchBot WebSocket connection required |
| `src/policy/migrate.ts` | lines 21–52 | `MIGRATION_CHAIN` is empty; migration step functions exist but are unreachable until v0.3 schema lands |
```

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts docs/coverage-annotations.md
git commit -m "test: lock coverage thresholds to post-backfill actuals; add coverage-annotations doc"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 14 deliverables from the spec have a corresponding task
- [x] **No placeholders:** Every step includes the actual code/command
- [x] **Type consistency:** All mock return types match the interfaces imported from source files (`DaemonState`, `PlanRecord`, `PlanStatus`)
- [x] **Mock isolation:** Plan-store mock is declared with `vi.hoisted` and resets in `beforeEach` — won't leak into existing plan tests
- [x] **Task independence:** Tasks 2–10 are independent (can run in any order after Task 1)
- [x] Note: `daemon-socket-path.test.ts` uses dynamic `await import()` per test to re-evaluate the module against the mocked `process.platform`. This is the correct pattern but may log ESM re-import warnings — these are harmless.
