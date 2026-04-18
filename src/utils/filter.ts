import type { Device, InfraredDevice } from '../lib/devices.js';

/**
 * A parsed filter clause. Each clause is an (op, key, value) triple that runs
 * against a candidate device. All clauses from a single expression are AND-ed.
 */
export interface FilterClause {
  key: 'type' | 'family' | 'room' | 'category';
  op: '=' | '~=';
  value: string;
}

export class FilterSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FilterSyntaxError';
  }
}

const VALID_KEYS: FilterClause['key'][] = ['type', 'family', 'room', 'category'];

/**
 * Parse a filter expression like "type=Bot,family=Home" into discrete clauses.
 *
 * Grammar:
 *   expr    := clause ("," clause)*
 *   clause  := KEY OP VALUE
 *   KEY     := type | family | room | category
 *   OP      := "=" | "~="
 *   VALUE   := any non-empty string (no comma — split at the clause boundary)
 *
 * Whitespace around keys / values is trimmed. Empty expressions return [].
 */
export function parseFilter(expr: string | undefined): FilterClause[] {
  if (!expr) return [];
  const parts = expr.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  const clauses: FilterClause[] = [];

  for (const part of parts) {
    const m = /^([a-zA-Z_]+)\s*(~=|=)\s*(.+)$/.exec(part);
    if (!m) {
      throw new FilterSyntaxError(
        `Invalid filter clause "${part}" — expected "<key>=<value>" or "<key>~=<pattern>"`
      );
    }
    const key = m[1] as FilterClause['key'];
    const op = m[2] as FilterClause['op'];
    const value = m[3].trim();
    if (!VALID_KEYS.includes(key)) {
      throw new FilterSyntaxError(
        `Unknown filter key "${key}" — supported: ${VALID_KEYS.join(', ')}`
      );
    }
    if (!value) {
      throw new FilterSyntaxError(`Empty value for filter clause "${part}"`);
    }
    clauses.push({ key, op, value });
  }

  return clauses;
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
  hubLocation?: Map<string, { family?: string; room?: string }>
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

function matches(d: FilterableDevice, clause: FilterClause): boolean {
  const candidate: string | undefined =
    clause.key === 'type'
      ? d.type
      : clause.key === 'family'
        ? d.family
        : clause.key === 'room'
          ? d.room
          : d.category;
  if (candidate === undefined) return false;

  if (clause.op === '=') return candidate.toLowerCase() === clause.value.toLowerCase();

  // '~=' — case-insensitive substring match on the candidate.
  return candidate.toLowerCase().includes(clause.value.toLowerCase());
}

/**
 * Apply the parsed clauses to a mixed list of physical devices + IR remotes.
 * Returns the deviceIds of the entries that satisfy every clause.
 *
 * `hubLocation` (optional) allows family/room filters to match IR remotes by
 * the Hub-inherited location.
 */
export function applyFilter(
  clauses: FilterClause[],
  deviceList: Device[],
  infraredRemoteList: InfraredDevice[],
  hubLocation?: Map<string, { family?: string; room?: string }>
): FilterableDevice[] {
  const candidates: FilterableDevice[] = [
    ...deviceList.map((d) => toFilterable(d, true)),
    ...infraredRemoteList.map((d) => toFilterable(d, false, hubLocation)),
  ];

  if (clauses.length === 0) return candidates;
  return candidates.filter((c) => clauses.every((clause) => matches(c, clause)));
}
