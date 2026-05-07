import fs from 'node:fs';
import {
  filterTraceRecords,
  type RuleEvaluateRecord,
  type ConditionTrace,
  type TraceFilterOpts,
} from './trace.js';
import type { AuditEntry } from '../utils/audit.js';

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export function loadTraceRecords(auditFile: string, opts: TraceFilterOpts = {}): RuleEvaluateRecord[] {
  if (!fs.existsSync(auditFile)) return [];
  const lines = fs.readFileSync(auditFile, 'utf-8').split(/\r?\n/);
  return filterTraceRecords(lines, opts);
}

export function loadRelatedAudit(auditFile: string, fireId: string): AuditEntry[] {
  if (!fs.existsSync(auditFile)) return [];
  const raw = fs.readFileSync(auditFile, 'utf-8');
  const out: AuditEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as AuditEntry & { fireId?: string; rule?: { fireId?: string } };
      const entryFireId = entry.rule?.fireId ?? (entry as unknown as Record<string, unknown>)['fireId'];
      if (entryFireId === fireId) out.push(entry);
    } catch {
      // skip
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text formatter
// ---------------------------------------------------------------------------

function conditionSymbol(passed: boolean | null): string {
  if (passed === true) return '✓';
  if (passed === false) return '✗';
  return '·';
}

function conditionSummary(c: ConditionTrace): string {
  if (c.passed === null) {
    return `· ${c.kind} → not evaluated (short-circuited)`;
  }
  const sym = conditionSymbol(c.passed);
  let detail = c.kind;
  if (c.config !== undefined) {
    if (Array.isArray(c.config)) {
      detail += ` ${(c.config as string[]).join('–')}`;
    } else if (c.config && typeof c.config === 'object') {
      const cfg = c.config as Record<string, unknown>;
      if ('device' in cfg) {
        detail += ` ${cfg['device']}.${cfg['field']} ${cfg['op']} ${JSON.stringify(cfg['value'])}`;
      }
    }
  }
  const status = c.passed ? 'passed' : 'failed';
  return `  ${sym} ${detail.padEnd(36)} → ${status}`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
}

export function formatExplainText(
  record: RuleEvaluateRecord,
  relatedAudit: AuditEntry[],
): string {
  const lines: string[] = [];

  lines.push(`Rule: ${record.rule.name}  (version ${record.rule.version})`);
  lines.push(`Evaluated: ${formatTimestamp(record.t)} (${record.evaluationMs}ms)`);
  const triggerDevice = record.trigger.deviceId ? ` on ${record.trigger.deviceId}` : '';
  lines.push(`Trigger: ${record.trigger.source} ${record.trigger.event}${triggerDevice}`);
  lines.push('');

  if (record.conditions.length > 0) {
    lines.push('Conditions (evaluated in order):');
    for (const c of record.conditions) {
      lines.push(conditionSummary(c));
    }
    lines.push('');
  }

  lines.push(`Decision: ${record.decision}`);
  lines.push('');

  lines.push(`Related fireId: ${record.fireId}`);

  const nonEval = relatedAudit.filter(
    (e) => (e as unknown as Record<string, unknown>)['kind'] !== 'rule-evaluate',
  );
  if (nonEval.length > 0) {
    lines.push(`Audit trail (${nonEval.length} record${nonEval.length === 1 ? '' : 's'}):`);
    for (const e of nonEval) {
      const ts = formatTimestamp(e.t);
      lines.push(`  ${e.kind.padEnd(20)} ${ts}`);
    }
  } else {
    lines.push(`Audit trail: (no related records${record.decision === 'blocked-by-condition' ? ' — rule did not fire' : ''})`);
  }

  return lines.join('\n');
}

export function formatExplainJson(
  record: RuleEvaluateRecord,
  relatedAudit: AuditEntry[],
): string {
  return JSON.stringify({ trace: record, relatedAudit }, null, 2);
}
