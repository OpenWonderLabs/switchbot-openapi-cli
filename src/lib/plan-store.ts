import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Plan } from '../commands/plan.js';

export const PLANS_DIR = path.join(os.homedir(), '.switchbot', 'plans');

export type PlanStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed';

export interface PlanRecord {
  planId: string;
  createdAt: string;
  status: PlanStatus;
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

export function savePlanRecord(plan: Plan): PlanRecord {
  ensurePlansDir();
  const record: PlanRecord = {
    planId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending',
    plan,
  };
  fs.writeFileSync(planPath(record.planId), JSON.stringify(record, null, 2), { mode: 0o600 });
  return record;
}

export function loadPlanRecord(planId: string): PlanRecord | null {
  try {
    const raw = fs.readFileSync(planPath(planId), 'utf-8');
    return JSON.parse(raw) as PlanRecord;
  } catch {
    return null;
  }
}

export function updatePlanRecord(planId: string, updates: Partial<PlanRecord>): PlanRecord {
  const record = loadPlanRecord(planId);
  if (!record) throw new Error(`Plan ${planId} not found in ${PLANS_DIR}`);
  const updated = { ...record, ...updates };
  fs.writeFileSync(planPath(planId), JSON.stringify(updated, null, 2), { mode: 0o600 });
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
