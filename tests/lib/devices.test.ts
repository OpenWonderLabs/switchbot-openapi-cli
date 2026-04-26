import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCommand } from '../../src/lib/devices.js';
import { idempotencyCache, fingerprintIdempotencyKey } from '../../src/lib/idempotency.js';
import { readAudit } from '../../src/utils/audit.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
    DryRunSignal: class DryRunSignal extends Error {
      constructor(public readonly method: string, public readonly url: string) {
        super('dry-run');
        this.name = 'DryRunSignal';
      }
    },
  };
});

const flagsMock = vi.hoisted(() => ({
  dryRun: false,
  auditPath: null as string | null,
  getCacheMode: vi.fn(() => ({ listTtlMs: 0, statusTtlMs: 0 })),
  isDryRun: vi.fn(() => flagsMock.dryRun),
  getAuditLog: vi.fn(() => flagsMock.auditPath),
}));

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  DryRunSignal: apiMock.DryRunSignal,
}));

vi.mock('../../src/utils/flags.js', () => ({
  getCacheMode: flagsMock.getCacheMode,
  isDryRun: flagsMock.isDryRun,
  getAuditLog: flagsMock.getAuditLog,
}));

vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: vi.fn(() => null),
  updateCacheFromDeviceList: vi.fn(),
  loadCache: vi.fn(() => null),
  isListCacheFresh: vi.fn(() => false),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
}));

vi.mock('../../src/devices/catalog.js', () => ({
  findCatalogEntry: vi.fn(() => null),
  suggestedActions: vi.fn(() => []),
  getEffectiveCatalog: vi.fn(() => []),
  deriveSafetyTier: vi.fn(() => 'read'),
  getCommandSafetyReason: vi.fn(() => null),
}));

describe('executeCommand audit semantics', () => {
  let tmp: string;
  let auditFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-devlib-'));
    auditFile = path.join(tmp, 'audit.log');
    flagsMock.dryRun = false;
    flagsMock.auditPath = auditFile;
    apiMock.__instance.post.mockReset();
    idempotencyCache.clear();
  });

  afterEach(() => {
    flagsMock.auditPath = null;
    idempotencyCache.clear();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('records result=dry-run and idempotency fingerprint when the request is intercepted', async () => {
    flagsMock.dryRun = true;
    apiMock.__instance.post.mockImplementation(async () => {
      throw new apiMock.DryRunSignal('POST', '/v1.1/devices/BOT1/commands');
    });

    await expect(
      executeCommand('BOT1', 'turnOn', undefined, 'command', undefined, { idempotencyKey: 'K1' }),
    ).rejects.toMatchObject({ name: 'DryRunSignal' });

    const entries = readAudit(auditFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].result).toBe('dry-run');
    expect(entries[0].dryRun).toBe(true);
    expect(entries[0].replayed).toBeUndefined();
    expect(entries[0].idempotencyKeyFingerprint).toBe(fingerprintIdempotencyKey('K1'));
  });

  it('records replayed audit entries and skips the second POST for the same idempotency key', async () => {
    apiMock.__instance.post.mockResolvedValue({ data: { body: { statusCode: 100 } } });

    const first = await executeCommand('BOT1', 'turnOn', undefined, 'command', undefined, { idempotencyKey: 'K1' });
    const second = await executeCommand('BOT1', 'turnOn', undefined, 'command', undefined, { idempotencyKey: 'K1' });

    expect(first).toEqual({ statusCode: 100 });
    expect(second).toEqual({ statusCode: 100, replayed: true });
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);

    const entries = readAudit(auditFile);
    expect(entries).toHaveLength(2);
    expect(entries[0].result).toBe('ok');
    expect(entries[0].replayed).toBeUndefined();
    expect(entries[1].result).toBe('ok');
    expect(entries[1].replayed).toBe(true);
    expect(entries[0].idempotencyKeyFingerprint).toBe(fingerprintIdempotencyKey('K1'));
    expect(entries[1].idempotencyKeyFingerprint).toBe(fingerprintIdempotencyKey('K1'));
  });
});
