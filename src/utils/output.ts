import Table from 'cli-table3';
import chalk from 'chalk';
import { ApiError, DryRunSignal } from '../api/client.js';

import { getFormat, getTableStyle, type TableStyle } from './flags.js';

export const SCHEMA_VERSION = '1.1';

export function isJsonMode(): boolean {
  return process.argv.includes('--json') || getFormat() === 'json';
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, data }, null, 2));
}

function escapeMarkdownCell(s: string): string {
  // Pipes break markdown table layout; backslash-escape them. Collapse
  // newlines into <br> so each row stays on one line.
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function formatCell(cell: string | number | boolean | null | undefined, style: TableStyle): string {
  if (cell === null || cell === undefined) return style === 'markdown' ? '—' : chalk.grey('—');
  if (typeof cell === 'boolean') {
    if (style === 'markdown') return cell ? 'Yes' : 'No';
    return cell ? chalk.green('✓') : chalk.red('✗');
  }
  return String(cell);
}

function renderMarkdownTable(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const head = `| ${headers.map(escapeMarkdownCell).join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map(
    (r) =>
      `| ${r
        .map((c) => escapeMarkdownCell(formatCell(c, 'markdown')))
        .join(' | ')} |`,
  );
  return [head, sep, ...body].join('\n');
}

function renderSimpleTable(headers: string[], rows: (string | number | boolean | null | undefined)[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(formatCell(r[i], 'simple')).length)),
  );
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [
    fmt(headers),
    ...rows.map((r) => fmt(r.map((c) => String(formatCell(c, 'simple'))))),
  ].join('\n');
}

const ASCII_BORDER_CHARS = {
  top: '-', 'top-mid': '+', 'top-left': '+', 'top-right': '+',
  bottom: '-', 'bottom-mid': '+', 'bottom-left': '+', 'bottom-right': '+',
  left: '|', 'left-mid': '+', mid: '-', 'mid-mid': '+',
  right: '|', 'right-mid': '+', middle: '|',
};

export function printTable(
  headers: string[],
  rows: (string | number | boolean | null | undefined)[][],
  styleOverride?: TableStyle,
): void {
  const style = styleOverride ?? getTableStyle();
  if (style === 'markdown') {
    console.log(renderMarkdownTable(headers, rows));
    return;
  }
  if (style === 'simple') {
    console.log(renderSimpleTable(headers, rows));
    return;
  }

  const tableOpts: ConstructorParameters<typeof Table>[0] = {
    head: headers.map((h) => (style === 'ascii' ? h : chalk.cyan(h))),
    style: style === 'ascii' ? { border: [], head: [] } : { border: ['grey'] },
  };
  if (style === 'ascii') {
    tableOpts.chars = ASCII_BORDER_CHARS;
  }
  const table = new Table(tableOpts);

  for (const row of rows) {
    table.push(row.map((cell) => formatCell(cell, style)));
  }

  console.log(table.toString());
}

export function printKeyValue(data: Record<string, unknown>): void {
  const style = getTableStyle();
  if (style === 'markdown') {
    const entries = Object.entries(data).filter(([, v]) => v !== null && v !== undefined);
    const rows = entries.map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]);
    console.log(renderMarkdownTable(['Key', 'Value'], rows));
    return;
  }
  if (style === 'simple') {
    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) continue;
      const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      console.log(`${key}  ${displayValue}`);
    }
    return;
  }

  const tableOpts: ConstructorParameters<typeof Table>[0] = {
    style: style === 'ascii' ? { border: [], head: [] } : { border: ['grey'] },
  };
  if (style === 'ascii') {
    tableOpts.chars = ASCII_BORDER_CHARS;
  }
  const table = new Table(tableOpts);

  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    const keyLabel = style === 'ascii' ? key : chalk.cyan(key);
    table.push({ [keyLabel]: displayValue });
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
  | 'unknown-api-error';

export interface ErrorPayload {
  code: number;
  kind: 'usage' | 'api' | 'runtime' | 'guard';
  subKind?: ErrorSubKind;
  message: string;
  hint?: string;
  retryable?: boolean;
  context?: Record<string, unknown>;
  retryAfterMs?: number;
  transient?: boolean;
  errorClass?: 'network' | 'api' | 'device-offline' | 'device-busy' | 'guard' | 'usage';
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
    const payload: ErrorPayload = {
      code: 2,
      kind: 'usage',
      message: error.message,
      errorClass: 'usage',
      transient: false
    };
    if (error.context) payload.context = error.context;
    return payload;
  }
  if (error instanceof UsageError) {
    return { code: 2, kind: 'usage', message: error.message, errorClass: 'usage', transient: false };
  }
  // Idempotency conflict → exit 2 with kind:guard so scripts can react.
  if (error instanceof Error && error.name === 'IdempotencyConflictError') {
    return {
      code: 2,
      kind: 'guard',
      message: error.message,
      errorClass: 'guard',
      transient: false,
      context: {
        existingShape: (error as { existingShape?: string }).existingShape,
        newShape: (error as { newShape?: string }).newShape,
      },
    };
  }
  // Local daily-cap refusal → exit 2 (usage-style refusal before touching net).
  if (error instanceof Error && error.name === 'DailyCapExceededError') {
    return {
      code: 2,
      kind: 'guard',
      message: error.message,
      errorClass: 'guard',
      transient: false,
      context: {
        cap: (error as { cap?: number }).cap,
        total: (error as { total?: number }).total,
        profile: (error as { profile?: string }).profile,
      },
    };
  }
  const code = error instanceof ApiError ? error.code : 1;
  const kind: ErrorPayload['kind'] = error instanceof ApiError ? 'api' : 'runtime';
  const message = error instanceof Error ? error.message : 'An unknown error occurred';
  const hint = error instanceof ApiError ? (error.hint ?? errorHint(error.code)) : null;
  const retryable = error instanceof ApiError ? error.retryable : false;
  const retryAfterMs = error instanceof ApiError ? error.retryAfterMs : undefined;
  const transient = error instanceof ApiError ? error.transient : false;

  // Classify error
  let errorClass: ErrorPayload['errorClass'] = 'api';
  if (kind === 'runtime') {
    errorClass = 'api';
  } else if (transient && code >= 500) {
    errorClass = 'api';
  } else if (code === 0) {
    errorClass = 'network';
  } else if (code >= 400) {
    errorClass = 'api';
  }

  const payload: ErrorPayload = { code, kind, message, errorClass, transient };
  if (error instanceof ApiError) payload.subKind = classifyApiError(error.code);
  if (hint) payload.hint = hint;
  if (retryable) payload.retryable = true;
  if (retryAfterMs !== undefined) payload.retryAfterMs = retryAfterMs;
  return payload;
}

export function handleError(error: unknown): never {
  if (error instanceof DryRunSignal) {
    process.exit(0);
  }

  const payload = buildErrorPayload(error);

  if (isJsonMode()) {
    console.error(JSON.stringify({ schemaVersion: SCHEMA_VERSION, error: payload }));
    process.exit(payload.code === 2 ? 2 : 1);
  }

  if (payload.kind === 'usage') {
    console.error(payload.message);
    process.exit(2);
  }

  if (payload.kind === 'guard') {
    console.error(chalk.yellow(`Guard: ${payload.message}`));
    process.exit(payload.code === 2 ? 2 : 1);
  }

  if (error instanceof ApiError) {
    console.error(chalk.red(`Error (code ${error.code}): ${payload.message}`));
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
