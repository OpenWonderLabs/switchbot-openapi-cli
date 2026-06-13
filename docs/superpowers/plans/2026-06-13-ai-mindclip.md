# AI MindClip + Account Cache Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI MindClip device support (catalog entry + 7 CLI subcommands) and fix the three in-memory caches that persist stale data when switching accounts.

**Architecture:** Three independent parts — (A) catalog entry, (B) new `mindclip` command group with lib + commands files, (C) minimal cache-clear exports added to the credential priming module and wired into both credential-save paths. Part C is done first because it's the smallest and its tests establish the `clearPrimedCredentials` export that later tasks depend on.

**Tech Stack:** TypeScript, Commander.js, Vitest, Axios (via `createClient()`), Node.js 20+

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/credentials/prime.ts` | MODIFY | Export `clearPrimedCredentials()` for production cache reset |
| `src/commands/auth.ts` | MODIFY | Call `clearPrimedCredentials()` + `idempotencyCache.clear()` after login |
| `src/commands/config.ts` | MODIFY | Call all 4 cache-clear functions after `set-token` |
| `src/utils/arg-parsers.ts` | MODIFY | Add `dateArg()` and `weekArg()` validators |
| `src/devices/catalog.ts` | MODIFY | Add AI MindClip entry (read-only, 5 status fields) |
| `src/lib/mindclip.ts` | CREATE | 7 async API helper functions for MindClip endpoints |
| `src/commands/mindclip.ts` | CREATE | 7 CLI subcommands with validation and help text |
| `src/program-builder.ts` | MODIFY | Import + register mindclip; add to `TOP_LEVEL_COMMANDS` |
| `tests/credentials/prime.test.ts` | MODIFY | Add test for `clearPrimedCredentials()` |
| `tests/utils/arg-parsers.test.ts` | MODIFY | Add `dateArg` and `weekArg` describe blocks |
| `tests/devices/mindclip-catalog.test.ts` | CREATE | Verify AI MindClip catalog entry fields |
| `tests/lib/mindclip.test.ts` | CREATE | Unit tests for 7 API helpers (mocked HTTP) |
| `tests/commands/mindclip.test.ts` | CREATE | Validation + action smoke tests |

---

## Task 1: Export clearPrimedCredentials + add test

**Files:**
- Modify: `src/credentials/prime.ts` (add one export after line 72)
- Modify: `tests/credentials/prime.test.ts` (add one `it` block + import)

- [ ] **Step 1: Add the failing test**

Open `tests/credentials/prime.test.ts`. Add `clearPrimedCredentials` to the import at line 6, then add this test inside the existing `describe('primeCredentials', ...)` block:

```typescript
// Change line 6 from:
import {
  primeCredentials,
  getPrimedCredentials,
  __resetPrimedCredentials,
} from '../../src/credentials/prime.js';

// To:
import {
  primeCredentials,
  getPrimedCredentials,
  clearPrimedCredentials,
  __resetPrimedCredentials,
} from '../../src/credentials/prime.js';
```

Add this test inside the `describe` block (after line 93):

```typescript
  it('clearPrimedCredentials() clears the in-memory cache immediately', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')).not.toBeNull();

    clearPrimedCredentials();
    expect(getPrimedCredentials('default')).toBeNull();
  });
```

- [ ] **Step 2: Run the failing test**

```
npx vitest run tests/credentials/prime.test.ts
```

Expected: FAIL — `clearPrimedCredentials is not exported`

- [ ] **Step 3: Add the export to prime.ts**

Open `src/credentials/prime.ts`. After the `__resetPrimedCredentials` function (line 70), add:

```typescript
/**
 * Production helper — called by auth and config commands after saving new
 * credentials to ensure the 5-second priming cache does not serve stale
 * token/secret from the previous account.
 */
export function clearPrimedCredentials(): void {
  cache = null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```
npx vitest run tests/credentials/prime.test.ts
```

Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/credentials/prime.ts tests/credentials/prime.test.ts
git commit -m "feat: export clearPrimedCredentials for cache reset on account switch"
```

---

## Task 2: Fix auth.ts + config.ts cache leaks

**Files:**
- Modify: `src/commands/auth.ts` (around line 455–456)
- Modify: `src/commands/config.ts` (around line 257)

- [ ] **Step 1: Update auth.ts**

`src/commands/auth.ts` already imports `clearCache, clearStatusCache` at line 28. Add two more imports:

```typescript
// After line 33 (import { verifyCredentials } from '../auth/verify.js'):
import { clearPrimedCredentials } from '../credentials/prime.js';
import { idempotencyCache } from '../lib/idempotency.js';
```

Find the block around line 452–456 that reads:

```typescript
      clearCache();
      clearStatusCache();
```

Replace with:

```typescript
      clearCache();
      clearStatusCache();
      clearPrimedCredentials();
      idempotencyCache.clear();
```

- [ ] **Step 2: Update config.ts**

`src/commands/config.ts` currently has no cache-clear imports. Add four imports after the existing imports at the top of the file (after line 10):

```typescript
import { clearCache, clearStatusCache } from '../devices/cache.js';
import { clearPrimedCredentials } from '../credentials/prime.js';
import { idempotencyCache } from '../lib/idempotency.js';
```

Find the `saveConfig(...)` call around line 257. After that call, add:

```typescript
      saveConfig(token, secret, {
        label: options.label,
        description: options.description,
        limits: options.dailyCap ? { dailyCap: Number.parseInt(options.dailyCap, 10) } : undefined,
        defaults: options.defaultFlags
          ? {
              flags: options.defaultFlags
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : undefined,
      });
      clearCache();
      clearStatusCache();
      clearPrimedCredentials();
      idempotencyCache.clear();
```

- [ ] **Step 3: Run the full test suite to confirm no regressions**

```
npx vitest run tests/credentials/ tests/lib/idempotency.test.ts
```

Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add src/commands/auth.ts src/commands/config.ts
git commit -m "fix: clear priming and idempotency caches on account credential change"
```

---

## Task 3: Add dateArg + weekArg validators

**Files:**
- Modify: `src/utils/arg-parsers.ts` (add two exports at the end)
- Modify: `tests/utils/arg-parsers.test.ts` (add two describe blocks)

- [ ] **Step 1: Write the failing tests**

Add to the **end** of `tests/utils/arg-parsers.test.ts`:

```typescript
describe('dateArg', () => {
  const parse = dateArg('--date');

  it('accepts valid YYYY-MM-DD dates', () => {
    expect(parse('2026-06-13')).toBe('2026-06-13');
    expect(parse('2026-01-01')).toBe('2026-01-01');
    expect(parse('2026-12-31')).toBe('2026-12-31');
  });

  it('rejects dates with wrong separator', () => {
    expect(() => parse('2026/06/13')).toThrow(InvalidArgumentError);
    expect(() => parse('2026/06/13')).toThrow(/YYYY-MM-DD/);
  });

  it('rejects American date format', () => {
    expect(() => parse('06-13-2026')).toThrow(/YYYY-MM-DD/);
  });

  it('rejects impossible calendar dates', () => {
    expect(() => parse('2026-02-30')).toThrow(/YYYY-MM-DD/);
    expect(() => parse('2026-13-01')).toThrow(/YYYY-MM-DD/);
  });

  it('rejects flag-like tokens', () => {
    expect(() => parse('--help')).toThrow(/YYYY-MM-DD/);
  });
});

describe('weekArg', () => {
  const parse = weekArg('--week');

  it('accepts valid ISO week strings W01-W53', () => {
    expect(parse('2026-W23')).toBe('2026-W23');
    expect(parse('2026-W01')).toBe('2026-W01');
    expect(parse('2026-W53')).toBe('2026-W53');
    expect(parse('2026-W09')).toBe('2026-W09');
  });

  it('rejects W00 (week 0 does not exist)', () => {
    expect(() => parse('2026-W00')).toThrow(InvalidArgumentError);
    expect(() => parse('2026-W00')).toThrow(/YYYY-Www/);
  });

  it('rejects W54 and above', () => {
    expect(() => parse('2026-W54')).toThrow(/YYYY-Www/);
    expect(() => parse('2026-W99')).toThrow(/YYYY-Www/);
  });

  it('rejects missing dash between year and W', () => {
    expect(() => parse('2026W23')).toThrow(/YYYY-Www/);
  });

  it('rejects 2-digit years', () => {
    expect(() => parse('26-W23')).toThrow(/YYYY-Www/);
  });

  it('rejects single-digit week', () => {
    expect(() => parse('2026-W5')).toThrow(/YYYY-Www/);
  });
});
```

Update the import at the top of `tests/utils/arg-parsers.test.ts` to include the two new functions:

```typescript
import { intArg, durationArg, stringArg, enumArg, dateArg, weekArg } from '../../src/utils/arg-parsers.js';
```

- [ ] **Step 2: Run the failing tests**

```
npx vitest run tests/utils/arg-parsers.test.ts
```

Expected: FAIL — `dateArg is not exported`, `weekArg is not exported`

- [ ] **Step 3: Implement dateArg and weekArg in arg-parsers.ts**

Add to the **end** of `src/utils/arg-parsers.ts`:

```typescript
export function dateArg(flagName: string): (value: string) => string {
  return (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
      throw new InvalidArgumentError(
        `${flagName} must be in YYYY-MM-DD format (got "${value}")`,
      );
    }
    return value;
  };
}

export function weekArg(flagName: string): (value: string) => string {
  return (value: string) => {
    if (!/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(value)) {
      throw new InvalidArgumentError(
        `${flagName} must be in YYYY-Www format, weeks 01–53 (e.g. 2026-W23 — got "${value}")`,
      );
    }
    return value;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run tests/utils/arg-parsers.test.ts
```

Expected: PASS (all describe blocks)

- [ ] **Step 5: Commit**

```bash
git add src/utils/arg-parsers.ts tests/utils/arg-parsers.test.ts
git commit -m "feat: add dateArg and weekArg validators for YYYY-MM-DD and YYYY-Www formats"
```

---

## Task 4: Add AI MindClip to device catalog

**Files:**
- Create: `tests/devices/mindclip-catalog.test.ts`
- Modify: `src/devices/catalog.ts` (add one entry to the `DEVICE_CATALOG` array)

- [ ] **Step 1: Write the failing test**

Create `tests/devices/mindclip-catalog.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { DEVICE_CATALOG } from '../../src/devices/catalog.js';

describe('AI MindClip catalog entry', () => {
  const entry = DEVICE_CATALOG.find((e) => e.type === 'AI MindClip');

  it('has a catalog entry', () => {
    expect(entry).toBeDefined();
  });

  it('is read-only (no control commands)', () => {
    expect(entry?.readOnly).toBe(true);
    expect(entry?.commands).toEqual([]);
  });

  it('has the correct category and role', () => {
    expect(entry?.category).toBe('physical');
    expect(entry?.role).toBe('other');
  });

  it('has all 5 status fields in the correct order', () => {
    expect(entry?.statusFields).toEqual([
      'battery',
      'chargingStatus',
      'recordingStatus',
      'uploadStatus',
      'hasUntransferredFiles',
    ]);
  });
});
```

- [ ] **Step 2: Run the failing test**

```
npx vitest run tests/devices/mindclip-catalog.test.ts
```

Expected: FAIL — `entry` is `undefined`

- [ ] **Step 3: Add AI MindClip to catalog.ts**

Open `src/devices/catalog.ts` and find the `DEVICE_CATALOG` array. Locate the entry for `'AI Hub'` or similar read-only device (for reference). Add the following entry in alphabetical order (near the top of the array or with other `A` entries):

```typescript
  {
    type: 'AI MindClip',
    category: 'physical',
    description: 'AI-powered voice recorder with transcription and meeting summaries.',
    role: 'other',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'chargingStatus', 'recordingStatus', 'uploadStatus', 'hasUntransferredFiles'],
  },
```

- [ ] **Step 4: Run the test to verify it passes**

```
npx vitest run tests/devices/mindclip-catalog.test.ts
```

Expected: PASS (4 tests)

- [ ] **Step 5: Run existing catalog tests to confirm no regressions**

```
npx vitest run tests/devices/
```

Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/devices/catalog.ts tests/devices/mindclip-catalog.test.ts
git commit -m "feat: add AI MindClip read-only device to catalog with 5 status fields"
```

---

## Task 5: Create src/lib/mindclip.ts

**Files:**
- Create: `src/lib/mindclip.ts`
- Create: `tests/lib/mindclip.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/mindclip.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listRecordings,
  getRecording,
  getSummary,
  listTodos,
  getDailyRecall,
  getWeeklySummary,
  getUrgentTodos,
} from '../../src/lib/mindclip.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn() };
  return { createClient: vi.fn(() => instance), __instance: instance };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
}));

beforeEach(() => {
  apiMock.__instance.get.mockReset();
});

// ---------------------------------------------------------------------------
// listRecordings
// ---------------------------------------------------------------------------
describe('listRecordings', () => {
  it('calls GET /v1.1/mindclip/recordings and returns body', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { list: [] } } });
    const result = await listRecordings({});
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings', { params: {} });
    expect(result).toEqual({ list: [] });
  });

  it('passes deviceID, page, and size params', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listRecordings({ deviceID: 'DEV1', pageNum: 2, pageSize: 10 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings', {
      params: { deviceID: 'DEV1', pageNum: 2, pageSize: 10 },
    });
  });

  it('passes startTime, endTime, and folderID params', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listRecordings({ startTime: 1000, endTime: 2000, folderID: 3 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings', {
      params: { startTime: 1000, endTime: 2000, folderID: 3 },
    });
  });

  it('omits undefined params from the request', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listRecordings({ pageNum: 1 });
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('deviceID');
    expect(params).not.toHaveProperty('startTime');
    expect(params).not.toHaveProperty('folderID');
  });
});

// ---------------------------------------------------------------------------
// getRecording
// ---------------------------------------------------------------------------
describe('getRecording', () => {
  it('calls GET /v1.1/mindclip/recordings/{id}', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { id: 'r1' } } });
    const result = await getRecording('r1');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings/r1', { params: {} });
    expect(result).toEqual({ id: 'r1' });
  });

  it('includes language param when provided', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getRecording('r1', 'zh');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings/r1', {
      params: { language: 'zh' },
    });
  });

  it('omits language param when undefined', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getRecording('r1');
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('language');
  });
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------
describe('getSummary', () => {
  it('calls GET /v1.1/mindclip/summaries/{id}', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { summary: 'ok' } } });
    const result = await getSummary('s1');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/summaries/s1', { params: {} });
    expect(result).toEqual({ summary: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// listTodos
// ---------------------------------------------------------------------------
describe('listTodos', () => {
  it('calls GET /v1.1/mindclip/todos and returns body', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { items: [] } } });
    const result = await listTodos({});
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/todos', { params: {} });
    expect(result).toEqual({ items: [] });
  });

  it('passes completedNum and category filters', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listTodos({ completedNum: 1, category: 2, pageNum: 1, pageSize: 20 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/todos', {
      params: { completedNum: 1, category: 2, pageNum: 1, pageSize: 20 },
    });
  });

  it('passes device and file filters', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listTodos({ deviceID: 'D1', fileID: 'F1', startTime: 100, endTime: 200 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/todos', {
      params: { deviceID: 'D1', fileID: 'F1', startTime: 100, endTime: 200 },
    });
  });

  it('omits undefined params', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listTodos({ completedNum: 0 });
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('deviceID');
    expect(params).not.toHaveProperty('fileID');
    expect(params).not.toHaveProperty('startTime');
  });
});

// ---------------------------------------------------------------------------
// getDailyRecall
// ---------------------------------------------------------------------------
describe('getDailyRecall', () => {
  it('calls GET /v1.1/mindclip/assistant/daily with date param', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getDailyRecall('2026-06-13');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/assistant/daily', {
      params: { date: '2026-06-13' },
    });
  });

  it('omits date param when undefined (server uses its own default)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getDailyRecall();
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('date');
  });
});

// ---------------------------------------------------------------------------
// getWeeklySummary
// ---------------------------------------------------------------------------
describe('getWeeklySummary', () => {
  it('calls GET /v1.1/mindclip/assistant/weekly with week param', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getWeeklySummary('2026-W23');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/assistant/weekly', {
      params: { week: '2026-W23' },
    });
  });

  it('omits week param when undefined', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getWeeklySummary();
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('week');
  });
});

// ---------------------------------------------------------------------------
// getUrgentTodos
// ---------------------------------------------------------------------------
describe('getUrgentTodos', () => {
  it('calls GET /v1.1/mindclip/assistant/urgent-todos with date param', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getUrgentTodos('2026-06-12');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/assistant/urgent-todos', {
      params: { date: '2026-06-12' },
    });
  });

  it('omits date param when undefined (server defaults to yesterday)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getUrgentTodos();
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('date');
  });
});
```

- [ ] **Step 2: Run the failing tests**

```
npx vitest run tests/lib/mindclip.test.ts
```

Expected: FAIL — `Cannot find module '../../src/lib/mindclip.js'`

- [ ] **Step 3: Implement src/lib/mindclip.ts**

Create `src/lib/mindclip.ts`:

```typescript
import { createClient } from '../api/client.js';

export interface ListRecordingsParams {
  deviceID?: string;
  pageNum?: number;
  pageSize?: number;
  startTime?: number;
  endTime?: number;
  folderID?: number;
}

export interface ListTodosParams {
  completedNum?: number;
  pageNum?: number;
  pageSize?: number;
  deviceID?: string;
  fileID?: string;
  startTime?: number;
  endTime?: number;
  category?: number;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export async function listRecordings(params: ListRecordingsParams): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/recordings', {
    params: compact(params as Record<string, unknown>),
  });
  return res.data.body;
}

export async function getRecording(id: string, language?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(`/v1.1/mindclip/recordings/${id}`, {
    params: compact({ language }),
  });
  return res.data.body;
}

export async function getSummary(id: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(`/v1.1/mindclip/summaries/${id}`, { params: {} });
  return res.data.body;
}

export async function listTodos(params: ListTodosParams): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/todos', {
    params: compact(params as Record<string, unknown>),
  });
  return res.data.body;
}

export async function getDailyRecall(date?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/daily', {
    params: compact({ date }),
  });
  return res.data.body;
}

export async function getWeeklySummary(week?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/weekly', {
    params: compact({ week }),
  });
  return res.data.body;
}

export async function getUrgentTodos(date?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/urgent-todos', {
    params: compact({ date }),
  });
  return res.data.body;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run tests/lib/mindclip.test.ts
```

Expected: PASS (all describe blocks, ~16 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mindclip.ts tests/lib/mindclip.test.ts
git commit -m "feat: add MindClip API helper functions for 7 custom endpoints"
```

---

## Task 6: Create src/commands/mindclip.ts

**Files:**
- Create: `src/commands/mindclip.ts`
- Create: `tests/commands/mindclip.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/commands/mindclip.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerMindclipCommand } from '../../src/commands/mindclip.js';

// Mock the mindclip lib so action handlers don't make real HTTP calls.
const mindclipMock = vi.hoisted(() => ({
  listRecordings: vi.fn().mockResolvedValue({}),
  getRecording: vi.fn().mockResolvedValue({}),
  getSummary: vi.fn().mockResolvedValue({}),
  listTodos: vi.fn().mockResolvedValue({}),
  getDailyRecall: vi.fn().mockResolvedValue({}),
  getWeeklySummary: vi.fn().mockResolvedValue({}),
  getUrgentTodos: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../src/lib/mindclip.js', () => mindclipMock);
vi.mock('../../src/utils/output.js', () => ({
  printJson: vi.fn(),
  isJsonMode: vi.fn(() => false),
  exitWithError: vi.fn((opts) => { throw new Error(typeof opts === 'string' ? opts : opts.message); }),
}));

function buildProgram(): Command {
  const program = new Command().exitOverride();
  registerMindclipCommand(program);
  return program;
}

beforeEach(() => {
  Object.values(mindclipMock).forEach((fn) => fn.mockClear());
});

// ---------------------------------------------------------------------------
// recordings validation
// ---------------------------------------------------------------------------
describe('mindclip recordings validation', () => {
  it('rejects --page 0 (must be >= 1)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--page', '0']),
    ).toThrow();
  });

  it('rejects --size 0', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--size', '0']),
    ).toThrow();
  });

  it('rejects --size 101', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--size', '101']),
    ).toThrow();
  });

  it('rejects --start with negative value', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'recordings', '--start', '-1']),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// todos validation
// ---------------------------------------------------------------------------
describe('mindclip todos validation', () => {
  it('rejects --completed 3 (only 0, 1, 2 allowed)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'todos', '--completed', '3']),
    ).toThrow();
  });

  it('rejects --category 6 (max is 5)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'todos', '--category', '6']),
    ).toThrow();
  });

  it('rejects --category negative', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'todos', '--category', '-1']),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// daily / weekly / urgent-todos validation
// ---------------------------------------------------------------------------
describe('mindclip date validation', () => {
  it('rejects --date in MM-DD-YYYY format', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'daily', '--date', '06-13-2026']),
    ).toThrow();
  });

  it('rejects --date with slashes', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'urgent-todos', '--date', '2026/06/13']),
    ).toThrow();
  });

  it('rejects --week without dash (2026W23)', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'weekly', '--week', '2026W23']),
    ).toThrow();
  });

  it('rejects --week W00', () => {
    expect(() =>
      buildProgram().parse(['node', 'sw', 'mindclip', 'weekly', '--week', '2026-W00']),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// action handler smoke tests (valid args call the right lib function)
// ---------------------------------------------------------------------------
describe('mindclip action handlers', () => {
  it('recordings with no options calls listRecordings with empty params', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'recordings']);
    expect(mindclipMock.listRecordings).toHaveBeenCalledOnce();
    const params = mindclipMock.listRecordings.mock.calls[0][0];
    expect(Object.keys(params).length).toBe(0);
  });

  it('recording <id> calls getRecording with id', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'recording', 'abc123']);
    expect(mindclipMock.getRecording).toHaveBeenCalledWith('abc123', undefined);
  });

  it('recording <id> --language en calls getRecording with language', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'recording', 'abc123', '--language', 'en']);
    expect(mindclipMock.getRecording).toHaveBeenCalledWith('abc123', 'en');
  });

  it('summary <id> calls getSummary', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'summary', 's1']);
    expect(mindclipMock.getSummary).toHaveBeenCalledWith('s1');
  });

  it('todos --completed 1 calls listTodos with completedNum 1', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'todos', '--completed', '1']);
    const params = mindclipMock.listTodos.mock.calls[0][0];
    expect(params.completedNum).toBe(1);
  });

  it('daily --date 2026-06-10 calls getDailyRecall with that date', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'daily', '--date', '2026-06-10']);
    expect(mindclipMock.getDailyRecall).toHaveBeenCalledWith('2026-06-10');
  });

  it('daily with no date calls getDailyRecall with undefined', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'daily']);
    expect(mindclipMock.getDailyRecall).toHaveBeenCalledWith(undefined);
  });

  it('weekly --week 2026-W23 calls getWeeklySummary', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'weekly', '--week', '2026-W23']);
    expect(mindclipMock.getWeeklySummary).toHaveBeenCalledWith('2026-W23');
  });

  it('urgent-todos with no date calls getUrgentTodos with undefined (server defaults to yesterday)', async () => {
    await buildProgram().parseAsync(['node', 'sw', 'mindclip', 'urgent-todos']);
    expect(mindclipMock.getUrgentTodos).toHaveBeenCalledWith(undefined);
  });
});
```

- [ ] **Step 2: Run the failing tests**

```
npx vitest run tests/commands/mindclip.test.ts
```

Expected: FAIL — `Cannot find module '../../src/commands/mindclip.js'`

- [ ] **Step 3: Implement src/commands/mindclip.ts**

Create `src/commands/mindclip.ts`:

```typescript
import { Command } from 'commander';
import { intArg, enumArg, stringArg, dateArg, weekArg } from '../utils/arg-parsers.js';
import { isJsonMode, printJson } from '../utils/output.js';
import {
  listRecordings,
  getRecording,
  getSummary,
  listTodos,
  getDailyRecall,
  getWeeklySummary,
  getUrgentTodos,
} from '../lib/mindclip.js';

export function registerMindclipCommand(program: Command): void {
  const mindclip = program
    .command('mindclip')
    .description('Access AI MindClip recordings, summaries, and to-dos')
    .addHelpText(
      'after',
      `
Subcommands:
  recordings      List recordings across all AI MindClip devices
  recording <id>  Get a single recording's metadata and transcript
  summary <id>    Get AI summary for a recording
  todos           List AI-extracted to-do items
  daily           Get daily recall summary
  weekly          Get weekly summary
  urgent-todos    Get urgent to-dos for a date

Examples:
  switchbot mindclip recordings --device AABBCCDDEEFF --size 10
  switchbot mindclip todos --completed 1
  switchbot mindclip daily --date 2026-06-10
  switchbot mindclip weekly`,
    );

  // recordings
  mindclip
    .command('recordings')
    .description('List recordings for AI MindClip devices')
    .option('--device <id>', 'Filter by device ID', stringArg('--device'))
    .option('--page <n>', 'Page number (>= 1)', intArg('--page', { min: 1 }))
    .option('--size <n>', 'Results per page (1-100)', intArg('--size', { min: 1, max: 100 }))
    .option('--start <ms>', 'Start timestamp in milliseconds', intArg('--start', { min: 0 }))
    .option('--end <ms>', 'End timestamp in milliseconds', intArg('--end', { min: 0 }))
    .option('--folder <n>', 'Folder ID', intArg('--folder', { min: 0 }))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip recordings
  switchbot mindclip recordings --device AABBCCDDEEFF --page 2 --size 10`,
    )
    .action(async (options) => {
      const params = Object.fromEntries(
        Object.entries({
          deviceID: options.device,
          pageNum: options.page !== undefined ? Number(options.page) : undefined,
          pageSize: options.size !== undefined ? Number(options.size) : undefined,
          startTime: options.start !== undefined ? Number(options.start) : undefined,
          endTime: options.end !== undefined ? Number(options.end) : undefined,
          folderID: options.folder !== undefined ? Number(options.folder) : undefined,
        }).filter(([, v]) => v !== undefined),
      );
      const data = await listRecordings(params);
      printJson(data);
    });

  // recording
  mindclip
    .command('recording <id>')
    .description('Get details of a single recording')
    .option('--language <lang>', 'Language code for response (e.g. en, zh)', stringArg('--language'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip recording 5f3a1c2e9b7d
  switchbot mindclip recording 5f3a1c2e9b7d --language en`,
    )
    .action(async (id: string, options) => {
      const data = await getRecording(id, options.language);
      printJson(data);
    });

  // summary
  mindclip
    .command('summary <id>')
    .description('Get AI summary and transcription for a recording')
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip summary 5f3a1c2e9b7d`,
    )
    .action(async (id: string) => {
      const data = await getSummary(id);
      printJson(data);
    });

  // todos
  mindclip
    .command('todos')
    .description('List AI-extracted to-do items')
    .option(
      '--completed <n>',
      'Filter: 0=all, 1=incomplete, 2=completed [default: 0]',
      enumArg('--completed', ['0', '1', '2']),
    )
    .option('--page <n>', 'Page number (>= 1)', intArg('--page', { min: 1 }))
    .option('--size <n>', 'Results per page (1-100)', intArg('--size', { min: 1, max: 100 }))
    .option('--device <id>', 'Filter by device ID', stringArg('--device'))
    .option('--file <id>', 'Filter by recording file ID', intArg('--file', { min: 0 }))
    .option('--start <ms>', 'Start timestamp in milliseconds', intArg('--start', { min: 0 }))
    .option('--end <ms>', 'End timestamp in milliseconds', intArg('--end', { min: 0 }))
    .option(
      '--category <n>',
      'Category: 0=any, 1=work, 2=life, 3=hobby, 4=holiday, 5=other',
      intArg('--category', { min: 0, max: 5 }),
    )
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip todos
  switchbot mindclip todos --completed 1 --size 5
  switchbot mindclip todos --category 1`,
    )
    .action(async (options) => {
      const params = Object.fromEntries(
        Object.entries({
          completedNum: options.completed !== undefined ? Number(options.completed) : undefined,
          pageNum: options.page !== undefined ? Number(options.page) : undefined,
          pageSize: options.size !== undefined ? Number(options.size) : undefined,
          deviceID: options.device,
          fileID: options.file !== undefined ? String(options.file) : undefined,
          startTime: options.start !== undefined ? Number(options.start) : undefined,
          endTime: options.end !== undefined ? Number(options.end) : undefined,
          category: options.category !== undefined ? Number(options.category) : undefined,
        }).filter(([, v]) => v !== undefined),
      );
      const data = await listTodos(params);
      printJson(data);
    });

  // daily
  mindclip
    .command('daily')
    .description('Get daily recall summary (omit --date to get the most recent)')
    .option('--date <YYYY-MM-DD>', 'Date [default: most recent record on server]', dateArg('--date'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip daily
  switchbot mindclip daily --date 2026-06-10`,
    )
    .action(async (options) => {
      const data = await getDailyRecall(options.date);
      printJson(data);
    });

  // weekly
  mindclip
    .command('weekly')
    .description('Get weekly summary (omit --week to get the most recent)')
    .option('--week <YYYY-Www>', 'ISO week [default: most recent record on server]', weekArg('--week'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip weekly
  switchbot mindclip weekly --week 2026-W23`,
    )
    .action(async (options) => {
      const data = await getWeeklySummary(options.week);
      printJson(data);
    });

  // urgent-todos
  mindclip
    .command('urgent-todos')
    .description("Get urgent to-dos for a date (omit --date to use yesterday's)")
    .option('--date <YYYY-MM-DD>', 'Date [default: yesterday on server]', dateArg('--date'))
    .addHelpText(
      'after',
      `
Examples:
  switchbot mindclip urgent-todos
  switchbot mindclip urgent-todos --date 2026-06-10`,
    )
    .action(async (options) => {
      const data = await getUrgentTodos(options.date);
      printJson(data);
    });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```
npx vitest run tests/commands/mindclip.test.ts
```

Expected: PASS (all describe blocks, ~22 tests)

- [ ] **Step 5: Commit**

```bash
git add src/commands/mindclip.ts tests/commands/mindclip.test.ts
git commit -m "feat: add mindclip command group with 7 subcommands and option validation"
```

---

## Task 7: Register mindclip command in program-builder.ts

**Files:**
- Modify: `src/program-builder.ts` (add import + registration + constant entry)

- [ ] **Step 1: Update program-builder.ts**

Add the import after the `registerCodexCommand` import (line 33):

```typescript
import { registerMindclipCommand } from './commands/mindclip.js';
```

Add `'mindclip'` to the `TOP_LEVEL_COMMANDS` tuple (line 39–44):

```typescript
export const TOP_LEVEL_COMMANDS = [
  'config', 'devices', 'scenes', 'webhook', 'completion', 'mcp',
  'quota', 'catalog', 'cache', 'events', 'doctor', 'schema',
  'history', 'plan', 'capabilities', 'agent-bootstrap', 'install', 'uninstall', 'status-sync',
  'health', 'upgrade-check', 'daemon', 'reset', 'codex', 'claude-code', 'gemini', 'mindclip',
] as const;
```

Find the `buildProgram` function and add the registration call alongside the others (alphabetically by command name or at the end of the register block):

```typescript
registerMindclipCommand(program);
```

- [ ] **Step 2: Verify help output**

```
npx ts-node --esm src/main.ts mindclip --help
```

Expected output contains:

```
Usage: switchbot mindclip [options] [command]

Access AI MindClip recordings, summaries, and to-dos

Commands:
  recordings      List recordings for AI MindClip devices
  recording       Get details of a single recording
  summary         Get AI summary and transcription for a recording
  todos           List AI-extracted to-do items
  daily           Get daily recall summary (omit --date to get the most recent)
  weekly          Get weekly summary (omit --week to get the most recent)
  urgent-todos    Get urgent to-dos for a date (omit --date to use yesterday's)
```

- [ ] **Step 3: Run the full test suite**

```
npx vitest run
```

Expected: all tests pass, no regressions

- [ ] **Step 4: Commit**

```bash
git add src/program-builder.ts
git commit -m "feat: register mindclip command group in program builder"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Covered by task |
|---|---|
| AI MindClip in device catalog (read-only, 5 status fields) | Task 4 |
| `listRecordings` with optional deviceID, pagination, time range, folder | Task 5 |
| `getRecording` with optional language | Task 5 |
| `getSummary` | Task 5 |
| `listTodos` with completedNum, pagination, device, file, time, category | Task 5 |
| `getDailyRecall` — no client-side default, server decides | Task 5 |
| `getWeeklySummary` — no client-side default | Task 5 |
| `getUrgentTodos` — no client-side default | Task 5 |
| CLI: 7 subcommands with correct signatures | Task 6 |
| `--completed` accepts 0/1/2 only | Task 6 |
| `--category` accepts 0–5 only | Task 6 |
| `--date` validates YYYY-MM-DD | Tasks 3 + 6 |
| `--week` validates YYYY-Www W01–W53 | Tasks 3 + 6 |
| Help text with examples on every subcommand | Task 6 |
| `clearPrimedCredentials()` exported from prime.ts | Task 1 |
| `auth login` clears priming + idempotency cache | Task 2 |
| `config set-token` clears all 4 caches | Task 2 |
| `mindclip` registered in program-builder + TOP_LEVEL_COMMANDS | Task 7 |

### Type consistency

- `listTodos` receives `fileID` as `string | undefined` (the API field is a string ID). In the command handler, `options.file` is an integer string validated by `intArg('--file', {min:0})`, then converted to a string via `String(options.file)` before passing to `listTodos`. This matches `ListTodosParams.fileID?: string`.
- All numeric options use `Number(options.x)` conversion in action handlers since Commander's `argParser` returns a `string`.
- `compact` in `lib/mindclip.ts` correctly removes `undefined` keys before the request is built.
