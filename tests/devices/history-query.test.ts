import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseDurationToMs,
  parseInstantToMs,
  jsonlFilesForDevice,
  queryDeviceHistory,
  queryDeviceHistoryStats,
} from '../../src/devices/history-query.js';

describe('history-query parsers', () => {
  it('parseDurationToMs accepts s/m/h/d/ms units', () => {
    expect(parseDurationToMs('500ms')).toBe(500);
    expect(parseDurationToMs('30s')).toBe(30_000);
    expect(parseDurationToMs('5m')).toBe(300_000);
    expect(parseDurationToMs('2h')).toBe(7_200_000);
    expect(parseDurationToMs('7d')).toBe(7 * 86_400_000);
  });

  it('parseDurationToMs rejects malformed input', () => {
    expect(parseDurationToMs('abc')).toBeNull();
    expect(parseDurationToMs('3x')).toBeNull();
    expect(parseDurationToMs('')).toBeNull();
  });

  it('parseInstantToMs parses ISO-8601', () => {
    const ms = parseInstantToMs('2026-04-18T10:00:00.000Z');
    expect(ms).toBe(Date.UTC(2026, 3, 18, 10, 0, 0, 0));
  });

  it('parseInstantToMs rejects garbage', () => {
    expect(parseInstantToMs('not-a-date')).toBeNull();
  });
});

describe('history-query file walking', () => {
  let tmpHome: string;
  let historyDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-hist-'));
    historyDir = path.join(tmpHome, '.switchbot', 'device-history');
    fs.mkdirSync(historyDir, { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  function writeRecords(file: string, records: Array<Record<string, unknown>>): void {
    fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }

  it('returns oldest-first rotation ordering (.3 → .2 → .1 → .)', () => {
    const base = path.join(historyDir, 'DEV1');
    fs.writeFileSync(`${base}.jsonl`, '');
    fs.writeFileSync(`${base}.jsonl.1`, '');
    fs.writeFileSync(`${base}.jsonl.2`, '');
    fs.writeFileSync(`${base}.jsonl.3`, '');
    const files = jsonlFilesForDevice('DEV1', historyDir);
    expect(files.map((f) => path.basename(f))).toEqual([
      'DEV1.jsonl.3', 'DEV1.jsonl.2', 'DEV1.jsonl.1', 'DEV1.jsonl',
    ]);
  });

  it('returns [] for a device with no history files', () => {
    expect(jsonlFilesForDevice('NONEXISTENT', historyDir)).toEqual([]);
  });

  it('queryDeviceHistory reads across rotation files and filters by time', async () => {
    const now = Date.now();
    writeRecords(path.join(historyDir, 'DEV1.jsonl.1'), [
      { t: new Date(now - 600_000).toISOString(), topic: 'sb/DEV1', payload: { power: 'on' } },
      { t: new Date(now - 500_000).toISOString(), topic: 'sb/DEV1', payload: { power: 'off' } },
    ]);
    writeRecords(path.join(historyDir, 'DEV1.jsonl'), [
      { t: new Date(now - 60_000).toISOString(), topic: 'sb/DEV1', payload: { power: 'on' } },
      { t: new Date(now - 30_000).toISOString(), topic: 'sb/DEV1', payload: { power: 'off' } },
    ]);

    const all = await queryDeviceHistory('DEV1');
    expect(all.length).toBe(4);

    const recent = await queryDeviceHistory('DEV1', { since: '2m' });
    expect(recent.length).toBe(2);
    expect(recent.every((r) => (r.payload as { power: string }).power !== undefined)).toBe(true);
  });

  it('projects payload fields via fields option', async () => {
    writeRecords(path.join(historyDir, 'DEV1.jsonl'), [
      { t: new Date().toISOString(), topic: 't', payload: { temp: 22, humidity: 50, battery: 90 } },
    ]);
    const out = await queryDeviceHistory('DEV1', { fields: ['temp', 'humidity'] });
    expect(out[0].payload).toEqual({ temp: 22, humidity: 50 });
  });

  it('respects --limit and stops early', async () => {
    const recs = Array.from({ length: 50 }, (_, i) => ({
      t: new Date(Date.now() - (50 - i) * 1000).toISOString(),
      topic: 't',
      payload: { i },
    }));
    writeRecords(path.join(historyDir, 'DEV1.jsonl'), recs);
    const out = await queryDeviceHistory('DEV1', { limit: 10 });
    expect(out.length).toBe(10);
  });

  it('throws on --since + --from mutual exclusion', async () => {
    await expect(queryDeviceHistory('DEV1', { since: '1h', from: '2026-01-01T00:00:00Z' }))
      .rejects.toThrow(/mutually exclusive/);
  });

  it('throws on invalid --since format', async () => {
    await expect(queryDeviceHistory('DEV1', { since: 'lol' })).rejects.toThrow(/Invalid --since/);
  });

  it('throws when --from is after --to', async () => {
    await expect(
      queryDeviceHistory('DEV1', { from: '2026-02-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow(/--from must be <= --to/);
  });

  it('silently drops malformed JSONL lines', async () => {
    fs.writeFileSync(
      path.join(historyDir, 'DEV1.jsonl'),
      'this is not json\n' +
        JSON.stringify({ t: new Date().toISOString(), topic: 't', payload: { ok: true } }) +
        '\n',
    );
    const out = await queryDeviceHistory('DEV1');
    expect(out.length).toBe(1);
    expect((out[0].payload as { ok: boolean }).ok).toBe(true);
  });

  it('stats reports file count, bytes, record count, oldest/newest', () => {
    const oldest = new Date('2026-04-01T00:00:00Z').toISOString();
    const newest = new Date('2026-04-20T00:00:00Z').toISOString();
    writeRecords(path.join(historyDir, 'DEV1.jsonl'), [
      { t: oldest, topic: 't', payload: {} },
      { t: newest, topic: 't', payload: {} },
    ]);
    const stats = queryDeviceHistoryStats('DEV1');
    expect(stats.deviceId).toBe('DEV1');
    expect(stats.fileCount).toBe(1);
    expect(stats.recordCount).toBe(2);
    expect(stats.oldest).toBe(oldest);
    expect(stats.newest).toBe(newest);
    expect(stats.totalBytes).toBeGreaterThan(0);
  });

  it('stats on an unknown device returns zeros', () => {
    const stats = queryDeviceHistoryStats('NONEXISTENT');
    expect(stats.fileCount).toBe(0);
    expect(stats.recordCount).toBe(0);
    expect(stats.oldest).toBeUndefined();
    expect(stats.newest).toBeUndefined();
  });
});
