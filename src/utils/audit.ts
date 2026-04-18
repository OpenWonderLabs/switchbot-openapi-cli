import fs from 'node:fs';
import path from 'node:path';
import { getAuditLog } from './flags.js';

export interface AuditEntry {
  t: string;
  kind: 'command';
  deviceId: string;
  command: string;
  parameter: unknown;
  commandType: 'command' | 'customize';
  dryRun: boolean;
  result?: 'ok' | 'error';
  error?: string;
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
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
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
