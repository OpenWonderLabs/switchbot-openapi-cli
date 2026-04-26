export interface ReleaseMetadata {
  version: string;
  breaking: boolean;
  summary: string;
}

// Registry of past releases that carry user-visible breaking changes. Consumed
// by `upgrade-check` (to warn operators crossing the boundary) and by `doctor`
// (to surface a notice when the running version itself is a known breaking
// release). Only add entries here for genuine contract breaks — wrong entries
// either cry wolf or mask real breaks.
//
// Historical note: the {schemaVersion,data} JSON envelope is a 2.0.0 change
// (commit 33d3825 "fix!(output): wrap json responses ..."). 3.x callers have
// been consuming the envelope for the entire 3.x line; it is NOT a 3.3.0
// break and must not be listed here.
export const RELEASE_METADATA: ReleaseMetadata[] = [];

function semverParts(v: string): [number, number, number] {
  const [maj, min, pat] = v.replace(/-.*$/, '').split('.').map((n) => Number.parseInt(n, 10));
  return [maj ?? 0, min ?? 0, pat ?? 0];
}

export function semverCompare(a: string, b: string): number {
  const [aMaj, aMin, aPat] = semverParts(a);
  const [bMaj, bMin, bPat] = semverParts(b);
  if (aMaj !== bMaj) return aMaj < bMaj ? -1 : 1;
  if (aMin !== bMin) return aMin < bMin ? -1 : 1;
  if (aPat !== bPat) return aPat < bPat ? -1 : 1;
  const aPre = a.includes('-');
  const bPre = b.includes('-');
  if (aPre === bPre) return 0;
  return aPre ? -1 : 1;
}

export function findBreakingChangeBetween(current: string, latest: string): ReleaseMetadata | null {
  return RELEASE_METADATA
    .filter((m) => m.breaking && semverCompare(m.version, current) > 0 && semverCompare(m.version, latest) <= 0)
    .sort((a, b) => semverCompare(a.version, b.version))[0] ?? null;
}

export function getReleaseMetadata(version: string): ReleaseMetadata | null {
  return RELEASE_METADATA.find((m) => m.version === version) ?? null;
}
