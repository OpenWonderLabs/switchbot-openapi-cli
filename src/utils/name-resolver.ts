import { loadCache } from '../devices/cache.js';
import { loadDeviceMeta } from '../devices/device-meta.js';
import { levenshtein, normalizeDeviceName } from './string.js';
import { UsageError, StructuredUsageError } from './output.js';

export interface NameMatch {
  deviceId: string;
  name: string;
  score: number;
}

export type NameResolveResult =
  | { ok: true; deviceId: string }
  | { ok: false; ambiguous: true; candidates: NameMatch[] }
  | { ok: false; ambiguous: false };

function resolveDeviceByName(query: string): NameResolveResult {
  const cache = loadCache();
  if (!cache || Object.keys(cache.devices).length === 0) {
    return { ok: false, ambiguous: false };
  }

  const meta = loadDeviceMeta();
  const q = normalizeDeviceName(query);
  const threshold = Math.min(3, Math.floor(q.length * 0.3));

  const candidates: NameMatch[] = [];

  for (const [deviceId, device] of Object.entries(cache.devices)) {
    // alias exact match (highest priority)
    const alias = meta.devices[deviceId]?.alias;
    if (alias && normalizeDeviceName(alias) === q) {
      return { ok: true, deviceId };
    }

    const rawName = normalizeDeviceName(device.name);

    // exact match
    if (rawName === q) return { ok: true, deviceId };

    // alias substring/fuzzy
    if (alias) {
      const normAlias = normalizeDeviceName(alias);
      if (normAlias.includes(q) || q.includes(normAlias)) {
        candidates.push({ deviceId, name: device.name, score: 1 });
        continue;
      }
      const dist = levenshtein(normAlias, q);
      if (dist <= threshold) {
        candidates.push({ deviceId, name: device.name, score: dist + 1 });
        continue;
      }
    }

    // name substring
    if (rawName.includes(q) || q.includes(rawName)) {
      candidates.push({ deviceId, name: device.name, score: 1 });
      continue;
    }

    // levenshtein
    const dist = levenshtein(rawName, q);
    if (dist <= threshold) {
      candidates.push({ deviceId, name: device.name, score: dist + 1 });
    }
  }

  if (candidates.length === 0) return { ok: false, ambiguous: false };

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0].score;
  const top = candidates.filter((c) => c.score <= best + 1);

  if (top.length === 1) return { ok: true, deviceId: top[0].deviceId };
  return { ok: false, ambiguous: true, candidates: top.slice(0, 4) };
}

export function resolveDeviceId(
  deviceId: string | undefined,
  nameQuery: string | undefined
): string {
  if (deviceId && nameQuery) {
    throw new UsageError('Provide either a deviceId argument or --name, not both.');
  }

  if (deviceId) return deviceId;

  if (!nameQuery) {
    throw new UsageError('A deviceId argument or --name flag is required.');
  }

  const cache = loadCache();
  if (!cache) {
    throw new UsageError(
      `--name requires the device cache. Run 'switchbot devices list' first to populate it.`
    );
  }

  const result = resolveDeviceByName(nameQuery);

  if (result.ok) return result.deviceId;

  if (result.ambiguous) {
    throw new StructuredUsageError(
      `"${nameQuery}" is ambiguous — be more specific or use the deviceId directly.`,
      { candidates: result.candidates.map((c) => ({ deviceId: c.deviceId, name: c.name })) }
    );
  }

  throw new UsageError(
    `No device matches "${nameQuery}". Run 'switchbot devices list' to see device names.`
  );
}
