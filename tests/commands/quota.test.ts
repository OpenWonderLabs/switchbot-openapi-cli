import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerQuotaCommand } from '../../src/commands/quota.js';
import { runCli } from '../helpers/cli.js';
import { expectJsonEnvelopeShape } from '../helpers/contracts.js';

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

  it('status human output includes Remaining budget line with reset time', async () => {
    const result = await runCli(registerQuotaCommand, ['quota', 'status']);
    expect(result.exitCode).toBeNull();
    const out = result.stdout.join('\n');
    expect(out).toContain('Remaining budget:');
    expect(out).toContain('resets at');
  });

  it('status --json returns structured payload', async () => {
    await seedQuota();
    const result = await runCli(registerQuotaCommand, ['--json', 'quota', 'status']);
    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout[0]) as Record<string, unknown>;
    const data = expectJsonEnvelopeShape(parsed, ['today', 'history']) as {
      today: {
        total: number;
        remaining: number;
        dailyLimit: number;
        endpoints: Record<string, number>;
      };
      history: Record<string, unknown>;
    };
    expect(data.today.total).toBe(3);
    expect(data.today.remaining).toBe(10_000 - 3);
    expect(data.today.dailyLimit).toBe(10_000);
    expect(data.today.endpoints['GET /v1.1/devices']).toBe(2);
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
    expect(JSON.parse(result.stdout[0])).toEqual({ schemaVersion: '1.2', data: { reset: true } });
  });

  it('reset --dry-run prints dry-run message and does NOT execute reset', async () => {
    await seedQuota();
    const file = path.join(tmpRoot, '.switchbot', 'quota.json');
    expect(fs.existsSync(file)).toBe(true);
    const result = await runCli(registerQuotaCommand, ['--dry-run', 'quota', 'reset']);
    expect(result.exitCode).toBeNull();
    expect(result.stdout.join('\n')).toContain('dry-run');
    // File must still exist — dry-run must NOT have deleted it
    expect(fs.existsSync(file)).toBe(true);
  });

  it('reset --dry-run --json returns { dryRun: true, reset: false }', async () => {
    const result = await runCli(registerQuotaCommand, ['--dry-run', '--json', 'quota', 'reset']);
    expect(result.exitCode).toBeNull();
    const parsed = JSON.parse(result.stdout[0]) as Record<string, unknown>;
    const data = (parsed.data ?? parsed) as Record<string, unknown>;
    expect(data.dryRun).toBe(true);
    expect(data.reset).toBe(false);
  });
});
