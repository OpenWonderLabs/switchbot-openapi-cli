/**
 * Regression tests for the plan resource model (save/list/review/approve/execute)
 * and the JSON error contract for plan subcommands.
 *
 * Bugs covered:
 *   1. plan execute marks status=executed even on error/skipped steps.
 *   2. plan approve/review/execute emit bare console.error instead of structured
 *      error envelope under --json.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

// ── api client mock ─────────────────────────────────────────────────────────
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

// ── device cache mock ────────────────────────────────────────────────────────
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

// ── flags mock ───────────────────────────────────────────────────────────────
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

// ── plan-store in-memory mock ────────────────────────────────────────────────
type PlanStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';
interface StoredPlan { version: string; steps: unknown[] }
interface PlanRecord {
  planId: string;
  createdAt: string;
  status: PlanStatus;
  approvedAt?: string;
  executedAt?: string;
  failedAt?: string;
  failureReason?: string;
  plan: StoredPlan;
}

const planStore = vi.hoisted(() => {
  const store = new Map<string, PlanRecord>();
  return {
    store,
    PLANS_DIR: '/mock/plans',
    savePlanRecord: vi.fn((plan: StoredPlan): PlanRecord => {
      const record: PlanRecord = { planId: randomUUID(), createdAt: new Date().toISOString(), status: 'pending', plan };
      store.set(record.planId, record);
      return record;
    }),
    loadPlanRecord: vi.fn((planId: string): PlanRecord | null => store.get(planId) ?? null),
    updatePlanRecord: vi.fn((planId: string, updates: Partial<PlanRecord>): PlanRecord => {
      const r = store.get(planId);
      if (!r) throw new Error(`Plan ${planId} not found`);
      const updated = { ...r, ...updates };
      store.set(planId, updated);
      return updated;
    }),
    listPlanRecords: vi.fn((): PlanRecord[] => [...store.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))),
  };
});
vi.mock('../../src/lib/plan-store.js', () => planStore);

import { registerPlanCommand } from '../../src/commands/plan.js';
import { runCli } from '../helpers/cli.js';

// ── helpers ──────────────────────────────────────────────────────────────────
function simplePlan(): StoredPlan {
  return { version: '1.0', steps: [{ type: 'command', deviceId: 'BOT1', command: 'turnOn' }] };
}

function lockPlan(): StoredPlan {
  return { version: '1.0', steps: [{ type: 'command', deviceId: 'LOCK1', command: 'unlock' }] };
}

function parseJsonOutput(stdout: string[]): Record<string, unknown> {
  const line = stdout.find((l) => l.trim().startsWith('{'));
  if (!line) throw new Error('No JSON line in stdout: ' + JSON.stringify(stdout));
  return JSON.parse(line) as Record<string, unknown>;
}

function makeApproved(plan: StoredPlan): PlanRecord {
  const r = planStore.savePlanRecord(plan);
  return planStore.updatePlanRecord(r.planId, { status: 'approved', approvedAt: new Date().toISOString() });
}

// ── tests ────────────────────────────────────────────────────────────────────
describe('plan resource model', () => {
  beforeEach(() => {
    planStore.store.clear();
    planStore.savePlanRecord.mockClear();
    planStore.loadPlanRecord.mockClear();
    planStore.updatePlanRecord.mockClear();
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
    flagsMock.dryRun = false;
  });

  // ── plan execute status machine ──────────────────────────────────────────
  describe('plan execute — status transitions', () => {
    it('marks status=executed when all steps succeed', async () => {
      const record = makeApproved(simplePlan());
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

      await runCli(registerPlanCommand, ['plan', 'execute', record.planId, '--yes']);

      const updated = planStore.store.get(record.planId);
      expect(updated?.status).toBe('executed');
      expect(updated?.executedAt).toBeDefined();
      expect(updated?.failedAt).toBeUndefined();
    });

    it('marks status=failed (not executed) when a step errors', async () => {
      const record = makeApproved(simplePlan());
      apiMock.__instance.post.mockRejectedValue(new Error('network error'));

      const res = await runCli(registerPlanCommand, ['plan', 'execute', record.planId, '--yes', '--continue-on-error']);

      expect(res.exitCode).toBe(1);
      const updated = planStore.store.get(record.planId);
      expect(updated?.status).toBe('failed');
      expect(updated?.failedAt).toBeDefined();
      expect(updated?.failureReason).toMatch(/error/);
      expect(updated?.executedAt).toBeUndefined();
    });

    it('marks status=failed when a destructive step is skipped (no --yes)', async () => {
      cacheMock.map.set('LOCK1', { type: 'Smart Lock', name: 'Front', category: 'physical' });
      const record = makeApproved(lockPlan());

      const res = await runCli(registerPlanCommand, ['plan', 'execute', record.planId]);

      expect(res.exitCode).toBe(1);
      const updated = planStore.store.get(record.planId);
      expect(updated?.status).toBe('failed');
      expect(updated?.failureReason).toMatch(/skipped/);
      expect(updated?.executedAt).toBeUndefined();
    });

    it('failed plan can be re-approved and retried', async () => {
      const record = planStore.savePlanRecord(simplePlan());
      planStore.updatePlanRecord(record.planId, {
        status: 'failed',
        failedAt: new Date().toISOString(),
        failureReason: '1 error',
      });

      await runCli(registerPlanCommand, ['plan', 'approve', record.planId]);
      expect(planStore.store.get(record.planId)?.status).toBe('approved');

      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });
      await runCli(registerPlanCommand, ['plan', 'execute', record.planId, '--yes']);
      expect(planStore.store.get(record.planId)?.status).toBe('executed');
    });

    it('--json output includes succeeded:true on clean run', async () => {
      const record = makeApproved(simplePlan());
      apiMock.__instance.post.mockResolvedValue({ data: { statusCode: 100, body: {} } });

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'execute', record.planId, '--yes']);
      const out = (parseJsonOutput(res.stdout).data as Record<string, unknown>);
      expect(out.succeeded).toBe(true);
      expect(out.ran).toBe(true);
    });

    it('--json output includes succeeded:false on failed run', async () => {
      const record = makeApproved(simplePlan());
      apiMock.__instance.post.mockRejectedValue(new Error('boom'));

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'execute', record.planId, '--yes', '--continue-on-error']);
      const out = (parseJsonOutput(res.stdout).data as Record<string, unknown>);
      expect(out.succeeded).toBe(false);
      expect(out.ran).toBe(true);
    });
  });

  // ── JSON error contract ──────────────────────────────────────────────────
  describe('plan subcommands — JSON error contract', () => {
    it('plan review --json emits error envelope for unknown planId', async () => {
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'review', 'no-such-plan']);
      expect(res.exitCode).toBe(2);
      const out = parseJsonOutput(res.stdout);
      expect(out.error).toBeDefined();
      expect((out.error as Record<string, unknown>).code).toBe(2);
      expect((out.error as Record<string, unknown>).message).toMatch(/not found/i);
    });

    it('plan approve --json emits error envelope for already-executed plan', async () => {
      const record = planStore.savePlanRecord(simplePlan());
      planStore.updatePlanRecord(record.planId, { status: 'executed', executedAt: new Date().toISOString() });

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'approve', record.planId]);
      expect(res.exitCode).toBe(2);
      const out = parseJsonOutput(res.stdout);
      expect((out.error as Record<string, unknown>).message).toMatch(/already been executed/i);
    });

    it('plan approve --json emits error envelope for rejected plan', async () => {
      const record = planStore.savePlanRecord(simplePlan());
      planStore.updatePlanRecord(record.planId, { status: 'rejected' });

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'approve', record.planId]);
      expect(res.exitCode).toBe(2);
      const out = parseJsonOutput(res.stdout);
      expect((out.error as Record<string, unknown>).message).toMatch(/rejected/i);
    });

    it('plan execute --json emits error envelope for pending plan (not approved)', async () => {
      const record = planStore.savePlanRecord(simplePlan());
      // status is 'pending' by default

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'execute', record.planId]);
      expect(res.exitCode).toBe(2);
      const out = parseJsonOutput(res.stdout);
      const err = out.error as Record<string, unknown>;
      expect(err.message).toMatch(/cannot be executed/i);
      expect((err.context as Record<string, unknown>)?.status).toBe('pending');
    });

    it('plan execute --json emits error envelope when plan not found', async () => {
      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'execute', 'ghost-id']);
      expect(res.exitCode).toBe(2);
      const out = parseJsonOutput(res.stdout);
      expect((out.error as Record<string, unknown>).code).toBe(2);
    });

    it('plan approve --json returns ok:true on success', async () => {
      const record = planStore.savePlanRecord(simplePlan());

      const res = await runCli(registerPlanCommand, ['--json', 'plan', 'approve', record.planId]);
      expect(res.exitCode).not.toBe(2);
      const out = parseJsonOutput(res.stdout);
      expect((out.data as Record<string, unknown>).ok).toBe(true);
      expect((out.data as Record<string, unknown>).status).toBe('approved');
    });
  });
});
