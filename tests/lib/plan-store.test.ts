import { describe, it, expect } from 'vitest';
import { loadPlanRecord, updatePlanRecord } from '../../src/lib/plan-store.js';

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
