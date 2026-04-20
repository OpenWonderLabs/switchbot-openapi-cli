import { printTable, printJson, isJsonMode, UsageError, emitJsonError } from './output.js';
import { getFormat, getFields } from './flags.js';
import { dump as yamlDump } from 'js-yaml';

export type OutputFormat = 'table' | 'json' | 'jsonl' | 'tsv' | 'yaml' | 'id' | 'markdown';

export function parseFormat(flag: string | undefined): OutputFormat {
  if (!flag) return 'table';
  const lower = flag.toLowerCase();
  switch (lower) {
    case 'table': return 'table';
    case 'json': return 'json';
    case 'jsonl': return 'jsonl';
    case 'tsv': return 'tsv';
    case 'yaml': return 'yaml';
    case 'id': return 'id';
    case 'markdown': return 'markdown';
    default: {
      const msg = `Unknown --format "${flag}". Expected: table, json, jsonl, tsv, yaml, id, markdown.`;
      if (isJsonMode()) {
        emitJsonError({ code: 2, kind: 'usage', message: msg });
      } else {
        console.error(msg);
      }
      process.exit(2);
    }
  }
}

export function resolveFormat(): OutputFormat {
  if (process.argv.includes('--json')) return 'json';
  return parseFormat(getFormat());
}

export function resolveFields(): string[] | undefined {
  return getFields();
}

export function filterFields(
  headers: string[],
  rows: unknown[][],
  fields: string[] | undefined,
  aliases?: Record<string, string>,
): { headers: string[]; rows: unknown[][] } {
  if (!fields || fields.length === 0) return { headers, rows };
  const resolved = aliases ? fields.map((f) => aliases[f] ?? f) : fields;
  const unknown = fields.filter((_, i) => !headers.includes(resolved[i]));
  if (unknown.length > 0) {
    throw new UsageError(
      `Unknown field(s): ${unknown.map((f) => `"${f}"`).join(', ')}. ` +
        `Allowed: ${headers.map((f) => `"${f}"`).join(', ')}.`,
    );
  }
  const indices = resolved.map((f) => headers.indexOf(f));
  return {
    headers: indices.map((i) => headers[i]),
    rows: rows.map((row) => indices.map((i) => row[i])),
  };
}

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
  if (typeof cell === 'object') return JSON.stringify(cell);
  return String(cell);
}

function rowToObject(headers: string[], row: unknown[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i]] = row[i] ?? null;
  }
  return obj;
}

export function renderRows(
  headers: string[],
  rows: unknown[][],
  format: OutputFormat,
  fields?: string[],
  aliases?: Record<string, string>,
): void {
  const filtered = filterFields(headers, rows, fields, aliases);
  const h = filtered.headers;
  const r = filtered.rows;

  // Markdown format is rendered as table with markdown style forced regardless
  // of the user's --table-style, so `--format markdown` is a self-contained
  // contract (bug #8).
  if (format === 'markdown') {
    printTable(h, r as (string | number | boolean | null | undefined)[][], 'markdown');
    return;
  }

  switch (format) {
    case 'table':
      printTable(h, r as (string | number | boolean | null | undefined)[][]);
      break;

    case 'json':
      printJson(r.map((row) => rowToObject(h, row)));
      break;

    case 'jsonl':
      for (const row of r) {
        console.log(JSON.stringify(rowToObject(h, row)));
      }
      break;

    case 'tsv':
      console.log(h.join('\t'));
      for (const row of r) {
        console.log(row.map(cellToString).join('\t'));
      }
      break;

    case 'yaml':
      for (const row of r) {
        const obj = rowToObject(h, row);
        console.log('---');
        console.log(yamlDump(obj, { lineWidth: -1 }).trimEnd());
      }
      break;

    case 'id': {
      const idIdx = h.indexOf('deviceId') !== -1 ? h.indexOf('deviceId')
        : h.indexOf('sceneId') !== -1 ? h.indexOf('sceneId')
        : -1;
      if (idIdx === -1) {
        throw new UsageError(
          `--format=id requires a "deviceId" or "sceneId" column. ` +
            `This command outputs: ${h.map((c) => `"${c}"`).join(', ')}.`,
        );
      }
      for (const row of r) {
        console.log(cellToString(row[idIdx]));
      }
      break;
    }
  }
}
