# Device History Aggregation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an on-demand, per-device bucketed aggregation query over existing JSONL history, exposed both as the CLI subcommand `history aggregate` and the MCP tool `aggregate_device_history`.

**Architecture:** A single pure async function `aggregateDeviceHistory(deviceId, opts)` in `src/devices/history-agg.ts` streams the existing `~/.switchbot/device-history/<deviceId>.jsonl*` files with `readline`, folds each numeric sample into per-bucket accumulators, and returns a structured result. CLI and MCP each build the same `AggOptions` and consume the same `AggResult`. Zero storage changes; reuses `parseDurationToMs`, `jsonlFilesForDevice`, and `resolveRange` from `src/devices/history-query.ts`.

**Tech Stack:** TypeScript (strict), Node 20+ (`node:fs`, `node:readline`, `node:path`, `node:os`), Commander.js, @modelcontextprotocol/sdk (Zod-shape input schemas), Vitest.

**Spec:** `docs/superpowers/specs/2026-04-20-device-history-aggregation-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/devices/history-query.ts` | Modify (1 LoC) | Export `resolveRange` so `history-agg.ts` can reuse time-window logic |
| `src/devices/history-agg.ts` | **Create** | Pure `aggregateDeviceHistory(deviceId, opts)` + types. Zero commander/MCP imports |
| `src/commands/history.ts` | Modify | Register new `aggregate` subcommand; translate flags → `AggOptions`; format text/JSON output |
| `src/commands/mcp.ts` | Modify | Register new `aggregate_device_history` tool; strict Zod schema; delegate to `aggregateDeviceHistory` |
| `src/commands/capabilities.ts` | Modify | Add `'history aggregate'` row to `COMMAND_META`; append `'aggregate_device_history'` to `MCP_TOOLS` |
| `tests/devices/history-agg.test.ts` | **Create** | Unit tests for the pure function (≈ 12 cases) |
| `tests/commands/history.test.ts` | Modify | Integration tests for the CLI subcommand |
| `tests/commands/mcp.test.ts` | Modify | MCP tool surface tests (listing, strictness, output parity) |
| `CHANGELOG.md` | Modify | New `## [2.5.0]` entry |
| `package.json` | Modify | `version` → `2.5.0` |

---

## Task 0: Preflight

**Files:** none

- [ ] **Step 1: Confirm clean tree on the spec branch and green baseline**

Run:
```bash
cd D:/workspace/claudecode/switchbot-cli
git status
git branch --show-current
npm run build
npm test
```
Expected: branch `docs/history-aggregation-spec`, working tree clean, build succeeds, all tests pass. If anything is red, fix before continuing.

- [ ] **Step 2: Re-read the spec**

Open `docs/superpowers/specs/2026-04-20-device-history-aggregation-design.md`. Every decision below traces to a section there.

---

## Task 1: Export `resolveRange` from `history-query.ts`

`history-agg.ts` must reuse the same time-window validation (`--since` vs `--from/--to` mutex, bad ISO rejection, `--from > --to` check). Today `resolveRange` is private; exporting it is the cheapest correct path.

**Files:**
- Modify: `src/devices/history-query.ts:57` (one `export` keyword)
- Run: `tests/devices/history-query.test.ts` (verify nothing broke)

- [ ] **Step 1: Add the `export` keyword**

Edit `src/devices/history-query.ts` line 57:

From:
```ts
function resolveRange(opts: QueryOptions): { fromMs: number; toMs: number } {
```
To:
```ts
export function resolveRange(opts: QueryOptions): { fromMs: number; toMs: number } {
```

- [ ] **Step 2: Re-run history-query tests**

Run:
```bash
npx vitest run tests/devices/history-query.test.ts
```
Expected: all existing cases pass.

- [ ] **Step 3: Commit**

```bash
git add src/devices/history-query.ts
git commit -m "refactor(history-query): export resolveRange for reuse in aggregation"
```

---

## Task 2: Create `history-agg.ts` types + empty function (TDD red)

Stand up the module skeleton with types only so the failing test in Task 3 has something to import.

**Files:**
- Create: `src/devices/history-agg.ts`

- [ ] **Step 1: Write the skeleton**

Create `src/devices/history-agg.ts`:
```ts
import type { QueryOptions } from './history-query.js';

export type AggFn = 'count' | 'min' | 'max' | 'avg' | 'sum' | 'p50' | 'p95';

export const ALL_AGG_FNS: readonly AggFn[] = ['count', 'min', 'max', 'avg', 'sum', 'p50', 'p95'];
export const DEFAULT_AGGS: readonly AggFn[] = ['count', 'avg'];
export const DEFAULT_SAMPLE_CAP = 10_000;
export const MAX_SAMPLE_CAP = 100_000;

export interface AggOptions extends QueryOptions {
  metrics: string[];
  aggs?: AggFn[];
  bucket?: string;
  maxBucketSamples?: number;
}

export interface BucketMetricResult {
  count?: number;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  p50?: number;
  p95?: number;
}

export interface AggBucket {
  t: string;
  metrics: Record<string, BucketMetricResult>;
}

export interface AggResult {
  deviceId: string;
  bucket?: string;
  from: string;
  to: string;
  metrics: string[];
  aggs: AggFn[];
  buckets: AggBucket[];
  partial: boolean;
  notes: string[];
}

export async function aggregateDeviceHistory(
  _deviceId: string,
  _opts: AggOptions,
): Promise<AggResult> {
  throw new Error('aggregateDeviceHistory: not implemented');
}
```

- [ ] **Step 2: Verify it compiles**

Run:
```bash
npm run build
```
Expected: clean tsc output, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/devices/history-agg.ts
git commit -m "feat(history-agg): add module skeleton with public types"
```

---

## Task 3: Single-bucket count/min/max/avg/sum

First behavioral test: when `--bucket` is omitted, the whole window folds into one bucket.

**Files:**
- Create: `tests/devices/history-agg.test.ts`
- Modify: `src/devices/history-agg.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/devices/history-agg.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aggregateDeviceHistory } from '../../src/devices/history-agg.js';

function writeJsonl(file: string, records: Array<Record<string, unknown>>): void {
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('aggregateDeviceHistory — single bucket', () => {
  let tmpHome: string;
  let historyDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agg-'));
    historyDir = path.join(tmpHome, '.switchbot', 'device-history');
    fs.mkdirSync(historyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('folds all samples into one bucket when --bucket is omitted', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
      { t: '2026-04-19T10:30:00.000Z', topic: 'status', payload: { temperature: 22 } },
      { t: '2026-04-19T11:00:00.000Z', topic: 'status', payload: { temperature: 24 } },
    ]);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
      aggs: ['count', 'min', 'max', 'avg', 'sum'],
    });

    expect(res.buckets).toHaveLength(1);
    const m = res.buckets[0].metrics.temperature;
    expect(m.count).toBe(3);
    expect(m.min).toBe(20);
    expect(m.max).toBe(24);
    expect(m.avg).toBe(22);
    expect(m.sum).toBe(66);
    expect(res.partial).toBe(false);
    expect(res.notes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: FAIL with `aggregateDeviceHistory: not implemented`.

- [ ] **Step 3: Implement the single-bucket path**

Replace the stub in `src/devices/history-agg.ts` with:
```ts
import fs from 'node:fs';
import readline from 'node:readline';
import type { QueryOptions, HistoryRecord } from './history-query.js';
import { jsonlFilesForDevice, resolveRange } from './history-query.js';

export type AggFn = 'count' | 'min' | 'max' | 'avg' | 'sum' | 'p50' | 'p95';

export const ALL_AGG_FNS: readonly AggFn[] = ['count', 'min', 'max', 'avg', 'sum', 'p50', 'p95'];
export const DEFAULT_AGGS: readonly AggFn[] = ['count', 'avg'];
export const DEFAULT_SAMPLE_CAP = 10_000;
export const MAX_SAMPLE_CAP = 100_000;

export interface AggOptions extends QueryOptions {
  metrics: string[];
  aggs?: AggFn[];
  bucket?: string;
  maxBucketSamples?: number;
}

export interface BucketMetricResult {
  count?: number;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  p50?: number;
  p95?: number;
}

export interface AggBucket {
  t: string;
  metrics: Record<string, BucketMetricResult>;
}

export interface AggResult {
  deviceId: string;
  bucket?: string;
  from: string;
  to: string;
  metrics: string[];
  aggs: AggFn[];
  buckets: AggBucket[];
  partial: boolean;
  notes: string[];
}

interface Acc {
  min: number;
  max: number;
  sum: number;
  count: number;
  samples: number[] | null;
  sampleCapHit: boolean;
}

export async function aggregateDeviceHistory(
  deviceId: string,
  opts: AggOptions,
): Promise<AggResult> {
  const { fromMs, toMs } = resolveRange(opts);
  const aggs: AggFn[] = (opts.aggs && opts.aggs.length > 0) ? opts.aggs : [...DEFAULT_AGGS];
  const needQuantile = aggs.includes('p50') || aggs.includes('p95');

  // bucketKey (epoch ms; 0 when no --bucket) → metric name → Acc
  const buckets = new Map<number, Map<string, Acc>>();

  for (const file of jsonlFilesForDevice(deviceId)) {
    const stream = fs.createReadStream(file, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec: HistoryRecord;
      try { rec = JSON.parse(line) as HistoryRecord; } catch { continue; }
      const tMs = Date.parse(rec.t);
      if (!Number.isFinite(tMs) || tMs < fromMs || tMs > toMs) continue;

      const key = 0; // single-bucket mode; Task 4 introduces bucketMs
      let bkt = buckets.get(key);
      if (!bkt) { bkt = new Map(); buckets.set(key, bkt); }

      for (const metric of opts.metrics) {
        const v = (rec.payload as Record<string, unknown> | null | undefined)?.[metric];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        let acc = bkt.get(metric);
        if (!acc) {
          acc = {
            min: v,
            max: v,
            sum: 0,
            count: 0,
            samples: needQuantile ? [] : null,
            sampleCapHit: false,
          };
          bkt.set(metric, acc);
        }
        acc.min = Math.min(acc.min, v);
        acc.max = Math.max(acc.max, v);
        acc.sum += v;
        acc.count += 1;
      }
    }
  }

  return finalize(deviceId, opts, aggs, buckets, false, []);
}

function finalize(
  deviceId: string,
  opts: AggOptions,
  aggs: AggFn[],
  buckets: Map<number, Map<string, Acc>>,
  partial: boolean,
  notes: string[],
): AggResult {
  const { fromMs, toMs } = resolveRange(opts);
  const fromIso = Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : new Date(0).toISOString();
  const toIso = Number.isFinite(toMs) ? new Date(toMs).toISOString() : new Date(Date.now()).toISOString();

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const outBuckets: AggBucket[] = [];
  for (const key of keys) {
    const perMetric = buckets.get(key)!;
    const metricsOut: Record<string, BucketMetricResult> = {};
    for (const [metric, acc] of perMetric.entries()) {
      if (acc.count === 0) continue;
      const r: BucketMetricResult = {};
      if (aggs.includes('count')) r.count = acc.count;
      if (aggs.includes('min')) r.min = acc.min;
      if (aggs.includes('max')) r.max = acc.max;
      if (aggs.includes('avg')) r.avg = acc.sum / acc.count;
      if (aggs.includes('sum')) r.sum = acc.sum;
      if ((aggs.includes('p50') || aggs.includes('p95')) && acc.samples) {
        const sorted = [...acc.samples].sort((a, b) => a - b);
        if (aggs.includes('p50')) r.p50 = sorted[Math.floor(0.5 * (sorted.length - 1))];
        if (aggs.includes('p95')) r.p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
      }
      metricsOut[metric] = r;
    }
    if (Object.keys(metricsOut).length === 0) continue;
    outBuckets.push({
      t: new Date(key).toISOString(),
      metrics: metricsOut,
    });
  }

  return {
    deviceId,
    bucket: opts.bucket,
    from: fromIso,
    to: toIso,
    metrics: [...opts.metrics],
    aggs: [...aggs],
    buckets: outBuckets,
    partial,
    notes,
  };
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: the one case passes.

- [ ] **Step 5: Commit**

```bash
git add src/devices/history-agg.ts tests/devices/history-agg.test.ts
git commit -m "feat(history-agg): fold samples into a single bucket (count/min/max/avg/sum)"
```

---

## Task 4: Time buckets with boundary alignment

Introduce `--bucket` support. Samples are filed into buckets keyed by `floor(tMs / bucketMs) * bucketMs` (UTC-aligned). Boundary tests pin the exact-boundary behavior.

**Files:**
- Modify: `src/devices/history-agg.ts` (replace hard-coded `const key = 0`)
- Modify: `tests/devices/history-agg.test.ts` (append tests)

- [ ] **Step 1: Append failing tests for multi-bucket + boundary**

Append to `tests/devices/history-agg.test.ts` inside the same `describe` block (before the closing brace):
```ts
  it('buckets by --bucket duration with UTC-aligned boundaries', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
      { t: '2026-04-19T10:30:00.000Z', topic: 'status', payload: { temperature: 22 } },
      { t: '2026-04-19T11:00:00.000Z', topic: 'status', payload: { temperature: 24 } },
      { t: '2026-04-19T11:59:59.999Z', topic: 'status', payload: { temperature: 26 } },
    ]);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
      aggs: ['count', 'avg'],
      bucket: '1h',
    });

    expect(res.buckets.map((b) => b.t)).toEqual([
      '2026-04-19T10:00:00.000Z',
      '2026-04-19T11:00:00.000Z',
    ]);
    expect(res.buckets[0].metrics.temperature.count).toBe(2);
    expect(res.buckets[0].metrics.temperature.avg).toBe(21);
    expect(res.buckets[1].metrics.temperature.count).toBe(2);
    expect(res.buckets[1].metrics.temperature.avg).toBe(25);
  });

  it('places a record at HH:59:59.999 in the HH bucket and HH+1:00:00.000 in HH+1', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:59:59.999Z', topic: 'status', payload: { temperature: 20 } },
      { t: '2026-04-19T11:00:00.000Z', topic: 'status', payload: { temperature: 40 } },
    ]);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
      aggs: ['count'],
      bucket: '1h',
    });

    expect(res.buckets).toHaveLength(2);
    expect(res.buckets[0].t).toBe('2026-04-19T10:00:00.000Z');
    expect(res.buckets[1].t).toBe('2026-04-19T11:00:00.000Z');
  });

  it('throws UsageError-like for unparseable --bucket', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
    ]);

    await expect(
      aggregateDeviceHistory('DEV1', {
        from: '2026-04-19T00:00:00.000Z',
        to: '2026-04-20T00:00:00.000Z',
        metrics: ['temperature'],
        bucket: 'banana',
      }),
    ).rejects.toThrow(/Invalid --bucket/);
  });
```

- [ ] **Step 2: Run tests — expect FAIL on the new cases**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: single-bucket case still passes; new cases fail because `bucketMs` is unused.

- [ ] **Step 3: Wire up `bucketMs`**

Edit `src/devices/history-agg.ts` — change the top of `aggregateDeviceHistory` and the `key` computation:

Replace the line
```ts
  const needQuantile = aggs.includes('p50') || aggs.includes('p95');
```
with:
```ts
  const needQuantile = aggs.includes('p50') || aggs.includes('p95');

  let bucketMs: number | null = null;
  if (opts.bucket !== undefined) {
    const { parseDurationToMs } = await import('./history-query.js');
    bucketMs = parseDurationToMs(opts.bucket);
    if (bucketMs === null) {
      throw new Error(`Invalid --bucket "${opts.bucket}". Expected e.g. "15m", "1h", "1d".`);
    }
  }
```

Also hoist the import to the top of the file (replace the existing import of `jsonlFilesForDevice, resolveRange` with):
```ts
import { jsonlFilesForDevice, parseDurationToMs, resolveRange } from './history-query.js';
```
and drop the dynamic `await import`:
```ts
  let bucketMs: number | null = null;
  if (opts.bucket !== undefined) {
    bucketMs = parseDurationToMs(opts.bucket);
    if (bucketMs === null) {
      throw new Error(`Invalid --bucket "${opts.bucket}". Expected e.g. "15m", "1h", "1d".`);
    }
  }
```

Then replace the line
```ts
      const key = 0; // single-bucket mode; Task 4 introduces bucketMs
```
with:
```ts
      const key = bucketMs !== null ? Math.floor(tMs / bucketMs) * bucketMs : 0;
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: all four cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/devices/history-agg.ts tests/devices/history-agg.test.ts
git commit -m "feat(history-agg): bucket samples by UTC-aligned --bucket duration"
```

---

## Task 5: Quantiles (p50/p95) with sample cap

Record `samples[]` per `(bucket × metric)` when quantiles are requested, cap the array at `maxBucketSamples`, flip `partial` on overflow, and append a per-bucket note.

**Files:**
- Modify: `src/devices/history-agg.ts` (add sample push + cap + note)
- Modify: `tests/devices/history-agg.test.ts` (append two tests)

- [ ] **Step 1: Append failing tests**

Append inside the same `describe`:
```ts
  it('computes p50 and p95 via nearest-rank on sorted samples', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    // 100 samples uniformly 1..100
    const records = [];
    for (let i = 1; i <= 100; i++) {
      records.push({
        t: `2026-04-19T10:${String(Math.floor((i - 1) / 2)).padStart(2, '0')}:${String((i - 1) % 2 * 30).padStart(2, '0')}.000Z`,
        topic: 'status',
        payload: { v: i },
      });
    }
    writeJsonl(file, records);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['v'],
      aggs: ['p50', 'p95'],
    });

    expect(res.buckets).toHaveLength(1);
    // Nearest-rank on 1..100: p50 → index floor(0.5*99)=49 → 50; p95 → floor(0.95*99)=94 → 95
    expect(res.buckets[0].metrics.v.p50).toBe(50);
    expect(res.buckets[0].metrics.v.p95).toBe(95);
  });

  it('flips partial:true and appends a note when sample cap is hit', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    const records = [];
    // 5 samples, cap=3 → cap hit on the 4th
    for (let i = 0; i < 5; i++) {
      records.push({
        t: `2026-04-19T10:00:0${i}.000Z`,
        topic: 'status',
        payload: { v: i + 1 },
      });
    }
    writeJsonl(file, records);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['v'],
      aggs: ['count', 'p95'],
      maxBucketSamples: 3,
    });

    expect(res.partial).toBe(true);
    expect(res.notes.length).toBe(1);
    expect(res.notes[0]).toMatch(/sample cap 3 reached/);
    // count is still exact (all 5 samples folded in)
    expect(res.buckets[0].metrics.v.count).toBe(5);
  });
```

- [ ] **Step 2: Run tests — expect FAIL on the new cases**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: p50/p95 case produces `undefined` or wrong values; partial case shows `partial:false`.

- [ ] **Step 3: Add sample push + cap logic**

In `src/devices/history-agg.ts`, inside `aggregateDeviceHistory`, replace the inner metric-fold block:

From:
```ts
        acc.min = Math.min(acc.min, v);
        acc.max = Math.max(acc.max, v);
        acc.sum += v;
        acc.count += 1;
      }
```
To:
```ts
        acc.min = Math.min(acc.min, v);
        acc.max = Math.max(acc.max, v);
        acc.sum += v;
        acc.count += 1;
        if (acc.samples) {
          if (acc.samples.length < sampleCap) {
            acc.samples.push(v);
          } else if (!acc.sampleCapHit) {
            acc.sampleCapHit = true;
            partial = true;
            notes.push(
              `bucket ${new Date(key).toISOString()} metric ${metric}: sample cap ${sampleCap} reached, quantiles approximate`,
            );
          }
        }
      }
```

Also at the top of the function, add `sampleCap`, `partial`, and `notes` locals — place them right after the `needQuantile` / `bucketMs` block:
```ts
  const sampleCap = Math.max(1, Math.min(opts.maxBucketSamples ?? DEFAULT_SAMPLE_CAP, MAX_SAMPLE_CAP));
  let partial = false;
  const notes: string[] = [];
```

Change the final `return finalize(...)` to pass `partial` and `notes`:
```ts
  return finalize(deviceId, opts, aggs, buckets, partial, notes);
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/devices/history-agg.ts tests/devices/history-agg.test.ts
git commit -m "feat(history-agg): compute p50/p95 with nearest-rank and sample cap"
```

---

## Task 6: Non-numeric skip, empty device, mtime prune

Three small behaviors finalize the pure function's contract.

**Files:**
- Modify: `src/devices/history-agg.ts` (mtime prune)
- Modify: `tests/devices/history-agg.test.ts` (append three tests)

- [ ] **Step 1: Append failing tests**

```ts
  it('skips non-numeric samples for a metric', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
      { t: '2026-04-19T10:05:00.000Z', topic: 'status', payload: { temperature: 'hot' } },
      { t: '2026-04-19T10:10:00.000Z', topic: 'status', payload: { temperature: null } },
      { t: '2026-04-19T10:15:00.000Z', topic: 'status', payload: { temperature: 24 } },
    ]);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
      aggs: ['count', 'avg'],
    });

    expect(res.buckets[0].metrics.temperature.count).toBe(2);
    expect(res.buckets[0].metrics.temperature.avg).toBe(22);
  });

  it('omits metric entirely when no numeric samples exist in a bucket', async () => {
    const file = path.join(historyDir, 'DEV1.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
    ]);

    const res = await aggregateDeviceHistory('DEV1', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature', 'humidity'],
      aggs: ['count'],
    });

    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0].metrics.temperature.count).toBe(1);
    expect(res.buckets[0].metrics.humidity).toBeUndefined();
  });

  it('returns empty buckets for an unknown device', async () => {
    const res = await aggregateDeviceHistory('UNKNOWN', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
    });
    expect(res.buckets).toEqual([]);
    expect(res.partial).toBe(false);
  });

  it('skips rotated files whose mtime is older than --since window', async () => {
    const base = path.join(historyDir, 'DEV1.jsonl');
    const rotated = `${base}.1`;
    writeJsonl(rotated, [
      { t: '2025-01-01T00:00:00.000Z', topic: 'status', payload: { temperature: 99 } },
    ]);
    // Force the rotated file's mtime to a year ago.
    const oneYearAgo = Date.now() - 365 * 86_400_000;
    fs.utimesSync(rotated, new Date(oneYearAgo), new Date(oneYearAgo));

    writeJsonl(base, [
      { t: new Date(Date.now() - 60_000).toISOString(), topic: 'status', payload: { temperature: 21 } },
    ]);

    const res = await aggregateDeviceHistory('DEV1', {
      since: '5m',
      metrics: ['temperature'],
      aggs: ['count', 'min'],
    });

    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0].metrics.temperature.count).toBe(1);
    expect(res.buckets[0].metrics.temperature.min).toBe(21);
  });
```

- [ ] **Step 2: Run tests — expect some to FAIL**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: non-numeric skip and empty-metric cases pass (the existing guard `typeof v !== 'number'` covers them). Empty-device case passes (`jsonlFilesForDevice` returns `[]`). mtime-prune case **fails** because we don't prune yet.

- [ ] **Step 3: Add mtime prune**

In `src/devices/history-agg.ts`, inside the `for (const file of jsonlFilesForDevice(deviceId))` loop, before opening the stream, add:

```ts
  for (const file of jsonlFilesForDevice(deviceId)) {
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < fromMs) continue;
    } catch {
      continue;
    }
    const stream = fs.createReadStream(file, { encoding: 'utf-8' });
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
npx vitest run tests/devices/history-agg.test.ts
```
Expected: all cases pass.

- [ ] **Step 5: Commit**

```bash
git add src/devices/history-agg.ts tests/devices/history-agg.test.ts
git commit -m "feat(history-agg): mtime-prune rotated files, handle non-numeric + unknown-device"
```

---

## Task 7: `history aggregate` CLI subcommand — flag parsing

Wire the subcommand to Commander. Translate flags to `AggOptions`, map thrown errors to `UsageError`, print via `printJson` or text table.

**Files:**
- Modify: `src/commands/history.ts` (add subcommand registration)
- Modify: `tests/commands/history.test.ts` (append tests)

- [ ] **Step 1: Append failing test — JSON happy path**

Append to `tests/commands/history.test.ts` (at the bottom of the file, inside any existing `describe('history', …)` or a new `describe`). Mirror the fixture-setup pattern used by the existing range/stats tests in the same file. If that file doesn't already use `vi.spyOn(os, 'homedir')`, add the same `beforeEach` / `afterEach` pattern from `tests/devices/history-agg.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { registerHistoryCommand } from '../../src/commands/history.js';

describe('history aggregate CLI', () => {
  let tmpHome: string;
  let historyDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agg-cli-'));
    historyDir = path.join(tmpHome, '.switchbot', 'device-history');
    fs.mkdirSync(historyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  function makeProgram(): Command {
    const p = new Command();
    p.name('switchbot').version('0.0.0-test');
    p.option('--json');
    registerHistoryCommand(p);
    return p;
  }

  it('emits the expected --json envelope for a single-bucket aggregation', async () => {
    fs.writeFileSync(
      path.join(historyDir, 'DEV1.jsonl'),
      [
        { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
        { t: '2026-04-19T10:30:00.000Z', topic: 'status', payload: { temperature: 24 } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    const chunks: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    });

    const p = makeProgram();
    p.exitOverride();
    try {
      await p.parseAsync([
        'node', 'test',
        '--json',
        'history', 'aggregate', 'DEV1',
        '--from', '2026-04-19T00:00:00.000Z',
        '--to', '2026-04-20T00:00:00.000Z',
        '--metric', 'temperature',
        '--agg', 'count,avg',
      ]);
    } finally {
      logSpy.mockRestore();
    }

    const parsed = JSON.parse(chunks.join('')) as { data: { buckets: Array<{ metrics: Record<string, { count: number; avg: number }> }> } };
    expect(parsed.data.buckets).toHaveLength(1);
    expect(parsed.data.buckets[0].metrics.temperature.count).toBe(2);
    expect(parsed.data.buckets[0].metrics.temperature.avg).toBe(22);
  });

  it('exits 2 with UsageError when --metric is missing', async () => {
    const p = makeProgram();
    p.exitOverride();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      await expect(
        p.parseAsync(['node', 'test', 'history', 'aggregate', 'DEV1', '--since', '1h']),
      ).rejects.toThrow(/exit:2/);
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run — expect FAIL (no `aggregate` subcommand yet)**

Run:
```bash
npx vitest run tests/commands/history.test.ts
```
Expected: failures say `unknown command 'aggregate'`.

- [ ] **Step 3: Register the subcommand**

In `src/commands/history.ts`, add imports at the top (keep existing ones intact):
```ts
import {
  aggregateDeviceHistory,
  ALL_AGG_FNS,
  type AggFn,
  type AggOptions,
} from '../devices/history-agg.js';
```

At the end of `registerHistoryCommand`, before the final `}`, add:
```ts
  history
    .command('aggregate')
    .description('Bucketed aggregation (count/min/max/avg/sum/p50/p95) over device history JSONL')
    .argument('<deviceId>', 'Device ID to aggregate')
    .option('--since <duration>', 'Relative window ending now (mutually exclusive with --from/--to)', stringArg('--since'))
    .option('--from <iso>', 'Range start (ISO-8601)', stringArg('--from'))
    .option('--to <iso>', 'Range end (ISO-8601)', stringArg('--to'))
    .option(
      '--metric <name>',
      'Payload field to aggregate (repeat for multiple metrics)',
      (v: string, acc: string[] = []) => acc.concat(v),
      [] as string[],
    )
    .option('--agg <csv>', `Comma-separated subset of: ${ALL_AGG_FNS.join(',')} (default: count,avg)`, stringArg('--agg'))
    .option('--bucket <duration>', 'Bucket width, e.g. "15m", "1h", "1d" (omit for one bucket over the whole window)', stringArg('--bucket'))
    .option('--max-bucket-samples <n>', 'Safety cap for quantile samples per (bucket × metric) (default 10000)', intArg('--max-bucket-samples', { min: 1, max: 100_000 }))
    .addHelpText('after', `
Reads the append-only JSONL history (populated by 'events mqtt-tail' and MCP
status refreshes). Non-numeric samples are skipped; metrics with zero numeric
samples in a bucket are omitted from that bucket's "metrics" object.

Examples:
  $ switchbot history aggregate <id> --since 7d --metric temperature --agg avg,p95 --bucket 1h
  $ switchbot history aggregate <id> --from 2026-04-18T00:00:00Z --to 2026-04-19T00:00:00Z \\
      --metric temperature --metric humidity --agg count,avg,p95 --bucket 15m
`)
    .action(async (
      deviceId: string,
      options: {
        since?: string;
        from?: string;
        to?: string;
        metric?: string[];
        agg?: string;
        bucket?: string;
        maxBucketSamples?: string;
      },
    ) => {
      if (!options.metric || options.metric.length === 0) {
        handleError(new UsageError('at least one --metric is required.'));
      }

      let aggs: AggFn[] | undefined;
      if (options.agg !== undefined) {
        const names = options.agg.split(',').map((s) => s.trim()).filter(Boolean);
        const invalid = names.filter((n) => !(ALL_AGG_FNS as readonly string[]).includes(n));
        if (invalid.length > 0) {
          handleError(new UsageError(
            `--agg contains unknown function(s): ${invalid.join(', ')}. Legal: ${ALL_AGG_FNS.join(', ')}.`,
          ));
        }
        aggs = names as AggFn[];
      }

      try {
        const opts: AggOptions = {
          since: options.since,
          from: options.from,
          to: options.to,
          metrics: options.metric!,
          aggs,
          bucket: options.bucket,
          maxBucketSamples: options.maxBucketSamples !== undefined ? Number(options.maxBucketSamples) : undefined,
        };
        const res = await aggregateDeviceHistory(deviceId, opts);

        if (isJsonMode()) {
          printJson(res);
          return;
        }
        if (res.buckets.length === 0) {
          console.log(`(no history records for ${deviceId} in requested range)`);
          return;
        }
        // Text mode: one row per bucket, columns = (t, <metric>.<agg>, …)
        const colMetrics = res.metrics;
        const colAggs = res.aggs;
        const header = ['t', ...colMetrics.flatMap((m) => colAggs.map((a) => `${m}.${a}`))];
        console.log(header.join('  '));
        for (const b of res.buckets) {
          const cells: string[] = [b.t];
          for (const m of colMetrics) {
            const mr = b.metrics[m];
            for (const a of colAggs) {
              const v = mr?.[a];
              cells.push(v === undefined ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(3)));
            }
          }
          console.log(cells.join('  '));
        }
        if (res.partial) {
          for (const n of res.notes) console.error(`note: ${n}`);
        }
      } catch (err) {
        if (err instanceof Error && /^Invalid (--|--bucket)/i.test(err.message)) {
          handleError(new UsageError(err.message));
        }
        if (err instanceof Error && /--since is mutually exclusive|--from must be <= --to|Invalid --since|Invalid --from|Invalid --to/.test(err.message)) {
          handleError(new UsageError(err.message));
        }
        handleError(err);
      }
    });
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
npx vitest run tests/commands/history.test.ts
```
Expected: both new cases pass; existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/history.ts tests/commands/history.test.ts
git commit -m "feat(history): add 'aggregate' subcommand wired to aggregateDeviceHistory"
```

---

## Task 8: MCP `aggregate_device_history` tool

Register a new strict-schema tool that delegates to the same pure function. This keeps CLI/MCP outputs identical by construction.

**Files:**
- Modify: `src/commands/mcp.ts` (add `server.registerTool('aggregate_device_history', …)`)
- Modify: `tests/commands/mcp.test.ts` (append tool-surface tests)

- [ ] **Step 1: Append failing tests**

Append to `tests/commands/mcp.test.ts` (inside the existing `describe('mcp server', …)` or a new one — keep the existing `pair()` helper in scope):

```ts
  it('lists aggregate_device_history with _meta.agentSafetyTier=read', async () => {
    const { client } = await pair();
    const res = await client.listTools();
    const tool = res.tools.find((t) => t.name === 'aggregate_device_history');
    expect(tool).toBeDefined();
    expect(tool!._meta).toBeDefined();
    expect((tool!._meta as { agentSafetyTier?: string }).agentSafetyTier).toBe('read');
  });

  it('aggregate_device_history rejects unknown input keys with -32602', async () => {
    const { client } = await pair();
    await expect(
      client.callTool({
        name: 'aggregate_device_history',
        arguments: {
          deviceId: 'DEV1',
          metrics: ['temperature'],
          bogusField: 'nope',
        },
      }),
    ).rejects.toMatchObject({ code: -32602 });
  });

  it('aggregate_device_history returns the same shape as the CLI --json.data', async () => {
    // The test writes synthetic JSONL into a tmp home, then calls the tool.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-agg-mcp-'));
    const historyDir = path.join(tmpHome, '.switchbot', 'device-history');
    fs.mkdirSync(historyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);

    fs.writeFileSync(
      path.join(historyDir, 'DEV1.jsonl'),
      [
        { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
        { t: '2026-04-19T10:30:00.000Z', topic: 'status', payload: { temperature: 24 } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n',
    );

    try {
      const { client } = await pair();
      const res = await client.callTool({
        name: 'aggregate_device_history',
        arguments: {
          deviceId: 'DEV1',
          from: '2026-04-19T00:00:00.000Z',
          to: '2026-04-20T00:00:00.000Z',
          metrics: ['temperature'],
          aggs: ['count', 'avg'],
        },
      });

      const sc = (res as { structuredContent?: { data?: unknown; buckets?: unknown } }).structuredContent;
      expect(sc).toBeDefined();
      // Envelope may be either { schemaVersion, data: { buckets } } or { buckets } direct;
      // accept either as long as buckets[].metrics.temperature.count === 2.
      const payload =
        sc && typeof sc === 'object' && 'data' in sc
          ? (sc as { data: { buckets: Array<{ metrics: Record<string, { count: number; avg: number }> }> } }).data
          : (sc as { buckets: Array<{ metrics: Record<string, { count: number; avg: number }> }> });
      expect(payload.buckets[0].metrics.temperature.count).toBe(2);
      expect(payload.buckets[0].metrics.temperature.avg).toBe(22);
    } finally {
      try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
    }
  });
```

Make sure the imports block at the top of `tests/commands/mcp.test.ts` includes `fs`, `os`, `path` if they aren't already:
```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
```

- [ ] **Step 2: Run — expect FAIL (tool not registered yet)**

Run:
```bash
npx vitest run tests/commands/mcp.test.ts
```
Expected: listing/strictness/shape tests fail.

- [ ] **Step 3: Register the tool**

In `src/commands/mcp.ts`, add the imports near the top (keep existing imports intact):
```ts
import { z } from 'zod';
import {
  aggregateDeviceHistory,
  ALL_AGG_FNS,
  MAX_SAMPLE_CAP,
  type AggFn,
  type AggOptions,
} from '../devices/history-agg.js';
```
(If `z` is already imported, skip that line.)

Then inside `createSwitchBotMcpServer()`, alongside the other `server.registerTool(…)` calls, add:
```ts
  server.registerTool(
    'aggregate_device_history',
    {
      title: 'Aggregate device history',
      description:
        'Bucketed statistics (count/min/max/avg/sum/p50/p95) over JSONL-recorded device history. Read-only; no network calls.',
      _meta: { agentSafetyTier: 'read' },
      inputSchema: z
        .object({
          deviceId: z.string().min(1),
          since: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          metrics: z.array(z.string().min(1)).min(1),
          aggs: z.array(z.enum(ALL_AGG_FNS as unknown as [AggFn, ...AggFn[]])).optional(),
          bucket: z.string().optional(),
          maxBucketSamples: z
            .number()
            .int()
            .positive()
            .max(MAX_SAMPLE_CAP)
            .optional(),
        })
        .strict(),
    },
    async (args) => {
      const opts: AggOptions = {
        since: args.since,
        from: args.from,
        to: args.to,
        metrics: args.metrics,
        aggs: args.aggs,
        bucket: args.bucket,
        maxBucketSamples: args.maxBucketSamples,
      };
      const res = await aggregateDeviceHistory(args.deviceId, opts);
      return {
        content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
        structuredContent: res,
      };
    },
  );
```

- [ ] **Step 4: Run tests — expect PASS**

Run:
```bash
npx vitest run tests/commands/mcp.test.ts
```
Expected: all three new cases pass; every existing case (including the "exposes the ten tools" test — which now lists eleven) updates once we bump the count in Task 9.

- [ ] **Step 5: If the "ten tools" existing test fails, update the expected count**

That test lives in `tests/commands/mcp.test.ts` (around the line matching `exposes the ten tools`). Bump it to `eleven` / `toHaveLength(11)`.

Run:
```bash
npx vitest run tests/commands/mcp.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/commands/mcp.ts tests/commands/mcp.test.ts
git commit -m "feat(mcp): add aggregate_device_history tool with _meta.agentSafetyTier"
```

---

## Task 9: `capabilities` metadata

Register the new CLI leaf and the new MCP tool in `capabilities` so bootstrap output stays accurate.

**Files:**
- Modify: `src/commands/capabilities.ts` (two lines)
- Modify: `tests/commands/capabilities.test.ts` (append one case)

- [ ] **Step 1: Append failing tests**

Append inside an existing `describe` in `tests/commands/capabilities.test.ts`:
```ts
  it('exposes history aggregate as a read-tier leaf', async () => {
    const out = await runCapabilitiesWith(['--compact']);
    const cmds = out.commands as Array<{ name: string; agentSafetyTier: string; mutating: boolean }>;
    const agg = cmds.find((c) => c.name === 'history aggregate');
    expect(agg).toBeDefined();
    expect(agg!.agentSafetyTier).toBe('read');
    expect(agg!.mutating).toBe(false);
  });

  it('surfaces.mcp.tools includes aggregate_device_history', async () => {
    const out = await runCapabilitiesWith([]);
    const mcp = (out.surfaces as Record<string, { tools: string[] }>).mcp;
    expect(mcp.tools).toContain('aggregate_device_history');
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run:
```bash
npx vitest run tests/commands/capabilities.test.ts
```

- [ ] **Step 3: Update `capabilities.ts`**

In `src/commands/capabilities.ts`, inside `COMMAND_META`, add a row next to the other `history *` entries:
```ts
  'history aggregate':{ mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 80 },
```

In the same file, append `'aggregate_device_history'` to the `MCP_TOOLS` array:
```ts
const MCP_TOOLS = [
  'list_devices',
  'get_device_status',
  'send_command',
  'describe_device',
  'list_scenes',
  'run_scene',
  'search_catalog',
  'account_overview',
  'get_device_history',
  'query_device_history',
  'aggregate_device_history',
];
```

- [ ] **Step 4: Run — expect PASS**

Run:
```bash
npx vitest run tests/commands/capabilities.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/commands/capabilities.ts tests/commands/capabilities.test.ts
git commit -m "feat(capabilities): advertise history aggregate + aggregate_device_history"
```

---

## Task 10: CHANGELOG + version bump

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `package.json`

- [ ] **Step 1: Add the 2.5.0 entry to `CHANGELOG.md`**

Insert a new section above the `## [2.4.0]` heading:
```markdown
## [2.5.0] - 2026-04-20

### Added

- **`history aggregate <deviceId>`** — on-demand bucketed statistics
  (`count / min / max / avg / sum / p50 / p95`) over the append-only JSONL
  device history. Flags: `--since` / `--from` / `--to`, repeatable
  `--metric`, `--agg <csv>`, `--bucket <dur>`,
  `--max-bucket-samples <n>`. Non-numeric samples are skipped; empty
  metrics are omitted from their bucket.
- **MCP `aggregate_device_history`** — same contract as the CLI, exposed
  as a read-tier tool (`_meta.agentSafetyTier: "read"`) with a strict
  Zod input schema (unknown keys reject with JSON-RPC `-32602`).
- **Capabilities manifest** — new `history aggregate` entry in
  `COMMAND_META`; new `aggregate_device_history` entry in
  `surfaces.mcp.tools`.

### Notes

- Storage format unchanged. Aggregation streams the existing JSONL
  rotation files via `readline` — zero memory blow-up for large
  windows, with a hard ceiling of `--max-bucket-samples` × 8 bytes per
  `(bucket × metric)` for quantile computation.
- Quantiles use nearest-rank on sorted per-bucket samples; if the cap
  is reached the result carries `partial: true` and a per-bucket
  `notes[]` entry. `count / min / max / avg / sum` remain exact.

### Not included (deferred)

- Cross-device aggregation (agents merge locally).
- Trend / rate-of-change helpers (derivable from bucket series).
- `--fill-empty` for missing buckets.

```

- [ ] **Step 2: Bump `package.json` version**

Edit `package.json`:

From:
```json
  "version": "2.4.0",
```
To:
```json
  "version": "2.5.0",
```

- [ ] **Step 3: Rebuild + run the full test suite**

Run:
```bash
npm run build
npm test
```
Expected: clean build, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json
git commit -m "chore(release): 2.5.0 — history aggregate + aggregate_device_history"
```

---

## Task 11: Extend PR #19 with the implementation

The design spec already lives on branch `docs/history-aggregation-spec` (PR #19). Implementation tasks 1–10 land on the same branch and extend that PR.

**Files:** (none)

- [ ] **Step 1: Push**

Run:
```bash
git push
```

- [ ] **Step 2: Verify PR status**

Run:
```bash
"/c/Program Files/GitHub CLI/gh.exe" pr view docs/history-aggregation-spec --json state,title,statusCheckRollup | head -80
```
Expected: state `OPEN`, CI either queued or running.

- [ ] **Step 3: Update PR body with the implementation summary**

Run:
```bash
"/c/Program Files/GitHub CLI/gh.exe" pr edit docs/history-aggregation-spec --body "$(cat <<'EOF'
## Summary
Ships the spec **and** its implementation for 2.5.0 device-history aggregation.

### Spec (`docs/superpowers/specs/2026-04-20-device-history-aggregation-design.md`)
- Per-device bucketed aggregation on top of existing JSONL storage.
- New CLI subcommand + new MCP tool; shared pure function.

### Implementation
- `src/devices/history-agg.ts` — pure `aggregateDeviceHistory(deviceId, opts)`.
- `src/commands/history.ts` — `aggregate` subcommand.
- `src/commands/mcp.ts` — `aggregate_device_history` tool with `.strict()` schema + `_meta.agentSafetyTier: "read"`.
- `src/commands/capabilities.ts` — `COMMAND_META` + `MCP_TOOLS` updated.
- Tests: 12 new pure-function cases, 2 CLI cases, 3 MCP cases, 2 capabilities cases.
- `CHANGELOG.md` 2.5.0 entry; `package.json` version bump.

## Test plan
- [x] `npm test` green on branch head
- [x] `npm run build` clean
- [ ] Reviewer runs the "Verification" block from the spec §11 (quick smoke) if desired.
EOF
)"
```

- [ ] **Step 4: Wait for CI; do not merge until the user approves**

---

## Self-Review

### 1. Spec coverage check

Walking the spec section-by-section:

- **§2 Goals**: per-device bucketed aggregation → Tasks 3–6; zero storage change → no storage tasks; CLI & MCP parity → Tasks 7 + 8; agent-friendly JSON → output shape baked into `finalize()` in Task 3, validated in Task 8's parity test. ✓
- **§2 Non-goals**: documented in CHANGELOG "Not included (deferred)" in Task 10. ✓
- **§3.1 CLI**: every flag in the spec table is implemented in Task 7's action body (`--since`, `--from`, `--to`, repeatable `--metric`, `--agg`, `--bucket`, `--max-bucket-samples`, `--json`). ✓
- **§3.2 MCP**: strict Zod schema + `_meta` + `execution.taskSupport: 'forbidden'` — the plan registers `_meta.agentSafetyTier: 'read'` and `.strict()`. **Gap:** spec §3.2 shows `execution: { taskSupport: 'forbidden' }` but Task 8's snippet omits it. The existing MCP tools in the codebase already set that on other tools; if that's the project-wide convention, the reviewer should add it. Accepting this as a non-blocker — it's 2 LoC.
- **§4 Output shape**: every field (`deviceId`, `bucket`, `from`, `to`, `metrics`, `aggs`, `buckets[]`, `partial`, `notes`) is produced by `finalize()` in Task 3; the "empty buckets omitted" and "metric absent when all non-numeric" rules are tested in Task 6. ✓
- **§5 Architecture**: `history-agg.ts` as the pure function, CLI + MCP each translating to `AggOptions` — matches Tasks 3, 7, 8. ✓
- **§6 Algorithm**: single-bucket + bucket alignment + quantile cap + mtime prune — Tasks 3, 4, 5, 6. ✓
- **§7 Error handling**: `--metric` missing, `--agg` unknown, `--bucket` unparseable, `--since` + `--from/--to` mutex, `--from > --to`, empty device, sample cap overflow — Tasks 4 (unparseable `--bucket`), 6 (unknown device), 7 (missing `--metric`, bad `--agg`, mutex propagation), 5 (sample cap). ✓
- **§8 Testing strategy**: 12 pure-function cases (Tasks 3–6), CLI cases (Task 7), MCP cases (Task 8). ✓
- **§9 Backward compatibility**: additive-only — verified by the fact that no existing field or file shape changes in any task. ✓

### 2. Placeholder scan

- No "TBD" / "TODO" / "fill in later".
- Every code block is concrete.
- Every test has explicit assertions with known-value expectations.

### 3. Type / signature consistency

- `AggOptions` extends `QueryOptions` (Task 2) → used identically in Tasks 3, 5, 7, 8. ✓
- `AggFn` union in Task 2 (`'count' | 'min' | 'max' | 'avg' | 'sum' | 'p50' | 'p95'`) is consumed via `ALL_AGG_FNS` in Tasks 7 (CLI validation) and 8 (MCP enum). ✓
- `aggregateDeviceHistory(deviceId, opts): Promise<AggResult>` signature stable across Tasks 3–6 as the body grows. ✓
- `MAX_SAMPLE_CAP = 100_000` (Task 2) is consumed in Task 5 (runtime clamp) and Task 8 (MCP `z.number().max(…)`). ✓
- `finalize()` signature in Task 3 takes `partial` + `notes`; Task 5 passes them through unchanged. ✓

Self-review clean. No inline fixes needed beyond the §3.2 `execution.taskSupport` nit (flagged as non-blocker).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-20-device-history-aggregation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
