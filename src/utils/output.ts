import Table from 'cli-table3';
import chalk from 'chalk';
import { ApiError, DryRunSignal } from '../api/client.js';
import { MqttError, type MqttErrorSubKind } from '../mqtt/errors.js';

import { getFormat } from './flags.js';

export const SCHEMA_VERSION = '1';

export function isJsonMode(): boolean {
  return process.argv.includes('--json') || getFormat() === 'json';
}

/**
 * Back-compat opt-out. `--json-legacy` makes `printJson(data)` emit the bare
 * payload (v1.5.0 behavior) instead of the v1.6.0 envelope. Planned removal
 * in v1.7.0. Scripts that parse CLI `--json` output and can't be updated
 * across a single minor-version bump should use this flag.
 */
export function isJsonLegacyMode(): boolean {
  return process.argv.includes('--json-legacy');
}

/**
 * Module-level state captured at action entry. Lets `printJson` build
 * `meta.command` and `meta.durationMs` without threading the command object
 * through every .action handler.
 */
let activeCommand: string | undefined;
let activeStart: number | undefined;

export function beginCommand(command: string): void {
  activeCommand = command;
  activeStart = Date.now();
}

export function getActiveCommand(): string | undefined {
  return activeCommand;
}

function buildMeta(): { command?: string; durationMs?: number } {
  const meta: { command?: string; durationMs?: number } = {};
  if (activeCommand) meta.command = activeCommand;
  if (activeStart !== undefined) meta.durationMs = Date.now() - activeStart;
  return meta;
}

export interface SuccessEnvelope<T = unknown> {
  schemaVersion: string;
  ok: true;
  data: T;
  meta: { command?: string; durationMs?: number };
}

export interface ErrorEnvelope {
  schemaVersion: string;
  ok: false;
  error: ErrorPayload;
  meta: { command?: string; durationMs?: number };
}

export function printJson(data: unknown): void {
  if (isJsonLegacyMode()) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const envelope: SuccessEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    ok: true,
    data,
    meta: buildMeta(),
  };
  console.log(JSON.stringify(envelope, null, 2));
}

/**
 * Emit a single JSON line without the envelope. Used by streaming commands
 * (watch, events stream/tail) where each stdout line is one event and wrapping
 * every event in a full envelope is wasteful. JSONL consumers read one event
 * per line; the `schemaVersion` guarantee does not apply to stream payloads.
 */
export function printJsonLine(data: unknown): void {
  console.log(JSON.stringify(data));
}

export function printTable(headers: string[], rows: (string | number | boolean | null | undefined)[][]): void {
  const table = new Table({
    head: headers.map((h) => chalk.cyan(h)),
    style: { border: ['grey'] },
  });

  for (const row of rows) {
    table.push(row.map((cell) => {
      if (cell === null || cell === undefined) return chalk.grey('—');
      if (typeof cell === 'boolean') return cell ? chalk.green('✓') : chalk.red('✗');
      return String(cell);
    }));
  }

  console.log(table.toString());
}

export function printKeyValue(data: Record<string, unknown>): void {
  const table = new Table({
    style: { border: ['grey'] },
  });

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const displayValue = typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
    table.push({ [chalk.cyan(key)]: displayValue });
  }

  console.log(table.toString());
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type ErrorSubKind =
  | 'device-offline'
  | 'device-not-found'
  | 'command-not-supported'
  | 'auth-failed'
  | 'quota-exceeded'
  | 'device-busy'
  | 'unknown-api-error'
  | MqttErrorSubKind;

export interface ErrorPayload {
  code: number;
  kind: 'usage' | 'api' | 'runtime';
  subKind?: ErrorSubKind;
  message: string;
  hint?: string;
  retryable?: boolean;
  context?: Record<string, unknown>;
}

export class StructuredUsageError extends Error {
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message);
    this.name = 'StructuredUsageError';
  }
}

function classifyApiError(code: number): ErrorSubKind {
  switch (code) {
    case 151:
    case 160: return 'command-not-supported';
    case 152: return 'device-not-found';
    case 161:
    case 171: return 'device-offline';
    case 190: return 'device-busy';
    case 401: return 'auth-failed';
    case 429: return 'quota-exceeded';
    default:  return 'unknown-api-error';
  }
}

export function buildErrorPayload(error: unknown): ErrorPayload {
  if (error instanceof StructuredUsageError) {
    const payload: ErrorPayload = { code: 2, kind: 'usage', message: error.message };
    if (error.context) payload.context = error.context;
    return payload;
  }
  if (error instanceof UsageError) {
    return { code: 2, kind: 'usage', message: error.message };
  }
  if (error instanceof MqttError) {
    const payload: ErrorPayload = {
      code: 1,
      kind: 'runtime',
      subKind: error.subKind,
      message: error.message,
    };
    if (error.hint) payload.hint = error.hint;
    if (error.retryable) payload.retryable = true;
    return payload;
  }
  const code = error instanceof ApiError ? error.code : 1;
  const kind: ErrorPayload['kind'] = error instanceof ApiError ? 'api' : 'runtime';
  const message = error instanceof Error ? error.message : 'An unknown error occurred';
  const hint = error instanceof ApiError ? (error.hint ?? errorHint(error.code)) : null;
  const retryable = error instanceof ApiError ? error.retryable : false;
  const payload: ErrorPayload = { code, kind, message };
  if (error instanceof ApiError) payload.subKind = classifyApiError(error.code);
  if (hint) payload.hint = hint;
  if (retryable) payload.retryable = true;
  return payload;
}

/**
 * Emit a structured error. In JSON mode the envelope goes to **stdout** (so
 * agents reading stdout get both success and failure payloads in one stream).
 * Legacy JSON mode keeps the pre-1.6.0 stderr behavior and the bare
 * `{error:...}` shape.
 */
export function printErrorEnvelope(payload: ErrorPayload): void {
  if (isJsonLegacyMode()) {
    // v1.5.0 shape: {error: ...} on stderr.
    console.error(JSON.stringify({ error: payload }));
    return;
  }
  const envelope: ErrorEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: payload,
    meta: buildMeta(),
  };
  // v1.6.0: errors go to stdout in JSON mode so agents can parse one stream.
  console.log(JSON.stringify(envelope));
}

export function handleError(error: unknown): never {
  if (error instanceof DryRunSignal) {
    process.exit(0);
  }

  const payload = buildErrorPayload(error);

  if (isJsonMode()) {
    printErrorEnvelope(payload);
    process.exit(payload.code === 2 ? 2 : 1);
  }

  if (payload.kind === 'usage') {
    console.error(payload.message);
    process.exit(2);
  }

  if (error instanceof ApiError) {
    console.error(chalk.red(`Error (code ${error.code}): ${payload.message}`));
    if (payload.hint) console.error(chalk.grey(`Hint: ${payload.hint}`));
  } else if (error instanceof MqttError) {
    console.error(chalk.red(`Error (${error.subKind}): ${payload.message}`));
    if (payload.hint) console.error(chalk.grey(`Hint: ${payload.hint}`));
  } else if (error instanceof Error) {
    console.error(chalk.red(`Error: ${payload.message}`));
  } else {
    console.error(chalk.red('An unknown error occurred'));
  }
  process.exit(1);
}

function errorHint(code: number): string | null {
  switch (code) {
    case 152:
      return "Check the deviceId with 'switchbot devices list' (IDs are case-sensitive).";
    case 160:
      return "Run 'switchbot devices describe <deviceId>' to see which commands this device supports.";
    case 161:
      return 'BLE-only devices require a Hub. Check the hub connection and Wi-Fi.';
    case 171:
      return 'The Hub itself is offline — check its power and Wi-Fi.';
    case 190:
      return "Often means the deviceId is wrong or the command/parameter is invalid for this device. Double-check with 'switchbot devices list' and 'switchbot devices describe <deviceId>'. Use --verbose to see the raw API response.";
    case 401:
      return "Re-run 'switchbot config set-token <token> <secret>', or verify SWITCHBOT_TOKEN / SWITCHBOT_SECRET.";
    case 429:
      return 'Daily quota is 10,000 requests/account — retry after midnight UTC.';
    default:
      return null;
  }
}
