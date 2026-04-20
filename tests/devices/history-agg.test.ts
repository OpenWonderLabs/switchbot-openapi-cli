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
});
