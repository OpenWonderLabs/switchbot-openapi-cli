import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEVICE_CATALOG } from '../../src/devices/catalog.js';

interface ObservedCatalogFixture {
  type: string;
  observedAs?: string;
  role: string;
  statusFields: string[];
}

function loadObservedFixtures(): ObservedCatalogFixture[] {
  const p = path.resolve(__dirname, '../fixtures/catalog-fidelity.observed.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8')) as ObservedCatalogFixture[];
}

describe('catalog fidelity fixtures', () => {
  it('keeps observed real-device role/statusFields aligned for pinned device types', () => {
    const fixtures = loadObservedFixtures();
    expect(fixtures.length).toBeGreaterThan(0);

    for (const fixture of fixtures) {
      const entry = DEVICE_CATALOG.find((e) => e.type === fixture.type);
      const label = fixture.observedAs ? `${fixture.observedAs} -> ${fixture.type}` : fixture.type;
      expect(entry, `Missing catalog entry for observed type ${label}`).toBeDefined();
      expect(entry?.role, `${label} role drifted from observed fixture`).toBe(fixture.role);
      expect(
        entry?.statusFields ?? [],
        `${label} statusFields drifted from observed fixture`,
      ).toEqual(fixture.statusFields);
    }
  });

  it('keeps observedAs names resolvable to the pinned catalog entry via type or alias', () => {
    const fixtures = loadObservedFixtures();

    for (const fixture of fixtures) {
      if (!fixture.observedAs) continue;
      const entry = DEVICE_CATALOG.find((e) => e.type === fixture.type);
      expect(entry, `Missing catalog entry for observedAs fixture ${fixture.observedAs}`).toBeDefined();

      const candidates = [entry?.type, ...(entry?.aliases ?? [])]
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.toLowerCase());

      expect(
        candidates,
        `${fixture.observedAs} is no longer resolvable to catalog type ${fixture.type} via type/alias`,
      ).toContain(fixture.observedAs.toLowerCase());
    }
  });
});
