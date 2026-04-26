export interface ReleaseMetadata {
  version: string;
  breaking: boolean;
  summary: string;
}

export const RELEASE_METADATA: ReleaseMetadata[] = [
  {
    version: '3.3.0',
    breaking: true,
    summary: 'JSON output now wraps command payloads in a top-level {schemaVersion,data} envelope; 3.2.x consumers that expected bare payloads must update.',
  },
];

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
