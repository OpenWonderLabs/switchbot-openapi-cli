/**
 * Pure matching helpers for the rules engine.
 *
 * v0.2 scope:
 *   - `matchesMqttTrigger`   — event + optional deviceId filter
 *   - `classifyMqttPayload`  — heuristic that turns a raw shadow
 *                              payload into a canonical event name
 *   - `evaluateConditions`   — time_between (sync) + device_state
 *                              (async, requires caller-supplied fetcher)
 *
 * All matching stays pure: `evaluateConditions` does not touch the
 * filesystem, network, or globals. Callers inject a `fetchStatus`
 * function; the engine's caller-provided fetcher dedupes per-tick so
 * multiple rules querying the same device share one round trip.
 */

import {
  type Condition,
  type EngineEvent,
  type MqttTrigger,
  isDeviceState,
  isTimeBetween,
} from './types.js';
import { isWithinTuple } from './quiet-hours.js';

/**
 * Mapped states from SwitchBot MQTT shadow payloads. Each entry lists
 * the canonical event name plus the payload-field + value that produces
 * it. Keep this table tiny in the PoC — we widen it as users ask for
 * more event names.
 */
const EVENT_CLASSIFIERS: Array<{
  field: string;
  value: string | RegExp;
  event: string;
}> = [
  { field: 'detectionState', value: 'DETECTED', event: 'motion.detected' },
  { field: 'detectionState', value: 'NOT_DETECTED', event: 'motion.cleared' },
  { field: 'openState', value: 'OPEN', event: 'contact.opened' },
  { field: 'openState', value: 'CLOSE', event: 'contact.closed' },
  { field: 'openState', value: 'TIMEOUT_NOT_CLOSED', event: 'contact.opened' },
];

/** Extract `deviceMac` + a classified event from a shadow message. */
export function classifyMqttPayload(payload: unknown): { event: string; deviceId?: string } {
  const p = payload as Record<string, unknown> | null | undefined;
  const ctx = (p?.context ?? {}) as Record<string, unknown>;
  const deviceId = typeof ctx.deviceMac === 'string' ? ctx.deviceMac : undefined;
  for (const c of EVENT_CLASSIFIERS) {
    const raw = ctx[c.field];
    if (typeof raw !== 'string') continue;
    if (c.value instanceof RegExp ? c.value.test(raw) : raw === c.value) {
      return { event: c.event, deviceId };
    }
  }
  return { event: 'device.shadow', deviceId };
}

/**
 * Compare an MQTT trigger against an `EngineEvent`. We accept a trigger
 * when the event name matches AND the optional `device` filter resolves
 * to the event's deviceId (callers pre-resolve aliases → deviceIds so
 * the matcher stays pure).
 */
export function matchesMqttTrigger(
  trigger: MqttTrigger,
  event: EngineEvent,
  resolvedTriggerDeviceId: string | undefined,
): boolean {
  if (event.source !== 'mqtt') return false;
  if (trigger.event !== event.event && trigger.event !== 'device.shadow') return false;
  if (resolvedTriggerDeviceId && event.deviceId && resolvedTriggerDeviceId !== event.deviceId) {
    return false;
  }
  return true;
}

export interface ConditionEvaluation {
  matched: boolean;
  /** Condition names that failed — makes audit reasons specific. */
  failures: string[];
  /** Condition that referenced a runtime feature the engine can't support here. */
  unsupported: Array<{ keyword: string; hint: string }>;
}

/**
 * Pluggable status fetcher used by device_state conditions. Callers are
 * expected to memoise this per-tick — the matcher does not cache.
 */
export type DeviceStatusFetcher = (deviceId: string) => Promise<Record<string, unknown>>;

export interface EvaluateConditionsContext {
  aliases?: Record<string, string>;
  fetchStatus?: DeviceStatusFetcher;
}

/**
 * Evaluate all conditions; AND-joined. Unsupported conditions short-
 * circuit to "not matched" and surface in `unsupported` so the engine
 * can warn loudly rather than silently drop fires. device_state
 * conditions need `ctx.fetchStatus` — without it they count as
 * unsupported (e.g. lint / dry list paths).
 */
export async function evaluateConditions(
  conditions: Condition[] | null | undefined,
  now: Date,
  ctx: EvaluateConditionsContext = {},
): Promise<ConditionEvaluation> {
  const result: ConditionEvaluation = { matched: true, failures: [], unsupported: [] };
  if (!conditions || conditions.length === 0) return result;

  for (const c of conditions) {
    if (isTimeBetween(c)) {
      if (!isWithinTuple(c.time_between, now)) {
        result.matched = false;
        result.failures.push(
          `time_between ${c.time_between[0]}-${c.time_between[1]} did not include ${now.toTimeString().slice(0, 5)}`,
        );
      }
    } else if (isDeviceState(c)) {
      if (!ctx.fetchStatus) {
        result.matched = false;
        result.unsupported.push({
          keyword: 'device_state',
          hint: 'device_state evaluation requires a live status fetcher; this call site did not provide one.',
        });
        continue;
      }
      const resolved = resolveDeviceRef(c.device, ctx.aliases);
      if (!resolved) {
        result.matched = false;
        result.failures.push(
          `device_state: could not resolve device "${c.device}" to an id (no matching alias).`,
        );
        continue;
      }
      try {
        const status = await ctx.fetchStatus(resolved);
        if (!compareField(status[c.field], c.op, c.value)) {
          result.matched = false;
          const actual = formatValue(status[c.field]);
          const expected = formatValue(c.value);
          result.failures.push(
            `device_state ${c.device}.${c.field} ${c.op} ${expected} (actual: ${actual})`,
          );
        }
      } catch (err) {
        result.matched = false;
        result.failures.push(
          `device_state ${c.device}.${c.field}: fetch failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      result.matched = false;
      result.unsupported.push({
        keyword: 'unknown',
        hint: `Unrecognised condition shape: ${JSON.stringify(c).slice(0, 120)}`,
      });
    }
  }

  return result;
}

function resolveDeviceRef(
  ref: string,
  aliases: Record<string, string> | undefined,
): string | null {
  if (!ref) return null;
  if (aliases && ref in aliases) return aliases[ref];
  // Raw deviceId (MAC / SwitchBot id) — accept as-is.
  return ref;
}

function compareField(actual: unknown, op: '==' | '!=' | '<' | '>' | '<=' | '>=', expected: unknown): boolean {
  // Equality operators run on the raw values so booleans, numbers, and
  // strings all work naturally. Ordering operators coerce to numbers —
  // JSON statuses often arrive as strings like "22.5" so coercion is
  // what people mean when they write `battery >= 20`.
  switch (op) {
    case '==':
      return looseEqual(actual, expected);
    case '!=':
      return !looseEqual(actual, expected);
    case '<':
    case '>':
    case '<=':
    case '>=': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === null || b === null) return false;
      if (op === '<') return a < b;
      if (op === '>') return a > b;
      if (op === '<=') return a <= b;
      return a >= b;
    }
    default:
      return false;
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  // Strings from shadow payloads are case-sensitive for device states
  // (e.g. "on" / "off") — policy authors can match explicitly. Numbers
  // coerce through `Number()` so `"22" == 22` holds.
  if (typeof a === 'number' || typeof b === 'number') {
    const na = toNumber(a);
    const nb = toNumber(b);
    return na !== null && nb !== null && na === nb;
  }
  return String(a) === String(b);
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function formatValue(v: unknown): string {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}
