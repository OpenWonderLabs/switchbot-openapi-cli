import fs from 'node:fs';
import path from 'node:path';
import { getAuditLog } from './flags.js';

/**
 * Bump when breaking changes to the audit line shape land.
 *
 * History:
 *   1 — initial command audit (kind: 'command' only).
 *   2 — adds rule-engine kinds ('rule-fire', 'rule-fire-dry',
 *       'rule-throttled', 'rule-webhook-rejected') and a sibling `rule`
 *       block describing which rule fired and why. Reader stays backwards
 *       compatible: v1 lines parse as command entries with `rule`
 *       undefined.
 */
export const AUDIT_VERSION = 2;

export type AuditEntryKind =
  | 'command'
  | 'rule-fire'
  | 'rule-fire-dry'
  | 'rule-throttled'
  | 'rule-webhook-rejected';

export interface AuditRuleContext {
  /** Rule.name from policy.yaml. */
  name: string;
  /** Where the trigger came from. */
  triggerSource: 'mqtt' | 'cron' | 'webhook';
  /** Resolved deviceId the rule fired against, if any. */
  matchedDevice?: string;
  /** UUID correlating multi-action fires + throttle entries. */
  fireId: string;
  /** Optional free-text reason the engine recorded alongside the fire
   * (e.g. "throttled: 8s since last fire", "destructive command blocked"). */
  reason?: string;
}

export interface AuditEntry {
  /** Schema version — lets old log lines coexist with new ones after format changes. */
  auditVersion?: number;
  t: string;
  kind: AuditEntryKind;
  deviceId: string;
  command: string;
  parameter: unknown;
  commandType: 'command' | 'customize';
  dryRun: boolean;
  result?: 'ok' | 'error';
  error?: string;
  /** Present for rule-engine kinds; absent for direct CLI command entries. */
  rule?: AuditRuleContext;
}

function resolveAuditPath(): string | null {
  const flag = getAuditLog();
  if (flag === null) return null;
  return path.resolve(flag);
}

export function writeAudit(entry: AuditEntry): void {
  const file = resolveAuditPath();
  if (!file) return;
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const stamped: AuditEntry = { auditVersion: AUDIT_VERSION, ...entry };
    fs.appendFileSync(file, JSON.stringify(stamped) + '\n');
  } catch {
    // Best-effort — never let audit failures break the actual command.
  }
}

export function readAudit(file: string): AuditEntry[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf-8');
  const out: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AuditEntry);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

/**
 * Result of a structural audit log check. See `history verify` for the CLI
 * surface. Malformed lines cause a `problems` entry, missing auditVersion
 * fields cause a `warnings` entry (treated as "pre-v1 record, still parseable").
 */
export interface VerifyReport {
  file: string;
  totalLines: number;
  parsedLines: number;
  skippedBlankLines: number;
  malformedLines: number;
  unversionedEntries: number;
  versionCounts: Record<string, number>;
  problems: Array<{ line: number; reason: string; preview?: string }>;
  earliest?: string;
  latest?: string;
  fileMissing?: boolean;
}

export function verifyAudit(file: string): VerifyReport {
  const report: VerifyReport = {
    file,
    totalLines: 0,
    parsedLines: 0,
    skippedBlankLines: 0,
    malformedLines: 0,
    unversionedEntries: 0,
    versionCounts: {},
    problems: [],
  };
  if (!fs.existsSync(file)) {
    report.fileMissing = true;
    return report;
  }
  const raw = fs.readFileSync(file, 'utf-8');
  const lines = raw.split(/\r?\n/);
  let minT: string | undefined;
  let maxT: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      report.skippedBlankLines++;
      continue;
    }
    report.totalLines++;
    let entry: AuditEntry | null = null;
    try {
      entry = JSON.parse(trimmed) as AuditEntry;
    } catch {
      report.malformedLines++;
      report.problems.push({
        line: i + 1,
        reason: 'JSON parse failed',
        preview: trimmed.slice(0, 80),
      });
      continue;
    }
    report.parsedLines++;
    const v = entry.auditVersion;
    if (v === undefined) {
      report.unversionedEntries++;
      report.versionCounts['unversioned'] = (report.versionCounts['unversioned'] ?? 0) + 1;
    } else {
      const key = String(v);
      report.versionCounts[key] = (report.versionCounts[key] ?? 0) + 1;
    }
    if (entry.t) {
      if (!minT || entry.t < minT) minT = entry.t;
      if (!maxT || entry.t > maxT) maxT = entry.t;
    }
  }
  if (minT) report.earliest = minT;
  if (maxT) report.latest = maxT;
  return report;
}
