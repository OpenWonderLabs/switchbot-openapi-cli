/**
 * Shared filters + aggregations over the audit log for
 * `switchbot rules tail` and `switchbot rules replay`.
 *
 * All functions are pure — no I/O, no clock reads — so they can be
 * unit-tested with fixture arrays. The CLI entry points handle file
 * reading, `--follow` tailing, and human vs JSON rendering.
 */

import type { AuditEntry, AuditEntryKind } from '../utils/audit.js';

/** The subset of audit kinds the rules engine emits. */
export const RULE_AUDIT_KINDS: readonly AuditEntryKind[] = [
  'rule-fire',
  'rule-fire-dry',
  'rule-throttled',
  'rule-webhook-rejected',
] as const;

export interface RuleAuditFilter {
  /** Filter entries with `t >= sinceMs`. Unbounded when undefined. */
  sinceMs?: number;
  /** Filter to a single rule name (matched against entry.rule?.name). */
  ruleName?: string;
  /** Only these kinds are returned. Defaults to RULE_AUDIT_KINDS. */
  kinds?: readonly AuditEntryKind[];
}

/** Keep entries that are rule-engine emitted and match the filter. */
export function filterRuleAudits(
  entries: readonly AuditEntry[],
  filter: RuleAuditFilter = {},
): AuditEntry[] {
  const kinds = new Set<AuditEntryKind>(filter.kinds ?? RULE_AUDIT_KINDS);
  const out: AuditEntry[] = [];
  for (const e of entries) {
    if (!kinds.has(e.kind)) continue;
    if (filter.sinceMs !== undefined) {
      const ms = Date.parse(e.t);
      if (!Number.isFinite(ms) || ms < filter.sinceMs) continue;
    }
    if (filter.ruleName !== undefined) {
      if (e.rule?.name !== filter.ruleName) continue;
    }
    out.push(e);
  }
  return out;
}

export interface RuleSummary {
  /** Rule name as recorded in the audit entry. */
  rule: string;
  /** Number of real (non-dry) fires. */
  fires: number;
  /** Number of dry fires. */
  driesFires: number;
  /** Number of throttled skips. */
  throttled: number;
  /** Number of entries whose `result === 'error'`. */
  errors: number;
  /** fires where result === 'ok' divided by fires + driesFires + errors fired. */
  errorRate: number;
  /** Earliest timestamp observed for this rule (ISO). */
  firstAt: string | null;
  /** Latest timestamp observed for this rule (ISO). */
  lastAt: string | null;
  /** Trigger source observed — 'mixed' if the same rule name spans sources. */
  triggerSource: 'mqtt' | 'cron' | 'webhook' | 'mixed' | null;
}

export interface ReplayReport {
  /** Total entries (after filter) considered. */
  total: number;
  /** Per-rule summaries, sorted by `fires + driesFires` descending. */
  summaries: RuleSummary[];
  /** Count of rule-webhook-rejected entries with no rule name. */
  webhookRejectedCount: number;
}

/** Aggregate a filtered stream into per-rule counters. */
export function aggregateRuleAudits(entries: readonly AuditEntry[]): ReplayReport {
  const byRule = new Map<string, RuleSummary>();
  let webhookRejectedCount = 0;

  for (const e of entries) {
    if (e.kind === 'rule-webhook-rejected' && !e.rule) {
      webhookRejectedCount++;
      continue;
    }
    const name = e.rule?.name;
    if (!name) continue;

    let s = byRule.get(name);
    if (!s) {
      s = {
        rule: name,
        fires: 0,
        driesFires: 0,
        throttled: 0,
        errors: 0,
        errorRate: 0,
        firstAt: null,
        lastAt: null,
        triggerSource: null,
      };
      byRule.set(name, s);
    }

    if (e.kind === 'rule-fire') s.fires++;
    else if (e.kind === 'rule-fire-dry') s.driesFires++;
    else if (e.kind === 'rule-throttled') s.throttled++;
    if (e.result === 'error') s.errors++;

    if (!s.firstAt || e.t < s.firstAt) s.firstAt = e.t;
    if (!s.lastAt || e.t > s.lastAt) s.lastAt = e.t;

    const source = e.rule?.triggerSource;
    if (source) {
      if (s.triggerSource === null) s.triggerSource = source;
      else if (s.triggerSource !== source) s.triggerSource = 'mixed';
    }
  }

  for (const s of byRule.values()) {
    const denom = s.fires + s.driesFires;
    s.errorRate = denom === 0 ? 0 : s.errors / denom;
  }

  const summaries = [...byRule.values()].sort(
    (a, b) => b.fires + b.driesFires - (a.fires + a.driesFires),
  );

  return { total: entries.length, summaries, webhookRejectedCount };
}
