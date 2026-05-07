import { createHash } from 'node:crypto';
import type { Rule, EngineEvent, TriggerSource } from './types.js';

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Events that can arrive at very high frequency (e.g. passive motion streams). */
export const HIGH_FREQ_EVENTS = new Set([
  'device.shadow',
  'motion.detected',
  'motion.cleared',
]);

export type EvaluateTraceMode = 'full' | 'sampled' | 'off';

export function shouldWriteTrace(
  mode: EvaluateTraceMode,
  event: EngineEvent,
  decision: TraceDecision,
): boolean {
  if (mode === 'off') return false;
  if (mode === 'full') return true;
  // sampled: suppress blocked-by-condition for high-frequency triggers only
  if (HIGH_FREQ_EVENTS.has(event.event) && decision === 'blocked-by-condition') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Rule version hash
// ---------------------------------------------------------------------------

export function deepSortedJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(deepSortedJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + deepSortedJson(obj[k])).join(',') + '}';
}

export function canonicalizeRule(rule: Rule): string {
  return deepSortedJson(rule);
}

export function ruleVersion(rule: Rule): string {
  return createHash('sha256').update(canonicalizeRule(rule)).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Trace types
// ---------------------------------------------------------------------------

export type TraceDecision = 'fire' | 'dry' | 'throttled' | 'blocked-by-condition' | 'error';

export interface ConditionTrace {
  kind: string;
  config?: unknown;
  passed: boolean | null; // null = not evaluated (short-circuited)
}

export interface RuleEvaluateRecord {
  t: string;
  kind: 'rule-evaluate';
  rule: { name: string; version: string };
  trigger: { source: TriggerSource; event: string; deviceId?: string };
  fireId: string;
  conditions: ConditionTrace[];
  decision: TraceDecision;
  evaluationMs: number;
}

// ---------------------------------------------------------------------------
// TraceBuilder (write side)
// ---------------------------------------------------------------------------

export class TraceBuilder {
  private readonly conditions: ConditionTrace[] = [];
  private readonly startMs: number;

  constructor() {
    this.startMs = Date.now();
  }

  push(entry: ConditionTrace): void {
    this.conditions.push(entry);
  }

  build(
    rule: Rule,
    event: EngineEvent,
    fireId: string,
    decision: TraceDecision,
  ): RuleEvaluateRecord {
    return {
      t: new Date().toISOString(),
      kind: 'rule-evaluate',
      rule: { name: rule.name, version: ruleVersion(rule) },
      trigger: { source: event.source, event: event.event, deviceId: event.deviceId },
      fireId,
      conditions: [...this.conditions],
      decision,
      evaluationMs: Date.now() - this.startMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Read-side filter helpers (shared by audit_query and rules_explain)
// ---------------------------------------------------------------------------

export interface TraceFilterOpts {
  fireId?: string;
  ruleName?: string;
  /** ISO string or parseable date — return records at or after this time. */
  since?: string;
  /** When true, include only records where decision !== 'fire' && decision !== 'dry'. */
  noFireOnly?: boolean;
}

export function filterTraceRecords(
  lines: string[],
  opts: TraceFilterOpts = {},
): RuleEvaluateRecord[] {
  const sinceMs = opts.since ? new Date(opts.since).getTime() : undefined;
  const results: RuleEvaluateRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: RuleEvaluateRecord;
    try {
      entry = JSON.parse(trimmed) as RuleEvaluateRecord;
    } catch {
      continue;
    }
    if (entry.kind !== 'rule-evaluate') continue;
    if (opts.fireId && entry.fireId !== opts.fireId) continue;
    if (opts.ruleName && entry.rule.name !== opts.ruleName) continue;
    if (sinceMs !== undefined && new Date(entry.t).getTime() < sinceMs) continue;
    if (opts.noFireOnly && (entry.decision === 'fire' || entry.decision === 'dry')) continue;
    results.push(entry);
  }

  return results;
}
