import chalk, { Chalk } from 'chalk';
import type { PolicyValidationResult, PolicyValidationError } from './validate.js';

export interface FormatOptions {
  color?: boolean;
  noSnippet?: boolean;
}

const noColorChalk = new Chalk({ level: 0 });

function colorize(enabled: boolean) {
  return enabled ? chalk : noColorChalk;
}

function snippet(source: string, line: number, col: number, length: number, c: typeof chalk): string {
  const lines = source.split(/\r?\n/);
  if (line < 1 || line > lines.length) return '';

  const lineText = lines[line - 1];
  const gutter = `  ${line} | `;
  const pad = ' '.repeat(gutter.length);
  const caretStart = Math.max(0, col - 1);
  const caretLen = Math.max(1, length);
  const caret = `${' '.repeat(caretStart)}${c.red('^'.repeat(caretLen))}`;

  return `${c.dim(gutter)}${lineText}\n${c.dim(pad)}${caret}`;
}

function estimateTokenLength(source: string, line: number, col: number): number {
  const lines = source.split(/\r?\n/);
  if (line < 1 || line > lines.length) return 1;
  const lineText = lines[line - 1];
  const start = Math.max(0, col - 1);
  if (start >= lineText.length) return 1;
  const rest = lineText.slice(start);
  const quoted = rest.match(/^(['"]).*?\1/);
  if (quoted) return quoted[0].length;
  const token = rest.match(/^[^\s,\[\]{}]+/);
  return token ? token[0].length : 1;
}

function formatError(
  err: PolicyValidationError,
  policyPath: string,
  source: string,
  opts: FormatOptions,
): string {
  const c = colorize(opts.color ?? true);
  const loc = err.line !== undefined && err.col !== undefined ? `${err.line}:${err.col}` : '(unknown)';
  const header = `${c.cyan(policyPath)}:${c.yellow(loc)}`;
  const body = [`${c.red.bold('error')}: ${err.message}`];

  if (err.line !== undefined && err.col !== undefined && !opts.noSnippet) {
    const len = estimateTokenLength(source, err.line, err.col);
    const snip = snippet(source, err.line, err.col, len, c);
    if (snip) body.unshift(snip);
  }
  if (err.hint) body.push(`${c.green.bold('hint')}:  ${err.hint}`);

  return [header, ...body].join('\n');
}

export function formatValidationResult(
  result: PolicyValidationResult,
  source: string,
  opts: FormatOptions = {},
): string {
  const c = colorize(opts.color ?? true);
  if (result.valid) {
    return `${c.green.bold('✓')} ${result.policyPath} is valid (schema v${result.schemaVersion})`;
  }
  const blocks = result.errors.map((e) => formatError(e, result.policyPath, source, opts));
  const count = result.errors.length;
  const footer = `${c.red.bold(`✗ ${count} ${count === 1 ? 'error' : 'errors'}`)} in ${result.policyPath} (schema v${result.schemaVersion})`;
  return [...blocks, '', footer].join('\n\n').replace(/\n{3,}/g, '\n\n');
}
