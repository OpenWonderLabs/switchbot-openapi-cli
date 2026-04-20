import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  DryRunSignal: apiMock.DryRunSignal,
}));

const cacheMock = vi.hoisted(() => ({
  map: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
  getCachedDevice: vi.fn((id: string) => cacheMock.map.get(id) ?? null),
  updateCacheFromDeviceList: vi.fn(),
}));
vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: cacheMock.getCachedDevice,
  updateCacheFromDeviceList: cacheMock.updateCacheFromDeviceList,
  loadCache: vi.fn(() => null),
  clearCache: vi.fn(),
  isListCacheFresh: vi.fn(() => false),
  listCacheAgeMs: vi.fn(() => null),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
  clearStatusCache: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
  describeCache: vi.fn(() => ({
    list: { path: '', exists: false },
    status: { path: '', exists: false, entryCount: 0 },
  })),
}));

const flagsMock = vi.hoisted(() => ({
  dryRun: false,
  isDryRun: vi.fn(() => flagsMock.dryRun),
  isVerbose: vi.fn(() => false),
  getTimeout: vi.fn(() => 30000),
  getConfigPath: vi.fn(() => undefined),
  getProfile: vi.fn(() => undefined),
  getAuditLog: vi.fn(() => null),
  getCacheMode: vi.fn(() => ({ listTtlMs: 0, statusTtlMs: 0 })),
  getFormat: vi.fn(() => undefined),
  getFields: vi.fn(() => undefined),
}));
vi.mock('../../src/utils/flags.js', () => flagsMock);

import { registerPlanCommand, validatePlan } from '../../src/commands/plan.js';
import { runCli } from '../helpers/cli.js';

describe('plan command', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbplan-'));
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
    flagsMock.dryRun = false;
  });

  function writePlan(obj: unknown): string {
    const file = path.join(tmp, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    return file;
  }

  describe('validatePlan (unit)', () => {
    it('accepts a minimal valid plan', () => {
      const res = validatePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'A', command: 'turnOn' }],
      });
      expect(res.ok).toBe(true);
    });

    it('rejects wrong version', () => {
      const res = validatePlan({ version: '2.0', steps: [] });
      if (res.ok) throw new Error('should have rejected');
      expect(res.issues.some((i) => i.path === 'version')).toBe(true);
    });

    it('rejects bad step types and captures the index', () => {
      const res = validatePlan({
        version: '1.0',
        steps: [
          { type: 'command', deviceId: 'A', command: 'turnOn' },
          { type: 'nope' },
        ],
      });
      if (res.ok) throw new Error('should have rejected');
      expect(res.issues.some((i) => i.path === 'steps[1].type')).toBe(true);
    });

    it('rejects a wait step with out-of-range ms', () => {
      const res = validatePlan({
        version: '1.0',
        steps: [{ type: 'wait', ms: 999999999 }],
      });
      if (res.ok) throw new Error('should have rejected');
      expect(res.issues.some((i) => i.path === 'steps[0].ms')).toBe(true);
    });
  });

  describe('plan schema', () => {
    it('prints the JSON Schema', async () => {
      const res = await runCli(registerPlanCommand, ['plan', 'schema']);
      const parsed = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')).data;
      expect(parsed.$id).toMatch(/plan-1\.0/);
      expect(parsed.required).toContain('steps');
    });
  });

  describe('plan validate', () => {
    it('exits 0 for a valid plan and reports step count', async () => {
      const file = writePlan({
        version: '1.0',
        steps: [
          { type: 'command', deviceId: 'A', command: 'turnOn' },
          { type: 'wait', ms: 200 },
        ],
      });
      const res = await runCli(registerPlanCommand, ['plan', 'validate', file]);
      expect(res.exitCode).not.toBe(2);
      expect(res.stdout.join('\n')).toMatch(/2 steps/);
    });

    it('exits 2 with issue list for an invalid plan', async () => {
      const file = writePlan({ version: '9', steps: 'nope' });
      const res = await runCli(registerPlanCommand, ['plan', 'validate', file]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/version/);
    });

    it('emits structured JSON output when --json is set', async () => {
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'A', command: 'turnOn' }],
      });
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'validate', file]);
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')).data;
      expect(out.valid).toBe(true);
      expect(out.steps).toBe(1);
    });

    it('--help output contains "structural only" (bug #32)', async () => {
      const res = await runCli(registerPlanCommand, ['plan', 'validate', '--help']);
      const all = [...res.stdout, ...res.stderr].join('\n');
      expect(all).toMatch(/structural only/);
    });
  });

  describe('plan run', () => {
    it('executes commands + scenes + waits in order', async () => {
      const file = writePlan({
        version: '1.0',
        steps: [
          { type: 'command', deviceId: 'BOT1', command: 'turnOn' },
          { type: 'wait', ms: 0 },
          { type: 'scene', sceneId: 'S1' },
        ],
      });
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

      const res = await runCli(registerPlanCommand, ['plan', 'run', file]);
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(2);
      const urls = apiMock.__instance.post.mock.calls.map(([u]) => u);
      expect(urls[0]).toBe('/v1.1/devices/BOT1/commands');
      expect(urls[1]).toBe('/v1.1/scenes/S1/execute');
      expect(res.stdout.join('\n')).toMatch(/ok=3/);
    });

    it('skips destructive commands without --yes and exits 0 (skipped, not failed)', async () => {
      cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front', category: 'physical' });
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'LOCK1', command: 'unlock' }],
      });
      const res = await runCli(registerPlanCommand, ['plan', 'run', file]);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stdout.join('\n')).toMatch(/skipped=1/);
    });

    it('runs destructive commands when --yes is passed', async () => {
      cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front', category: 'physical' });
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'LOCK1', command: 'unlock' }],
      });
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });
      const res = await runCli(registerPlanCommand, ['plan', 'run', file, '--yes']);
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
      expect(res.stdout.join('\n')).toMatch(/ok=1/);
    });

    it('stops at the first error by default and exits 1', async () => {
      const file = writePlan({
        version: '1.0',
        steps: [
          { type: 'command', deviceId: 'BOT1', command: 'turnOn' },
          { type: 'command', deviceId: 'BOT2', command: 'turnOn' },
        ],
      });
      apiMock.__instance.post
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
      const res = await runCli(registerPlanCommand, ['plan', 'run', file]);
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
      expect(res.exitCode).toBe(1);
    });

    it('--continue-on-error keeps running after a failed step', async () => {
      const file = writePlan({
        version: '1.0',
        steps: [
          { type: 'command', deviceId: 'BOT1', command: 'turnOn' },
          { type: 'command', deviceId: 'BOT2', command: 'turnOn' },
        ],
      });
      apiMock.__instance.post
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
      const res = await runCli(registerPlanCommand, [
        'plan', 'run', file, '--continue-on-error',
      ]);
      expect(apiMock.__instance.post).toHaveBeenCalledTimes(2);
      expect(res.exitCode).toBe(1);
    });

    it('emits a structured summary when --json is set', async () => {
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }],
      });
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'run', file]);
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')).data;
      expect(out.ran).toBe(true);
      expect(out.summary).toEqual({ total: 1, ok: 1, error: 0, skipped: 0 });
    });
  });
});
