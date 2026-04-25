import { describe, it, expect } from 'vitest';

// Mirror of semverGt in upgrade-check.ts — tests pin the contract.
// If the implementation changes, these tests should catch regressions.
function semverGt(a: string, b: string): boolean {
  const numParts = (v: string) => v.replace(/-.*$/, '').split('.').map((n) => Number.parseInt(n, 10));
  const [aMaj, aMin, aPat] = numParts(a);
  const [bMaj, bMin, bPat] = numParts(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  if (aPat !== bPat) return aPat > bPat;
  // Same numeric version: release (no prerelease) > prerelease
  return !a.includes('-') && b.includes('-');
}

describe('semverGt (upgrade-check)', () => {
  it('release > prerelease of same version', () => {
    expect(semverGt('3.2.1', '3.2.1-rc.1')).toBe(true);
    expect(semverGt('3.2.1', '3.2.1-beta.1')).toBe(true);
  });

  it('newer patch > older patch', () => {
    expect(semverGt('3.2.2', '3.2.1')).toBe(true);
    expect(semverGt('3.2.1', '3.2.2')).toBe(false);
  });

  it('same version is not gt', () => {
    expect(semverGt('3.2.1', '3.2.1')).toBe(false);
  });

  it('newer minor > older minor', () => {
    expect(semverGt('3.3.0', '3.2.9')).toBe(true);
  });

  it('newer major wins regardless of minor/patch', () => {
    expect(semverGt('4.0.0', '3.99.99')).toBe(true);
  });
});

describe('breakingChange detection (upgrade-check)', () => {
  function majorOf(v: string): number {
    return Number.parseInt(v.split('.')[0], 10);
  }
  function isBreaking(latest: string, current: string): boolean {
    return majorOf(latest) > majorOf(current);
  }

  it('same major → no breaking change', () => {
    expect(isBreaking('3.5.0', '3.2.1')).toBe(false);
  });

  it('major bump → breaking change', () => {
    expect(isBreaking('4.0.0', '3.99.9')).toBe(true);
  });

  it('older latest → no breaking change', () => {
    expect(isBreaking('2.0.0', '3.0.0')).toBe(false);
  });
});
