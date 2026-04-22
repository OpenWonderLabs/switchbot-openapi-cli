/**
 * Pure matching helpers for the rules engine.
 *
 * v0.2 PoC scope:
 *   - `matchesMqttTrigger`   — event + optional deviceId filter
 *   - `classifyMqttPayload`  — heuristic that turns a raw shadow
 *                              payload into a canonical event name
 *   - `evaluateConditions`   — currently implements `time_between`
 *                              only. `device_state` is recognised as
 *                              a known-but-unsupported condition so
 *                              lint can flag it cleanly; E3 will fill
 *                              it in.
 *
 * Everything here is synchronous and side-effect-free. The engine owns
 * all IO.
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
  /** Condition that referenced a runtime feature the PoC doesn't support. */
  unsupported: Array<{ keyword: string; hint: string }>;
}

/**
 * Evaluate all conditions; AND-joined. Unsupported conditions currently
 * short-circuit to "not matched" and surface in `unsupported` — the
 * engine uses this to warn loudly rather than silently dropping fires.
 */
export function evaluateConditions(
  conditions: Condition[] | null | undefined,
  now: Date,
): ConditionEvaluation {
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
      result.matched = false;
      result.unsupported.push({
        keyword: 'device_state',
        hint: 'device_state conditions require live status fetch — supported in v0.3+ (E3 follow-up)',
      });
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
