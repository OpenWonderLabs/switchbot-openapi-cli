import { printTable, printJson, isJsonMode } from './output.js';
import { getFormat, getFields } from './flags.js';

export type OutputFormat = 'table' | 'json' | 'jsonl' | 'tsv' | 'yaml' | 'id';

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
    default:
      console.error(`Unknown --format "${flag}". Expected: table, json, jsonl, tsv, yaml, id.`);
      process.exit(2);
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
): { headers: string[]; rows: unknown[][] } {
  if (!fields || fields.length === 0) return { headers, rows };
  const indices = fields
    .map((f) => headers.indexOf(f))
    .filter((i) => i !== -1);
  if (indices.length === 0) return { headers, rows };
  return {
    headers: indices.map((i) => headers[i]),
    rows: rows.map((row) => indices.map((i) => row[i])),
  };
}

function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'boolean') return cell ? 'true' : 'false';
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
): void {
  const filtered = filterFields(headers, rows, fields);
  const h = filtered.headers;
  const r = filtered.rows;

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
        for (const [k, v] of Object.entries(obj)) {
          if (v === null || v === undefined) {
            console.log(`${k}: ~`);
          } else if (typeof v === 'boolean') {
            console.log(`${k}: ${v}`);
          } else if (typeof v === 'number') {
            console.log(`${k}: ${v}`);
          } else {
            console.log(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
          }
        }
      }
      break;

    case 'id': {
      const idIdx = h.indexOf('deviceId') !== -1 ? h.indexOf('deviceId')
        : h.indexOf('sceneId') !== -1 ? h.indexOf('sceneId')
        : 0;
      for (const row of r) {
        console.log(cellToString(row[idIdx]));
      }
      break;
    }
  }
}
