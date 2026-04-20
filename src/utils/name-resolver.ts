import { loadCache } from '../devices/cache.js';
import { loadDeviceMeta } from '../devices/device-meta.js';
import { levenshtein, normalizeDeviceName } from './string.js';
import { UsageError, StructuredUsageError } from './output.js';

export interface NameMatch {
  deviceId: string;
  name: string;
  score: number;
}

export type NameResolveStrategy =
  | 'exact'
  | 'prefix'
  | 'substring'
  | 'fuzzy'
  | 'first'
  | 'require-unique';

export interface NameResolveOptions {
  strategy?: NameResolveStrategy;
  type?: string;
  category?: 'physical' | 'ir';
  room?: string;
}

export type NameResolveResult =
  | { ok: true; deviceId: string }
  | { ok: false; ambiguous: true; candidates: NameMatch[] }
  | { ok: false; ambiguous: false };

const ALL_STRATEGIES: NameResolveStrategy[] = [
  'exact', 'prefix', 'substring', 'fuzzy', 'first', 'require-unique',
];

export function isValidStrategy(s: string): s is NameResolveStrategy {
  return (ALL_STRATEGIES as string[]).includes(s);
}

function resolveDeviceByName(
  query: string,
  opts: NameResolveOptions = {},
): NameResolveResult {
  const strategy: NameResolveStrategy = opts.strategy ?? 'fuzzy';
  const cache = loadCache();
  if (!cache || Object.keys(cache.devices).length === 0) {
    return { ok: false, ambiguous: false };
  }

  const meta = loadDeviceMeta();
  const q = normalizeDeviceName(query);
  const threshold = Math.min(3, Math.floor(q.length * 0.3));

  const typeFilter = opts.type ? opts.type.toLowerCase() : null;
  const roomFilter = opts.room ? opts.room.toLowerCase() : null;

  const candidates: NameMatch[] = [];

  for (const [deviceId, device] of Object.entries(cache.devices)) {
    // narrow filters first
    if (opts.category && device.category !== opts.category) continue;
    if (typeFilter && device.type.toLowerCase() !== typeFilter) continue;
    if (roomFilter) {
      const rn = (device.roomName ?? '').toLowerCase();
      if (rn !== roomFilter && !rn.includes(roomFilter)) continue;
    }

    const alias = meta.devices[deviceId]?.alias;
    const rawName = normalizeDeviceName(device.name);
    const normAlias = alias ? normalizeDeviceName(alias) : null;

    // exact alias/name wins regardless of strategy
    if ((normAlias && normAlias === q) || rawName === q) {
      return { ok: true, deviceId };
    }

    if (strategy === 'exact') continue;

    if (strategy === 'prefix') {
      if ((normAlias && normAlias.startsWith(q)) || rawName.startsWith(q)) {
        candidates.push({ deviceId, name: device.name, score: 1 });
      }
      continue;
    }

    // substring + fuzzy + require-unique + first all share substring match
    if ((normAlias && normAlias.includes(q)) || rawName.includes(q)) {
      candidates.push({ deviceId, name: device.name, score: 1 });
      continue;
    }

    if (strategy === 'substring') continue;

    // fuzzy / require-unique / first → also levenshtein
    if (strategy === 'fuzzy' || strategy === 'require-unique' || strategy === 'first') {
      const distName = levenshtein(rawName, q);
      const distAlias = normAlias ? levenshtein(normAlias, q) : Number.POSITIVE_INFINITY;
      const dist = Math.min(distName, distAlias);
      if (dist <= threshold) {
        candidates.push({ deviceId, name: device.name, score: dist + 1 });
      }
    }
  }

  if (candidates.length === 0) return { ok: false, ambiguous: false };

  candidates.sort((a, b) => a.score - b.score);

  if (strategy === 'first') {
    return { ok: true, deviceId: candidates[0].deviceId };
  }

  if (strategy === 'require-unique') {
    if (candidates.length === 1) return { ok: true, deviceId: candidates[0].deviceId };
    return { ok: false, ambiguous: true, candidates: candidates.slice(0, 4) };
  }

  // fuzzy / substring / prefix: collapse cluster of near-ties
  const best = candidates[0].score;
  const top = candidates.filter((c) => c.score <= best + 1);
  if (top.length === 1) return { ok: true, deviceId: top[0].deviceId };
  return { ok: false, ambiguous: true, candidates: top.slice(0, 4) };
}

export function resolveDeviceId(
  deviceId: string | undefined,
  nameQuery: string | undefined,
  opts: NameResolveOptions = {},
): string {
  if (deviceId && nameQuery) {
    throw new UsageError('Provide either a deviceId argument or --name, not both.');
  }

  if (deviceId) return deviceId;

  if (!nameQuery) {
    throw new UsageError('A deviceId argument or --name flag is required.');
  }

  if (opts.strategy && !isValidStrategy(opts.strategy)) {
    throw new UsageError(
      `--name-strategy must be one of: ${ALL_STRATEGIES.join(', ')} (got "${opts.strategy}")`,
    );
  }

  const cache = loadCache();
  if (!cache) {
    throw new UsageError(
      `--name requires the device cache. Run 'switchbot devices list' first to populate it.`,
    );
  }

  const result = resolveDeviceByName(nameQuery, opts);

  if (result.ok) return result.deviceId;

  if (result.ambiguous) {
    const candidates = result.candidates.map((c) => ({ deviceId: c.deviceId, name: c.name }));
    const narrow: string[] = [];
    if (!opts.type) narrow.push('--type');
    if (!opts.category) narrow.push('--category');
    if (!opts.room) narrow.push('--room');
    const hint = narrow.length > 0
      ? `Narrow with ${narrow.join(' / ')} or use the deviceId directly, or pass --name-strategy first to pick the best match.`
      : `Use the deviceId directly, or pass --name-strategy first to pick the best match.`;
    throw new StructuredUsageError(
      `"${nameQuery}" is ambiguous — ${candidates.length} devices match.`,
      {
        error: 'ambiguous_name_match',
        query: nameQuery,
        candidates,
        hint,
      },
    );
  }

  const noMatchNarrow = opts.type || opts.category || opts.room
    ? ' after applying --type/--category/--room filters'
    : '';
  throw new UsageError(
    `No device matches "${nameQuery}"${noMatchNarrow}. Run 'switchbot devices list' to see device names.`,
  );
}
