import { describe, it, expect } from 'vitest';
import { DEVICE_CATALOG } from '../../src/devices/catalog.js';

describe('AI MindClip catalog entry', () => {
  const entry = DEVICE_CATALOG.find((e) => e.type === 'AI MindClip');

  it('has a catalog entry', () => {
    expect(entry).toBeDefined();
  });

  it('is read-only (no control commands)', () => {
    expect(entry?.readOnly).toBe(true);
    expect(entry?.commands).toEqual([]);
  });

  it('has the correct category and role', () => {
    expect(entry?.category).toBe('physical');
    expect(entry?.role).toBe('other');
  });

  it('has all 5 status fields in the correct order', () => {
    expect(entry?.statusFields).toEqual([
      'battery',
      'chargingStatus',
      'recordingStatus',
      'uploadStatus',
      'hasUntransferredFiles',
    ]);
  });
});
