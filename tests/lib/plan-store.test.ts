import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { loadPlanRecord, updatePlanRecord, savePlanRecord, listPlanRecords, type PlanRecord } from '../../src/lib/plan-store.js';
import type { Plan } from '../../src/commands/plan.js';

describe('plan-store security', () => {
  it('loadPlanRecord rejects non-UUID planId (path traversal guard)', () => {
    expect(() => loadPlanRecord('../../etc/passwd')).toThrow(/invalid planId/i);
    expect(() => loadPlanRecord('../other')).toThrow(/invalid planId/i);
    expect(() => loadPlanRecord('not-a-uuid')).toThrow(/invalid planId/i);
  });

  it('updatePlanRecord rejects non-UUID planId', () => {
    expect(() => updatePlanRecord('../../etc/passwd', {})).toThrow(/invalid planId/i);
  });

  it('loadPlanRecord accepts valid UUID v4 (returns null if file does not exist)', () => {
    expect(loadPlanRecord('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('plan-store write + list paths', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('savePlanRecord returns a pending record with a UUID v4 planId', () => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    const plan: Plan = { version: '1.0', steps: [] };
    const record = savePlanRecord(plan);

    expect(record.status).toBe('pending');
    expect(record.plan).toBe(plan);
    expect(record.planId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(fs.writeFileSync).toHaveBeenCalledOnce();
  });

  it('updatePlanRecord throws when the plan record does not exist on disk', () => {
    expect(() =>
      updatePlanRecord('00000000-0000-4000-8000-000000000001', { status: 'approved' }),
    ).toThrow(/not found/i);
  });

  it('listPlanRecords returns empty array when PLANS_DIR is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValueOnce(false);
    expect(listPlanRecords()).toEqual([]);
  });

  it('listPlanRecords returns records sorted oldest-first by createdAt', () => {
    const older: PlanRecord = {
      planId: '00000000-0000-4000-8000-000000000001',
      createdAt: '2024-01-01T00:00:00Z',
      status: 'pending',
      plan: { version: '1.0', steps: [] },
    };
    const newer: PlanRecord = {
      planId: '00000000-0000-4000-8000-000000000002',
      createdAt: '2024-01-02T00:00:00Z',
      status: 'pending',
      plan: { version: '1.0', steps: [] },
    };

    vi.spyOn(fs, 'existsSync').mockReturnValueOnce(true);
    vi.spyOn(fs, 'readdirSync').mockReturnValueOnce(
      ['newer.json', 'older.json'] as unknown as ReturnType<typeof fs.readdirSync>,
    );
    vi.spyOn(fs, 'readFileSync')
      .mockReturnValueOnce(JSON.stringify(newer))
      .mockReturnValueOnce(JSON.stringify(older));

    const result = listPlanRecords();
    expect(result).toHaveLength(2);
    expect(result[0].planId).toBe(older.planId);
    expect(result[1].planId).toBe(newer.planId);
  });
});
