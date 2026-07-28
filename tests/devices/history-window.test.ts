import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { queryEventWindow } from '../../src/devices/history-window.js';

// queryEventWindow uses jsonlFilesForDevice which reads from
// ~/.switchbot/device-history. We point HOME at a tmpdir to keep tests
// hermetic.
function mkTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-history-'));
  return dir;
}

function seedHistoryFile(homeDir: string, deviceId: string, lines: string[]): string {
  const dir = path.join(homeDir, '.switchbot', 'device-history');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${deviceId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
  return file;
}

describe('queryEventWindow', () => {
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;
  let homeDir: string;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    homeDir = mkTempHome();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserprofile;
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
    } catch { /* */ }
  });

  it('returns empty when device has no history file', async () => {
    const records = await queryEventWindow('AA_BB_CC', { sinceMs: 0, untilMs: Date.now() });
    expect(records).toEqual([]);
  });

  it('returns records inside the [sinceMs, untilMs] window', async () => {
    const now = Date.parse('2026-05-15T08:00:00.000Z');
    const lines = [
      JSON.stringify({ t: '2026-05-15T07:00:00.000Z', topic: 't', payload: { context: { detectionState: 'DETECTED' } } }),
      JSON.stringify({ t: '2026-05-15T07:30:00.000Z', topic: 't', payload: { context: { detectionState: 'DETECTED' } } }),
      JSON.stringify({ t: '2026-05-15T07:45:00.000Z', topic: 't', payload: { context: { detectionState: 'NOT_DETECTED' } } }),
      JSON.stringify({ t: '2026-05-15T07:55:00.000Z', topic: 't', payload: { context: { detectionState: 'DETECTED' } } }),
    ];
    seedHistoryFile(homeDir, 'AA_BB_CC', lines);

    const records = await queryEventWindow('AA_BB_CC', {
      sinceMs: now - 10 * 60 * 1000, // 10m back from 08:00 = 07:50
      untilMs: now,
    });
    expect(records).toHaveLength(1);
    expect(records[0].t).toBe('2026-05-15T07:55:00.000Z');
  });

  it('returns no records when sinceMs > untilMs', async () => {
    seedHistoryFile(homeDir, 'AA_BB_CC', [
      JSON.stringify({ t: '2026-05-15T07:00:00.000Z', topic: 't', payload: {} }),
    ]);
    const records = await queryEventWindow('AA_BB_CC', { sinceMs: 1000, untilMs: 500 });
    expect(records).toEqual([]);
  });

  it('honors limit by stopping after `limit` records', async () => {
    const now = Date.parse('2026-05-15T08:00:00.000Z');
    const lines = Array.from({ length: 10 }, (_, i) => {
      const t = new Date(now - (10 - i) * 60_000).toISOString();
      return JSON.stringify({ t, topic: 'shadow', payload: { context: { detectionState: 'DETECTED' } } });
    });
    seedHistoryFile(homeDir, 'AA_BB_CC', lines);

    const records = await queryEventWindow('AA_BB_CC', {
      sinceMs: now - 60 * 60_000,
      untilMs: now,
      limit: 3,
    });
    expect(records).toHaveLength(3);
  });

  it('applies eventFilter to drop non-matching records', async () => {
    const now = Date.parse('2026-05-15T08:00:00.000Z');
    const lines = [
      JSON.stringify({ t: '2026-05-15T07:50:00.000Z', topic: 't', payload: { context: { detectionState: 'DETECTED' } } }),
      JSON.stringify({ t: '2026-05-15T07:55:00.000Z', topic: 't', payload: { context: { detectionState: 'NOT_DETECTED' } } }),
      JSON.stringify({ t: '2026-05-15T07:58:00.000Z', topic: 't', payload: { context: { detectionState: 'DETECTED' } } }),
    ];
    seedHistoryFile(homeDir, 'AA_BB_CC', lines);

    const records = await queryEventWindow('AA_BB_CC', {
      sinceMs: now - 30 * 60_000,
      untilMs: now,
      eventFilter: (rec) => {
        const ctx = (rec.payload as { context?: { detectionState?: string } })?.context;
        return ctx?.detectionState === 'DETECTED';
      },
    });
    expect(records).toHaveLength(2);
    expect(records.every((r) => {
      const ctx = (r.payload as { context: { detectionState: string } }).context;
      return ctx.detectionState === 'DETECTED';
    })).toBe(true);
  });

  it('skips malformed JSON lines silently', async () => {
    const now = Date.parse('2026-05-15T08:00:00.000Z');
    const lines = [
      '{ not valid json',
      JSON.stringify({ t: '2026-05-15T07:55:00.000Z', topic: 't', payload: {} }),
      'still bad',
      JSON.stringify({ t: '2026-05-15T07:58:00.000Z', topic: 't', payload: {} }),
    ];
    seedHistoryFile(homeDir, 'AA_BB_CC', lines);

    const records = await queryEventWindow('AA_BB_CC', {
      sinceMs: now - 30 * 60_000,
      untilMs: now,
    });
    expect(records).toHaveLength(2);
  });

  it('returns 0 records when limit is 0', async () => {
    seedHistoryFile(homeDir, 'AA_BB_CC', [
      JSON.stringify({ t: '2026-05-15T07:55:00.000Z', topic: 't', payload: {} }),
    ]);
    const records = await queryEventWindow('AA_BB_CC', {
      sinceMs: 0,
      untilMs: Date.now(),
      limit: 0,
    });
    expect(records).toEqual([]);
  });
});
