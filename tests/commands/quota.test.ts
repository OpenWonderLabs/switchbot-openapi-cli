import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerQuotaCommand } from '../../src/commands/quota.js';
import { runCli } from '../helpers/cli.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-quota-cmd-'));
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

async function seedQuota(): Promise<void> {
  // Write a quota file with a couple of entries on today's date.
  const { recordRequest, flushQuota } = await import('../../src/utils/quota.js');
  recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices');
  recordRequest('GET', 'https://api.switch-bot.com/v1.1/devices');
  recordRequest('POST', 'https://api.switch-bot.com/v1.1/devices/ABC/commands');
  flushQuota();
}

describe('quota command', () => {
  it('status prints today usage + endpoint breakdown (human mode)', async () => {
    await seedQuota();
    const result = await runCli(registerQuotaCommand, ['quota', 'status']);
    expect(result.exitCode).toBeNull();
    const out = result.stdout.join('\n');
    expect(out).toMatch(/Today \(\d{4}-\d{2}-\d{2}\)/);
    expect(out).toContain('Requests used:');
    expect(out).toContain('3 /');
    expect(out).toMatch(/GET \/v1\.1\/devices\s+2/);
    expect(out).toMatch(/POST \/v1\.1\/devices\/:id\/commands\s+1/);
  });

  it('status --json returns structured payload', async () => {
    await seedQuota();
    const result = await runCli(registerQuotaCommand, ['--json', 'quota', 'status']);
    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout[0]);
    expect(parsed.data.today.total).toBe(3);
    expect(parsed.data.today.remaining).toBe(10_000 - 3);
    expect(parsed.data.today.dailyLimit).toBe(10_000);
    expect(parsed.data.today.endpoints['GET /v1.1/devices']).toBe(2);
  });

  it('status says "no requests recorded yet" with an empty counter', async () => {
    const result = await runCli(registerQuotaCommand, ['quota', 'status']);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.join('\n')).toMatch(/no requests recorded yet/);
  });

  it('bare quota defaults to status', async () => {
    await seedQuota();
    const result = await runCli(registerQuotaCommand, ['quota']);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.join('\n')).toContain('Requests used:');
  });

  it('reset deletes the quota file', async () => {
    await seedQuota();
    const file = path.join(tmpRoot, '.switchbot', 'quota.json');
    expect(fs.existsSync(file)).toBe(true);
    const result = await runCli(registerQuotaCommand, ['quota', 'reset']);
    expect(result.exitCode).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    expect(result.stdout.join('\n')).toContain('Quota counter reset');
  });

  it('reset --json returns {reset:true}', async () => {
    await seedQuota();
    const result = await runCli(registerQuotaCommand, ['--json', 'quota', 'reset']);
    expect(result.exitCode).toBeNull();
    expect(JSON.parse(result.stdout[0])).toEqual({ schemaVersion: '1.1', data: { reset: true } });
  });
});
