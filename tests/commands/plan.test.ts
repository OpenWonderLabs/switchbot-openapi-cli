import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const planStoreMock = vi.hoisted(() => ({
  savePlanRecord: vi.fn(),
  loadPlanRecord: vi.fn(() => null),
  updatePlanRecord: vi.fn(),
  listPlanRecords: vi.fn(() => []),
  PLANS_DIR: '/mock/.switchbot/plans',
}));

vi.mock('../../src/lib/plan-store.js', () => ({
  savePlanRecord: planStoreMock.savePlanRecord,
  loadPlanRecord: planStoreMock.loadPlanRecord,
  updatePlanRecord: planStoreMock.updatePlanRecord,
  listPlanRecords: planStoreMock.listPlanRecords,
  PLANS_DIR: planStoreMock.PLANS_DIR,
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
import { expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

describe('plan command', () => {
  let tmp: string;
  let auditFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbplan-'));
    auditFile = path.join(tmp, 'audit.log');
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
    flagsMock.dryRun = false;
    flagsMock.getProfile.mockReturnValue(undefined);
    flagsMock.getAuditLog.mockReturnValue(null);
    planStoreMock.savePlanRecord.mockReset();
    planStoreMock.loadPlanRecord.mockReset().mockReturnValue(null);
    planStoreMock.updatePlanRecord.mockReset();
    planStoreMock.listPlanRecords.mockReset().mockReturnValue([]);
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
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['valid', 'steps']) as { valid: boolean; steps: number };
      expect(data.valid).toBe(true);
      expect(data.steps).toBe(1);
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

    it('rejects direct destructive commands when --yes is passed outside a dev profile', async () => {
      cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front', category: 'physical' });
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'LOCK1', command: 'unlock' }],
      });
      const res = await runCli(registerPlanCommand, ['plan', 'run', file, '--yes']);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/plan save|plan execute/);
    });

    it('allows direct destructive commands with --yes in a dev profile', async () => {
      flagsMock.getProfile.mockReturnValue('dev');
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
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['ran', 'planId', 'summary', 'results']) as {
        ran: boolean;
        summary: Record<string, number>;
      };
      expect(data.ran).toBe(true);
      expect(data.summary).toEqual({ total: 1, ok: 1, error: 0, skipped: 0, dryRun: 0 });
    });

    it('--dry-run reports command steps with status=dry-run instead of ok', async () => {
      flagsMock.dryRun = true;
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }],
      });
      apiMock.__instance.post.mockImplementation(async () => {
        throw new apiMock.DryRunSignal('POST', '/v1.1/devices/BOT1/commands');
      });

      const res = await runCli(registerPlanCommand, ['--json', '--dry-run', 'plan', 'run', file]);
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['ran', 'planId', 'summary', 'results']) as {
        ran: boolean;
        summary: Record<string, number>;
        results: Array<{ status: string }>;
      };

      expect(data.ran).toBe(true);
      expect(data.summary).toEqual({ total: 1, ok: 0, error: 0, skipped: 0, dryRun: 1 });
      expect(data.results[0].status).toBe('dry-run');
    });

    it('writes audit entries tagged with the generated planId', async () => {
      flagsMock.getAuditLog.mockReturnValue(auditFile);
      const file = writePlan({
        version: '1.0',
        steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }],
      });
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'run', file]);
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['ran', 'planId', 'summary', 'results']) as { planId: string };
      const entries = readAudit(auditFile);

      expect(entries).toHaveLength(1);
      expect(entries[0].deviceId).toBe('BOT1');
      expect(entries[0].result).toBe('ok');
      expect(entries[0].planId).toBe(data.planId);
    });

    it('--plan accepts inline JSON string', async () => {
      flagsMock.dryRun = true;
      apiMock.__instance.post.mockImplementation(async () => {
        throw new apiMock.DryRunSignal('POST', '/v1.1/devices/DEV001/commands');
      });
      const inlinePlan = JSON.stringify({
        version: '1.0',
        description: 'inline test',
        steps: [{ type: 'command', deviceId: 'DEV001', command: 'turnOn' }],
      });
      const res = await runCli(registerPlanCommand, ['--dry-run', 'plan', 'run', '--plan', inlinePlan]);
      expect(res.exitCode).toBeNull();
    });

    it('--plan and file argument are mutually exclusive', async () => {
      const res = await runCli(registerPlanCommand, ['plan', 'run', '--plan', '{}', 'somefile.json']);
      expect(res.exitCode).toBe(2);
    });

    it('--plan with invalid JSON produces error', async () => {
      const res = await runCli(registerPlanCommand, ['plan', 'run', '--plan', 'not-json']);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toContain('--plan is not valid JSON');
    });

    it('--plan with invalid JSON reports usage error in --json mode', async () => {
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'run', '--plan', 'not-json']);
      expect(res.exitCode).toBe(2);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.error.kind).toBe('usage');
      expect(parsed.error.code).toBe(2);
      expect(parsed.error.message).toContain('--plan is not valid JSON');
    });
  });

  describe('plan suggest', () => {
    it('exits 2 for unsupported Chinese command intent instead of defaulting to turnOn', async () => {
      const res = await runCli(registerPlanCommand, [
        'plan', 'suggest', '--intent', '关掉所有灯', '--device', 'BOT1',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/cannot safely infer/i);
    });

    it('exits 2 when no --device is given', async () => {
      const res = await runCli(registerPlanCommand, [
        'plan', 'suggest', '--intent', 'turn off lights',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toContain('at least one --device');
    });

    it('accepts --devices as alias for --device', async () => {
      cacheMock.map.set('BOT1', { type: 'Bot', name: 'My Bot', category: 'physical' });
      const res = await runCli(registerPlanCommand, [
        'plan', 'suggest', '--intent', 'turn on the bot', '--devices', 'BOT1',
      ]);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join('\n')).toContain('BOT1');
    });
  });

  describe('plan save / list / review / approve', () => {
    const MOCK_ID = '00000000-0000-4000-8000-000000000001';

    it('plan save writes a valid plan and prints planId', async () => {
      planStoreMock.savePlanRecord.mockReturnValue({
        planId: MOCK_ID,
        status: 'pending',
        createdAt: '2024-01-01T00:00:00Z',
        plan: { version: '1.0', steps: [] },
      });
      const file = writePlan({ version: '1.0', steps: [] });
      const res = await runCli(registerPlanCommand, ['plan', 'save', file]);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join('\n')).toContain(MOCK_ID);
      expect(planStoreMock.savePlanRecord).toHaveBeenCalledOnce();
    });

    it('plan save --json returns saved:true with planId', async () => {
      planStoreMock.savePlanRecord.mockReturnValue({
        planId: MOCK_ID,
        status: 'pending',
        createdAt: '2024-01-01T00:00:00Z',
        plan: { version: '1.0', steps: [] },
      });
      const file = writePlan({ version: '1.0', steps: [] });
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'save', file]);
      expect(res.exitCode).toBeNull();
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['saved', 'planId']) as { saved: boolean; planId: string };
      expect(data.saved).toBe(true);
      expect(data.planId).toBe(MOCK_ID);
    });

    it('plan list prints each plan on its own line', async () => {
      planStoreMock.listPlanRecords.mockReturnValue([
        { planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] } },
      ]);
      const res = await runCli(registerPlanCommand, ['plan', 'list']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join('\n')).toContain(MOCK_ID.slice(0, 8));
    });

    it('plan list prints helpful message when no plans exist', async () => {
      planStoreMock.listPlanRecords.mockReturnValue([]);
      const res = await runCli(registerPlanCommand, ['plan', 'list']);
      expect(res.exitCode).toBeNull();
      expect(res.stdout.join('\n')).toMatch(/no saved plans/i);
    });

    it('plan list --json returns plans array', async () => {
      planStoreMock.listPlanRecords.mockReturnValue([
        { planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] } },
      ]);
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'list']);
      expect(res.exitCode).toBeNull();
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['plans']) as { plans: Array<{ planId: string }> };
      expect(data.plans[0].planId).toBe(MOCK_ID);
    });

    it('plan review prints plan details', async () => {
      planStoreMock.loadPlanRecord.mockReturnValue({
        planId: MOCK_ID,
        status: 'pending',
        createdAt: '2024-01-01T00:00:00Z',
        plan: { version: '1.0', description: 'turn on lights', steps: [{ type: 'command', deviceId: 'D1', command: 'turnOn' }] },
      });
      const res = await runCli(registerPlanCommand, ['plan', 'review', MOCK_ID]);
      expect(res.exitCode).toBeNull();
      const out = res.stdout.join('\n');
      expect(out).toContain(MOCK_ID);
      expect(out).toContain('pending');
      expect(out).toContain('turn on lights');
    });

    it('plan review exits 2 when planId not found', async () => {
      planStoreMock.loadPlanRecord.mockReturnValue(null);
      const res = await runCli(registerPlanCommand, ['plan', 'review', MOCK_ID]);
      expect(res.exitCode).toBe(2);
    });

    it('plan approve transitions pending to approved', async () => {
      planStoreMock.loadPlanRecord.mockReturnValue({
        planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
      });
      planStoreMock.updatePlanRecord.mockReturnValue({
        planId: MOCK_ID, status: 'approved', createdAt: '2024-01-01T00:00:00Z', approvedAt: '2024-01-01T01:00:00Z', plan: { version: '1.0', steps: [] },
      });
      const res = await runCli(registerPlanCommand, ['plan', 'approve', MOCK_ID]);
      expect(res.exitCode).toBeNull();
      expect(planStoreMock.updatePlanRecord).toHaveBeenCalledWith(MOCK_ID, expect.objectContaining({ status: 'approved' }));
      expect(res.stdout.join('\n')).toMatch(/approved/i);
    });

    it('plan approve exits 2 when plan is already executed', async () => {
      planStoreMock.loadPlanRecord.mockReturnValue({
        planId: MOCK_ID, status: 'executed', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
      });
      const res = await runCli(registerPlanCommand, ['plan', 'approve', MOCK_ID]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/already been executed/i);
    });

    it('plan approve exits 2 when plan was rejected', async () => {
      planStoreMock.loadPlanRecord.mockReturnValue({
        planId: MOCK_ID, status: 'rejected', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
      });
      const res = await runCli(registerPlanCommand, ['plan', 'approve', MOCK_ID]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n')).toMatch(/rejected/i);
    });

    it('plan approve --json returns ok:true', async () => {
      planStoreMock.loadPlanRecord.mockReturnValue({
        planId: MOCK_ID, status: 'pending', createdAt: '2024-01-01T00:00:00Z', plan: { version: '1.0', steps: [] },
      });
      planStoreMock.updatePlanRecord.mockReturnValue({
        planId: MOCK_ID, status: 'approved', createdAt: '2024-01-01T00:00:00Z', approvedAt: '2024-01-01T01:00:00Z', plan: { version: '1.0', steps: [] },
      });
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'approve', MOCK_ID]);
      expect(res.exitCode).toBeNull();
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as Record<string, unknown>;
      const data = expectJsonEnvelopeContainingKeys(out, ['ok', 'planId', 'status']) as { ok: boolean };
      expect(data.ok).toBe(true);
    });
  });
});
