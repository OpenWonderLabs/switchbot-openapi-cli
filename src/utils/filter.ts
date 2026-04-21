import type { Device, InfraredDevice } from '../lib/devices.js';

/**
 * A parsed filter clause. Each clause is an (op, key, value) triple that runs
 * against a candidate string. All clauses from a single expression are AND-ed.
 *
 * Four operators (shared across `devices list`, `devices batch`,
 * `events tail` / `mqtt-tail`):
 *   key=value      — case-insensitive substring (exact for `category`)
 *   key!=value     — negated substring (exact-negated for `category`)
 *   key~value      — explicit case-insensitive substring
 *   key=/pattern/  — case-insensitive regex
 */
export type FilterOp = 'eq' | 'neq' | 'sub' | 'regex';

export interface FilterClause {
  key: string;
  op: FilterOp;
  raw: string;
  regex?: RegExp;
}

export interface ParseFilterOptions {
  resolveKey?: (key: string) => string;
  supportedKeys?: readonly string[];
}

export class FilterSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterSyntaxError';
  }
}

/**
 * Parse a comma-separated filter expression into discrete clauses.
 *
 * Grammar (per clause, recognition order):
 *   1. key=/pattern/   → regex (case-insensitive); invalid regex throws.
 *   2. key!=value      → 'neq' op (negated substring; exact-negated for keys
 *                        listed in matchClause's `exactKeys` option).
 *   3. key~value       → substring (case-insensitive).
 *   4. key=value       → 'eq' op (substring; caller decides whether to treat
 *                        as exact for specific keys via matchClause's
 *                        `exactKeys` option).
 *
 * `allowedKeys` is command-specific: `devices list` uses
 * {type,name,category,room}; `devices batch` uses {type,family,room,category};
 * `events tail` uses {deviceId,type}.
 */
export function parseFilterExpr(
  expr: string | undefined,
  allowedKeys: readonly string[],
  options?: ParseFilterOptions,
): FilterClause[] {
  if (!expr) return [];
  const parts = expr.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  const clauses: FilterClause[] = [];

  for (const part of parts) {
    const regexMatch = /^([^=~!]+)=\/(.*)\/$/.exec(part);
    const neqIdx = part.indexOf('!=');
    const tildeIdx = part.indexOf('~');
    const eqIdx = part.indexOf('=');

    let key: string;
    let op: FilterOp;
    let raw: string;
    let regex: RegExp | undefined;

    if (regexMatch) {
      key = regexMatch[1].trim();
      op = 'regex';
      raw = regexMatch[2];
      try {
        regex = new RegExp(raw, 'i');
      } catch (err) {
        throw new FilterSyntaxError(
          `Invalid regex in --filter "${part}": ${(err as Error).message}`,
        );
      }
    } else if (neqIdx !== -1 && (tildeIdx === -1 || neqIdx < tildeIdx)) {
      key = part.slice(0, neqIdx).trim();
      op = 'neq';
      raw = part.slice(neqIdx + 2).trim();
    } else if (tildeIdx !== -1 && (eqIdx === -1 || tildeIdx < eqIdx)) {
      key = part.slice(0, tildeIdx).trim();
      op = 'sub';
      raw = part.slice(tildeIdx + 1).trim();
      if (raw.startsWith('=')) {
        throw new FilterSyntaxError(
          `Invalid filter clause "${part}" — "~=" is no longer supported. Use "${key}~${raw.slice(1)}" instead.`,
        );
      }
    } else if (eqIdx !== -1) {
      key = part.slice(0, eqIdx).trim();
      op = 'eq';
      raw = part.slice(eqIdx + 1).trim();
    } else {
      throw new FilterSyntaxError(
        `Invalid filter clause "${part}" — expected "<key>=<value>", "<key>!=<value>", "<key>~<value>", or "<key>=/<regex>/"`,
      );
    }

    if (!key) {
      throw new FilterSyntaxError(`Empty key in filter clause "${part}"`);
    }
    if (!raw) {
      throw new FilterSyntaxError(`Empty value for filter clause "${part}"`);
    }
    let resolvedKey = key;
    if (options?.resolveKey) {
      try {
        resolvedKey = options.resolveKey(key);
      } catch (err) {
        if (err instanceof Error) {
          throw new FilterSyntaxError(err.message);
        }
        throw err;
      }
    }

    if (!allowedKeys.includes(resolvedKey)) {
      const printableKeys = options?.supportedKeys ?? allowedKeys;
      throw new FilterSyntaxError(
        `Unknown filter key "${key}" – supported: ${printableKeys.join(', ')}`,
      );
    }

    clauses.push({ key: resolvedKey, op, raw, regex });
  }

  return clauses;
}

/**
 * Match a single candidate string against a clause.
 *
 * - `regex` → RegExp.test against the candidate (case-insensitive by construction).
 * - `sub`   → case-insensitive substring.
 * - `eq`    → case-insensitive substring, except for keys listed in
 *             `exactKeys`, which get case-insensitive exact comparison.
 *             Default `exactKeys` is `['category']` to preserve the existing
 *             list/batch behavior for that key.
 * - `neq`   → logical inverse of `eq` (negated substring; exact-negated for
 *             `exactKeys`). `undefined` candidates remain non-matching so a
 *             `neq` clause does NOT accidentally match missing data.
 */
export function matchClause(
  candidate: string | undefined,
  clause: FilterClause,
  options?: { exactKeys?: readonly string[] },
): boolean {
  if (candidate === undefined) {
    // Missing field: `neq` treats absence as "definitely not X"; everything
    // else treats it as "no evidence — don't match".
    return clause.op === 'neq';
  }
  if (clause.op === 'regex') {
    return clause.regex!.test(candidate);
  }
  const cLower = candidate.toLowerCase();
  const vLower = clause.raw.toLowerCase();
  if (clause.op === 'sub') {
    return cLower.includes(vLower);
  }
  const exactKeys = options?.exactKeys ?? ['category'];
  const exact = exactKeys.includes(clause.key);
  if (clause.op === 'neq') {
    return exact ? cLower !== vLower : !cLower.includes(vLower);
  }
  if (exact) {
    return cLower === vLower;
  }
  return cLower.includes(vLower);
}

const BATCH_KEYS = ['type', 'family', 'room', 'category'] as const;

/**
 * Back-compat narrow signature: parses with the batch key set. Callers that
 * need a different key set (list, events tail) should call parseFilterExpr
 * directly.
 */
export function parseFilter(expr: string | undefined): FilterClause[] {
  return parseFilterExpr(expr, BATCH_KEYS);
}

interface FilterableDevice {
  deviceId: string;
  type: string;
  family?: string;
  room?: string;
  category: 'physical' | 'ir';
}

/** Normalize a physical / IR device entry to the shape the filter matcher expects. */
function toFilterable(
  d: Device | InfraredDevice,
  isPhysical: boolean,
  hubLocation?: Map<string, { family?: string; room?: string }>,
): FilterableDevice {
  if (isPhysical) {
    const p = d as Device;
    return {
      deviceId: p.deviceId,
      type: p.deviceType ?? '',
      family: p.familyName ?? undefined,
      room: p.roomName ?? undefined,
      category: 'physical',
    };
  }
  const ir = d as InfraredDevice;
  const inherited = hubLocation?.get(ir.hubDeviceId);
  return {
    deviceId: ir.deviceId,
    type: ir.remoteType ?? '',
    family: inherited?.family,
    room: inherited?.room,
    category: 'ir',
  };
}

function candidateFor(d: FilterableDevice, key: string): string | undefined {
  switch (key) {
    case 'type':
      return d.type;
    case 'family':
      return d.family;
    case 'room':
      return d.room;
    case 'category':
      return d.category;
    default:
      return undefined;
  }
}

/**
 * Apply the parsed clauses to a mixed list of physical devices + IR remotes.
 * Returns the filterable entries that satisfy every clause.
 */
export function applyFilter(
  clauses: FilterClause[],
  deviceList: Device[],
  infraredRemoteList: InfraredDevice[],
  hubLocation?: Map<string, { family?: string; room?: string }>,
): FilterableDevice[] {
  const candidates: FilterableDevice[] = [
    ...deviceList.map((d) => toFilterable(d, true)),
    ...infraredRemoteList.map((d) => toFilterable(d, false, hubLocation)),
  ];

  if (clauses.length === 0) return candidates;
  return candidates.filter((c) =>
    clauses.every((clause) => matchClause(candidateFor(c, clause.key), clause)),
  );
}
