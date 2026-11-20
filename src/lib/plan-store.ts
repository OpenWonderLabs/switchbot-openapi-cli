import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Plan } from '../commands/plan.js';
import { getActiveProfile } from './request-context.js';
import { getConfigPath } from '../utils/flags.js';
import { readCredentialScope } from '../credentials/scope.js';
import { tryLoadConfig } from '../config.js';

export const PLANS_DIR = path.join(os.homedir(), '.switchbot', 'plans');

export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export type PlanCredentialScope =
  | { kind: 'profile'; profile: string }
  | { kind: 'config'; path: string };

export function currentPlanCredentialScope(): PlanCredentialScope {
  const configPath = getConfigPath();
  if (configPath) return { kind: 'config', path: path.resolve(configPath) };
  return { kind: 'profile', profile: getActiveProfile() ?? 'default' };
}

export function isCurrentPlanCredentialScope(scope: PlanCredentialScope | undefined): boolean {
  if (!scope) return false;
  const current = currentPlanCredentialScope();
  if (scope.kind === 'profile' && current.kind === 'profile') {
    return scope.profile === current.profile;
  }
  if (scope.kind === 'config' && current.kind === 'config') {
    return scope.path === current.path;
  }
  return false;
}


export interface PlanRecord {
  planId: string;
  createdAt: string;
  status: PlanStatus;
  /** Credential selector that was active when this plan was saved. */
  credentialScope?: PlanCredentialScope;
  approvedAt?: string;
  executedAt?: string;
  /** Set when status transitions to 'failed'. */
  failedAt?: string;
  /** Summary of why the plan failed (e.g. "1 error, 2 skipped"). */
  failureReason?: string;
  plan: Plan;
}

function ensurePlansDir(): void {
  fs.mkdirSync(PLANS_DIR, { recursive: true, mode: 0o700 });
}

function planPath(planId: string): string {
  return path.join(PLANS_DIR, `${planId}.json`);
}

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertValidPlanId(planId: string): void {
  if (!UUID_V4_RE.test(planId)) {
    throw new Error(`invalid planId: ${planId}`);
  }
}

export class PlanResourceError extends Error {
  constructor(message: string, readonly kind: 'usage' | 'guard' = 'guard',
    readonly hint?: string, readonly context?: Record<string, unknown>) {
    super(message);
  }
}

function syncPlansDirectory(): void {
  // Windows does not support opening directory handles through fs.openSync.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(PLANS_DIR, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function durableWrite(file: string, data: string, flags: 'wx' | 'a'): void {
  const fd = fs.openSync(file, flags, 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

/** Never steal a claim by age/PID: a previous process may already have dispatched. */
export async function withPlanWriteClaim<T>(planId: string, run: () => T | Promise<T>): Promise<T> {
  if (!UUID_V4_RE.test(planId)) throw new PlanResourceError(`Plan ${planId} not found in ${PLANS_DIR}`, 'usage');
  ensurePlansDir();
  const file = path.join(PLANS_DIR, `${planId}.claim`);
  try {
    durableWrite(file, '', 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new PlanResourceError(`Plan ${planId} is in use or an earlier operation was interrupted.`,
      'guard', 'Do not retry this plan. Check the device state before preparing a new plan.');
  }
  syncPlansDirectory();
  try { return await run(); }
  finally {
    fs.unlinkSync(file);
    syncPlansDirectory();
  }
}

/** Private binding: never serialize credentials, their digest, or the revision into a PlanRecord. */
export class PlanAccount {
  private readonly revision: string;
  private readonly fingerprint: string;

  constructor(readonly planId: string = randomUUID()) {
    assertValidPlanId(planId);
    this.revision = readCredentialScope().revision;
    const credentials = tryLoadConfig(); // synchronous; no keychain probe on an offline operation
    this.fingerprint = this.digest(credentials?.token, credentials?.secret, this.revision);
  }

  private digest(token: string | undefined, secret: string | undefined, revision: string): string {
    return createHash('sha256').update(JSON.stringify([this.planId, revision, token, secret])).digest('hex');
  }

  private mismatch(): never {
    throw new PlanResourceError('The saved plan belongs to a different credential binding.', 'guard',
      'Inspect the active account, then save and review a new plan under that account.');
  }

  readonly assertSigningCredentials = (token: string | undefined, secret: string | undefined, revision: string): void => {
    if (this.digest(token, secret, revision) !== this.fingerprint) this.mismatch();
  };

  persist(): void {
    const credentials = tryLoadConfig();
    this.assertSigningCredentials(credentials?.token, credentials?.secret, readCredentialScope().revision);
    durableWrite(path.join(PLANS_DIR, `${this.planId}.account`), this.fingerprint, 'wx');
    syncPlansDirectory();
  }

  static forRecord(record: PlanRecord, mode: 'approve' | 'preview' | 'execute'): PlanAccount {
    const account = new PlanAccount(record.planId);
    let saved: string;
    try { saved = fs.readFileSync(path.join(PLANS_DIR, `${record.planId}.account`), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // No receipt predates account-bound plans. A published change rules out
      // silently inheriting this legacy selector; require a newly saved plan.
      if (account.revision) account.mismatch();
      if (mode === 'approve') account.persist();
      else if (mode === 'execute' && record.plan.steps.some(step => step.type !== 'wait')) {
        throw new PlanResourceError('Legacy approval is not bound to the current account.', 'guard',
          `Inspect the account and run plan review ${record.planId}, then plan approve ${record.planId}.`);
      }
      return account;
    }
    if (saved !== account.fingerprint) account.mismatch();
    return account;
  }
}

type StepEvent = { step: number; state: 'started' | 'rejected' | 'ok'; result?: unknown };

/** Private append-only receipts, independent of approval/status changes. Access only under the claim. */
export class PlanStepJournal {
  private readonly file: string;
  private readonly completed = new Map<number, unknown>();
  private started?: number;

  constructor(record: PlanRecord, mode: 'approve' | 'execute') {
    assertValidPlanId(record.planId);
    this.file = path.join(PLANS_DIR, `${record.planId}.steps`);
    const fingerprint = createHash('sha256').update(JSON.stringify([record.plan, record.credentialScope])).digest('hex');
    let contents: string;
    try { contents = fs.readFileSync(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (record.status === 'failed' || record.failedAt) throw new PlanResourceError('Previously failed plan has no step receipts; its outcomes are unknown.',
        'guard', 'Inspect the targets before saving a new plan containing only the remaining actions.');
      if (mode === 'execute' && record.plan.steps.some(step => step.type !== 'wait')) {
        throw new PlanResourceError('No approval receipt for this plan; refusing to dispatch.',
          'guard', 'Review the plan and explicitly approve its current contents.');
      }
      durableWrite(this.file, `${fingerprint}\n`, 'wx');
      syncPlansDirectory();
      return;
    }
    const [header, ...lines] = contents.split('\n');
    if (header !== fingerprint || lines.pop() !== '') throw new PlanResourceError('Plan step journal is incomplete or does not match the saved plan.');
    for (const line of lines) {
      let event: StepEvent;
      try { event = JSON.parse(line); } catch { throw new PlanResourceError('Unreadable plan step receipt; refusing to execute.'); }
      if (!event || !Number.isInteger(event.step) || event.step < 1 || event.step > record.plan.steps.length ||
          this.completed.has(event.step) || (event.state === 'started' ? this.started !== undefined : event.step !== this.started)) {
        throw new PlanResourceError('Plan step journal is inconsistent; refusing to execute.');
      }
      if (event.state === 'started') this.started = event.step;
      else {
        if (event.state === 'ok') this.completed.set(event.step, event.result);
        else if (event.state !== 'rejected') throw new PlanResourceError('Unrecognized plan step receipt.');
        this.started = undefined;
      }
    }
    if (this.started !== undefined) throw new PlanResourceError(`Outcome of plan step ${this.started} is unknown; it will not be sent again.`,
      'guard', 'Check the device state before saving and approving a new plan.');
  }

  get uncertain(): boolean { return this.started !== undefined; }

  async dispatch<T>(step: number, operation: () => Promise<T>, definitelyRejected: (err: unknown) => boolean): Promise<T> {
    if (this.completed.has(step)) return this.completed.get(step) as T;
    if (this.uncertain) throw new PlanResourceError('Earlier step outcome is unknown; refusing to dispatch.');
    this.started = step;
    this.append({ step, state: 'started' });
    let result: T;
    try { result = await operation(); }
    catch (err) {
      if (definitelyRejected(err)) {
        this.append({ step, state: 'rejected' });
        this.started = undefined;
      }
      throw err;
    }
    this.append({ step, state: 'ok', result });
    this.started = undefined;
    this.completed.set(step, result);
    return result;
  }

  private append(event: StepEvent): void {
    durableWrite(this.file, `${JSON.stringify(event)}\n`, 'a');
  }
}

export function savePlanRecord(plan: Plan, account = new PlanAccount()): PlanRecord {
  ensurePlansDir();
  const record: PlanRecord = {
    planId: account.planId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    credentialScope: currentPlanCredentialScope(),
    plan,
  };
  account.persist();
  durableWrite(planPath(record.planId), JSON.stringify(record, null, 2), 'wx');
  syncPlansDirectory();
  return record;
}

export function loadPlanRecord(planId: string): PlanRecord | null {
  assertValidPlanId(planId);
  try {
    const raw = fs.readFileSync(planPath(planId), 'utf-8');
    return JSON.parse(raw) as PlanRecord;
  } catch {
    return null;
  }
}

export function updatePlanRecord(planId: string, updates: Partial<PlanRecord>): PlanRecord {
  assertValidPlanId(planId);
  const record = loadPlanRecord(planId);
  if (!record) throw new Error(`Plan ${planId} not found in ${PLANS_DIR}`);
  const updated = { ...record, ...updates };
  const temp = path.join(PLANS_DIR, `${planId}.${randomUUID()}.tmp`);
  try {
    durableWrite(temp, JSON.stringify(updated, null, 2), 'wx');
    fs.renameSync(temp, planPath(planId));
    syncPlansDirectory();
  } finally { fs.rmSync(temp, { force: true }); }
  return updated;
}

export function listPlanRecords(): PlanRecord[] {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    return fs
      .readdirSync(PLANS_DIR)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(fs.readFileSync(path.join(PLANS_DIR, f), 'utf-8')) as PlanRecord];
        } catch {
          return [];
        }
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}
