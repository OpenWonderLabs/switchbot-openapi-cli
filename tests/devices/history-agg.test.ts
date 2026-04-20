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

  it('skips non-numeric samples for a metric', async () => {
    const file = path.join(historyDir, 'DEV2.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20 } },
      { t: '2026-04-19T10:01:00.000Z', topic: 'status', payload: { temperature: 'hot' } },
      { t: '2026-04-19T10:02:00.000Z', topic: 'status', payload: { temperature: null } },
      { t: '2026-04-19T10:03:00.000Z', topic: 'status', payload: { temperature: 24 } },
    ]);

    const res = await aggregateDeviceHistory('DEV2', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
      aggs: ['count', 'avg'],
    });

    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0].metrics.temperature.count).toBe(2);
    expect(res.buckets[0].metrics.temperature.avg).toBe(22);
  });

  it('omits metric entirely when no numeric samples exist in a bucket', async () => {
    const file = path.join(historyDir, 'DEV3.jsonl');
    writeJsonl(file, [
      { t: '2026-04-19T10:00:00.000Z', topic: 'status', payload: { temperature: 20, humidity: 'dry' } },
      { t: '2026-04-19T10:01:00.000Z', topic: 'status', payload: { temperature: 22, humidity: null } },
    ]);

    const res = await aggregateDeviceHistory('DEV3', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature', 'humidity'],
      aggs: ['count', 'avg'],
    });

    // One bucket exists because temperature has numeric samples
    expect(res.buckets).toHaveLength(1);
    // humidity is absent because it has no numeric samples
    expect(res.buckets[0].metrics.humidity).toBeUndefined();
    // temperature is present
    expect(res.buckets[0].metrics.temperature.count).toBe(2);
  });

  it('returns empty buckets for an unknown device', async () => {
    const res = await aggregateDeviceHistory('does-not-exist', {
      from: '2026-04-19T00:00:00.000Z',
      to: '2026-04-20T00:00:00.000Z',
      metrics: ['temperature'],
    });

    expect(res.buckets).toEqual([]);
    expect(res.partial).toBe(false);
    expect(res.notes).toEqual([]);
  });

  it('skips rotated files whose mtime is older than --since window', async () => {
    const id = 'DEV4';
    const rotatedFile = path.join(historyDir, `${id}.jsonl.1`);
    const currentFile = path.join(historyDir, `${id}.jsonl`);

    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
    const thirtySecondsAgo = new Date(Date.now() - 30_000); // Inside 5m window
    const nowish = new Date();

    // Rotated file: RECENT record (inside 5m window) but backdated file mtime (outside window)
    const rotatedRecord = { t: thirtySecondsAgo.toISOString(), topic: 'status', payload: { temperature: 99 } };
    writeJsonl(rotatedFile, [rotatedRecord]);
    fs.utimesSync(rotatedFile, threeDaysAgo, threeDaysAgo); // Backdate file mtime only

    // Current file: recent record with different value
    writeJsonl(currentFile, [
      { t: nowish.toISOString(), topic: 'status', payload: { temperature: 21 } },
    ]);

    // Before calling aggregateDeviceHistory, assert that the rotated record is recent enough
    // to pass the per-record timestamp filter (if there were no mtime prune)
    const fromMs = Date.now() - 5 * 60 * 1000;
    const rotatedRecordTms = Date.parse(rotatedRecord.t);
    expect(rotatedRecordTms).toBeGreaterThan(fromMs); // record is inside window
    expect(fs.statSync(rotatedFile).mtimeMs).toBeLessThan(fromMs); // but file mtime is outside

    const res = await aggregateDeviceHistory(id, {
      since: '5m',
      metrics: ['temperature'],
      aggs: ['count', 'min', 'max'],
    });

    // Only the current file's record should be present (rotated file filtered by mtime)
    expect(res.buckets).toHaveLength(1);
    expect(res.buckets[0].metrics.temperature.count).toBe(1);
    // Verify it's the current file's value (21), not the rotated file's (99)
    expect(res.buckets[0].metrics.temperature.min).toBe(21);
    expect(res.buckets[0].metrics.temperature.max).toBe(21);
  });
});
