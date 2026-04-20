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
