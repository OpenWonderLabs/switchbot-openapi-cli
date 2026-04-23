/**
 * Runtime TypeScript shapes for policy v0.2 rule objects.
 *
 * These are hand-mirrored from `src/policy/schema/v0.2.json` — the ajv
 * validator is the source of truth for what a file may contain, this
 * file is the source of truth for what the engine expects after load.
 * When you edit one, edit the other in the same commit.
 */

import type { DestructiveCommand } from './destructive.js';

export type TriggerSource = 'mqtt' | 'cron' | 'webhook';

export interface MqttTrigger {
  source: 'mqtt';
  /**
   * Event name matched against the engine's event classifier. Known
   * values today: `device.shadow` (catch-all), `motion.detected`,
   * `motion.cleared`, `contact.opened`, `contact.closed`.
   */
  event: string;
  /** Optional filter by deviceId or alias. */
  device?: string;
}

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'
  | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface CronTrigger {
  source: 'cron';
  /** Standard 5-field cron (minute hour dom month dow), local tz. */
  schedule: string;
  /**
   * Optional weekday filter applied AFTER the cron expression fires.
   * When omitted, every firing passes. Values are matched
   * case-insensitively against the local weekday name.
   */
  days?: DayOfWeek[];
}

export interface WebhookTrigger {
  source: 'webhook';
  /** Local HTTP path the rule engine listens on, e.g. `/kitchen/motion`. */
  path: string;
}

export type Trigger = MqttTrigger | CronTrigger | WebhookTrigger;

export interface TimeBetweenCondition {
  time_between: [string, string];
}

export interface DeviceStateCondition {
  device: string;
  field: string;
  op: '==' | '!=' | '<' | '>' | '<=' | '>=';
  value: unknown;
}

export interface AllCondition {
  all: Condition[];
}

export interface AnyCondition {
  any: Condition[];
}

export interface NotCondition {
  not: Condition;
}

export type Condition = TimeBetweenCondition | DeviceStateCondition | AllCondition | AnyCondition | NotCondition;

export interface Action {
  command: string;
  device?: string;
  args?: Record<string, unknown> | null;
  on_error?: 'continue' | 'stop';
}

export interface Throttle {
  max_per: string;
}

export interface Rule {
  name: string;
  enabled?: boolean;
  when: Trigger;
  conditions?: Condition[] | null;
  then: Action[];
  throttle?: Throttle | null;
  dry_run?: boolean;
}

export interface AutomationBlock {
  enabled?: boolean;
  rules?: Rule[] | null;
}

/**
 * Engine event — unified shape the matcher consumes regardless of
 * trigger source.
 */
export interface EngineEvent {
  source: TriggerSource;
  /** Classifier output for MQTT; schedule string for cron; path for webhook. */
  event: string;
  t: Date;
  /** Resolved deviceId if the trigger carried one (MQTT). */
  deviceId?: string;
  /** Raw trigger payload for inspection / audit. */
  payload?: unknown;
}

/** Guards used outside this file. */
export function isMqttTrigger(t: Trigger): t is MqttTrigger {
  return t.source === 'mqtt';
}
export function isCronTrigger(t: Trigger): t is CronTrigger {
  return t.source === 'cron';
}
export function isWebhookTrigger(t: Trigger): t is WebhookTrigger {
  return t.source === 'webhook';
}
export function isTimeBetween(c: Condition): c is TimeBetweenCondition {
  return Array.isArray((c as TimeBetweenCondition).time_between);
}
export function isDeviceState(c: Condition): c is DeviceStateCondition {
  const d = c as DeviceStateCondition;
  return typeof d.device === 'string' && typeof d.field === 'string' && typeof d.op === 'string';
}
export function isAllCondition(c: Condition): c is AllCondition {
  return Array.isArray((c as AllCondition).all);
}
export function isAnyCondition(c: Condition): c is AnyCondition {
  return Array.isArray((c as AnyCondition).any);
}
export function isNotCondition(c: Condition): c is NotCondition {
  return (c as NotCondition).not !== undefined && !Array.isArray((c as NotCondition).not);
}

/** Re-export for consumers that want the single list without a second import. */
export type { DestructiveCommand };
