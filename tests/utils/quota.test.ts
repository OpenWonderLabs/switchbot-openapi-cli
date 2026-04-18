import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate quota.json to a tmp dir per-test.
let tmpRoot: string;
let originalHome: ReturnType<typeof os.homedir>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-quota-'));
  originalHome = os.homedir();
  vi.spyOn(os, 'homedir').mockReturnValue(tmpRoot);
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// Re-import inside each test so the spy is honored if quota.ts captures
// homedir() at call time (which it does).
async function importQuota() {
  const mod = await import('../../src/utils/quota.js');
  return mod;
}

describe('normaliseEndpoint', () => {
  it('collapses long hex-like path segments to :id', async () => {
    const { normaliseEndpoint } = await importQuota();
    expect(
      normaliseEndpoint(
        'GET',
        'https://api.switch-bot.com/v1.1/devices/ABC123DEF456/status'
      )
    ).toBe('GET /v1.1/devices/:id/status');
  });

  it('collapses numeric segments to :id', async () => {
    const { normaliseEndpoint } = await importQuota();
    expect(normaliseEndpoint('POST', 'https://api.switch-bot.com/v1.1/scenes/42/execute')).toBe(
      'POST /v1.1/scenes/:id/execute'
    );
  });

  it('uppercases the method', async () => {
    const { normaliseEndpoint } = await importQuota();
    expect(normaliseEndpoint('get', 'https://api.switch-bot.com/v1.1/devices')).toBe(
      'GET /v1.1/devices'
    );
  });

  it('tolerates bare paths (no protocol/host)', async () => {
    const { normaliseEndpoint } = await importQuota();
    expect(normaliseEndpoint('GET', '/v1.1/devices/XYZabc1234/status?x=1')).toBe(
      'GET /v1.1/devices/:id/status'
    );
  });

  it('leaves short non-id segments alone', async () => {
    const { normaliseEndpoint } = await importQuota();
    expect(normaliseEndpoint('POST', 'https://api.switch-bot.com/v1.1/webhook/setup')).toBe(
      'POST /v1.1/webhook/setup'
    );
  });
});

describe('recordRequest + todayUsage', () => {
  it('starts at zero when no file exists', async () => {
    const { todayUsage, DAILY_QUOTA } = await importQuota();
    const u = todayUsage();
    expect(u.total).toBe(0);
    expect(u.remaining).toBe(DAILY_QUOTA);
    expect(u.endpoints).toEqual({});
  });

  it('increments per call and writes to ~/.switchbot/quota.json', async () => {
    const { recordRequest, todayUsage } = await importQuota();
    recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices');
    recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices');
    recordRequest('POST', 'https://api.switch-bot.com/v1.1/devices/DEAD1234/commands');
    const u = todayUsage();
    expect(u.total).toBe(3);
    expect(u.endpoints['GET /v1.1/devices']).toBe(2);
    expect(u.endpoints['POST /v1.1/devices/:id/commands']).toBe(1);

    const file = path.join(tmpRoot, '.switchbot', 'quota.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('resetQuota deletes the file', async () => {
    const { recordRequest, resetQuota, todayUsage } = await importQuota();
    recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices');
    resetQuota();
    expect(todayUsage().total).toBe(0);
  });

  it('retains at most 7 days of history', async () => {
    const { recordRequest, loadQuota } = await importQuota();
    const base = new Date('2026-04-10T12:00:00');
    for (let i = 0; i < 10; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices', d);
    }
    const data = loadQuota();
    expect(Object.keys(data.days).length).toBe(7);
  });

  it('recovers gracefully from a corrupt quota.json', async () => {
    const dir = path.join(tmpRoot, '.switchbot');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'quota.json'), 'not valid json {');
    const { todayUsage, recordRequest } = await importQuota();
    expect(todayUsage().total).toBe(0);
    recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices');
    expect(todayUsage().total).toBe(1);
  });
});
