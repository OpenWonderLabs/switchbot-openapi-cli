import { Command } from 'commander';
import path from 'node:path';
import os from 'node:os';
import { printJson, isJsonMode, handleError } from '../utils/output.js';
import { readAudit, type AuditEntry } from '../utils/audit.js';
import { executeCommand } from '../lib/devices.js';

const DEFAULT_AUDIT = path.join(os.homedir(), '.switchbot', 'audit.log');

export function registerHistoryCommand(program: Command): void {
  const history = program
    .command('history')
    .description('View and replay commands recorded via --audit-log')
    .addHelpText('after', `
Every 'devices command' run with --audit-log is appended as JSONL to the
audit file (default ~/.switchbot/audit.log). 'history show' prints the file,
'history replay <n>' re-runs the Nth entry (1-indexed, most-recent last).

Examples:
  $ switchbot --audit-log devices command <id> turnOff
  $ switchbot history show --limit 10
  $ switchbot history replay 3
`);

  history
    .command('show')
    .description('Print recent audit entries')
    .option('--file <path>', `Path to the audit log (default ${DEFAULT_AUDIT})`)
    .option('--limit <n>', 'Show only the last N entries')
    .action((options: { file?: string; limit?: string }) => {
      const file = options.file ?? DEFAULT_AUDIT;
      const entries = readAudit(file);
      const limited =
        options.limit !== undefined
          ? entries.slice(-Math.max(1, Number(options.limit) || 1))
          : entries;

      if (isJsonMode()) {
        printJson({ file, total: entries.length, entries: limited });
        return;
      }
      if (entries.length === 0) {
        console.log(`(no entries in ${file})`);
        return;
      }
      const startIdx = entries.length - limited.length;
      limited.forEach((e, i) => {
        const idx = startIdx + i + 1;
        const mark = e.result === 'error' ? '✗' : e.dryRun ? '◦' : '✓';
        const param = e.parameter !== undefined && e.parameter !== 'default'
          ? ` ${JSON.stringify(e.parameter)}`
          : '';
        const err = e.error ? `  [err: ${e.error}]` : '';
        console.log(`${String(idx).padStart(4)}  ${mark}  ${e.t}  ${e.deviceId}  ${e.command}${param}${err}`);
      });
    });

  history
    .command('replay')
    .description('Re-run a recorded command by its 1-indexed position')
    .argument('<index>', 'Entry index (1 = oldest; as shown by "history show")')
    .option('--file <path>', `Path to the audit log (default ${DEFAULT_AUDIT})`)
    .addHelpText('after', `
Dry-run-honouring: pass --dry-run on the parent command to preview without
sending the actual call. Errors from the recorded entry are NOT replayed —
replay always attempts the command fresh.

Examples:
  $ switchbot history replay 3
  $ switchbot --dry-run history replay 3
`)
    .action(async (indexArg: string, options: { file?: string }) => {
      const file = options.file ?? DEFAULT_AUDIT;
      const entries = readAudit(file);
      const idx = Number(indexArg);
      if (!Number.isInteger(idx) || idx < 1 || idx > entries.length) {
        console.error(`Invalid index ${indexArg}. Log has ${entries.length} entries.`);
        process.exit(2);
      }
      const entry: AuditEntry = entries[idx - 1];
      if (entry.kind !== 'command') {
        console.error(`Entry ${idx} is not a command (kind=${entry.kind}).`);
        process.exit(2);
      }
      try {
        const result = await executeCommand(
          entry.deviceId,
          entry.command,
          entry.parameter,
          entry.commandType,
        );
        if (isJsonMode()) {
          printJson({ replayed: entry, result });
        } else {
          console.log(`✓ replayed ${entry.command} on ${entry.deviceId}`);
        }
      } catch (err) {
        handleError(err);
      }
    });
}
