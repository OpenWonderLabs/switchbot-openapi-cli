import Table from 'cli-table3';
import chalk from 'chalk';
import { ApiError, DryRunSignal } from '../api/client.js';

import { getFormat } from './flags.js';

export function isJsonMode(): boolean {
  return process.argv.includes('--json') || getFormat() === 'json';
}

export function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
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

export function handleError(error: unknown): never {
  if (error instanceof DryRunSignal) {
    process.exit(0);
  }
  if (error instanceof ApiError) {
    console.error(chalk.red(`Error (code ${error.code}): ${error.message}`));
    const hint = errorHint(error.code);
    if (hint) console.error(chalk.grey(`Hint: ${hint}`));
  } else if (error instanceof Error) {
    console.error(chalk.red(`Error: ${error.message}`));
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
