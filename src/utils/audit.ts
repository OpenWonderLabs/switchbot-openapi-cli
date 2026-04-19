import fs from 'node:fs';
import path from 'node:path';
import { getAuditLog } from './flags.js';

const MAX_BYTES = 10 * 1024 * 1024;

export interface AuditEntry {
  t: string;
  kind: 'command';
  deviceId: string;
  command: string;
  parameter: unknown;
  commandType: 'command' | 'customize';
  dryRun: boolean;
  /** 'ok' | 'error' (command ran); 'refused' (destructive guard blocked the call). */
  result?: 'ok' | 'error' | 'refused';
  error?: string;
  /** True when this command is flagged destructive in the device catalog. */
  destructive?: boolean;
  /** True when --yes / confirm:true was passed. Only meaningful for destructive commands. */
  confirmed?: boolean;
  /** Which surface invoked the command. */
  caller?: 'cli' | 'mcp';
}

function resolveAuditPath(): string | null {
  const flag = getAuditLog();
  if (flag === null) return null;
  return path.resolve(flag);
}

function rotateIfNeeded(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size >= MAX_BYTES) {
      const rotated = `${file}.1`;
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
      fs.renameSync(file, rotated);
    }
  } catch {
    /* file missing / perm issue — next append will recreate it */
  }
}

export function writeAudit(entry: AuditEntry): void {
  const file = resolveAuditPath();
  if (!file) return;
  const dir = path.dirname(file);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    rotateIfNeeded(file);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    // First write creates the file with mode 0600; subsequent appends don't
    // touch the mode, but defensively enforce it in case the file was
    // pre-created with a looser umask.
    try { fs.chmodSync(file, 0o600); } catch { /* non-posix */ }
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
 * Append an audit entry for a destructive command that was refused by the
 * guard (no --yes / confirm:true). Provides a full audit trail of attempted
 * mutations, not just executed ones.
 */
export function writeRefusalAudit(params: {
  deviceId: string;
  command: string;
  parameter?: unknown;
  commandType: 'command' | 'customize';
  caller: 'cli' | 'mcp';
  reason?: string;
}): void {
  writeAudit({
    t: new Date().toISOString(),
    kind: 'command',
    deviceId: params.deviceId,
    command: params.command,
    parameter: params.parameter,
    commandType: params.commandType,
    dryRun: false,
    result: 'refused',
    destructive: true,
    confirmed: false,
    caller: params.caller,
    ...(params.reason ? { error: params.reason } : {}),
  });
}
