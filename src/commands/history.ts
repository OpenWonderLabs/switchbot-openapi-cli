import { Command } from 'commander';
import path from 'node:path';
import os from 'node:os';
import { intArg, stringArg } from '../utils/arg-parsers.js';
import { printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { readAudit, verifyAudit, type AuditEntry } from '../utils/audit.js';
import { executeCommand } from '../lib/devices.js';
import {
  queryDeviceHistory,
  queryDeviceHistoryStats,
  type HistoryRecord,
} from '../devices/history-query.js';
import {
  aggregateDeviceHistory,
  ALL_AGG_FNS,
  type AggFn,
  type AggOptions,
} from '../devices/history-agg.js';

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
    .option('--file <path>', `Path to the audit log (default ${DEFAULT_AUDIT})`, stringArg('--file'))
    .option('--limit <n>', 'Show only the last N entries', intArg('--limit', { min: 1 }))
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
    .option('--file <path>', `Path to the audit log (default ${DEFAULT_AUDIT})`, stringArg('--file'))
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
        const msg = `Invalid index ${indexArg}. Log has ${entries.length} entries.`;
        if (isJsonMode()) {
          console.error(JSON.stringify({ error: { code: 2, kind: 'usage', message: msg } }));
        } else {
          console.error(msg);
        }
        process.exit(2);
      }
      const entry: AuditEntry = entries[idx - 1];
      if (entry.kind !== 'command') {
        const msg = `Entry ${idx} is not a command (kind=${entry.kind}).`;
        if (isJsonMode()) {
          console.error(JSON.stringify({ error: { code: 2, kind: 'usage', message: msg } }));
        } else {
          console.error(msg);
        }
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

  history
    .command('range')
    .description('Query time-ranged device history from JSONL storage (populated by events mqtt-tail / MCP)')
    .argument('<deviceId>', 'Device ID to query')
    .option('--since <duration>', 'Relative window ending now, e.g. "30s", "15m", "1h", "7d" (mutually exclusive with --from/--to)', stringArg('--since'))
    .option('--from <iso>', 'Range start (ISO-8601)', stringArg('--from'))
    .option('--to <iso>', 'Range end (ISO-8601)', stringArg('--to'))
    .option('--field <name>', 'Project a payload field (repeat to keep multiple)', (v, acc: string[] = []) => acc.concat(v), [] as string[])
    .option('--limit <n>', 'Maximum records to return (default 1000)', intArg('--limit', { min: 1 }))
    .addHelpText('after', `
History is the append-only JSONL mirror of the per-device ring buffer: every
'events mqtt-tail' event and every MCP tool status-refresh is written to
~/.switchbot/device-history/<deviceId>.jsonl (rotates at 50MB × 3 files).

Examples:
  $ switchbot history range <id> --since 7d --json
  $ switchbot history range <id> --since 1h --field temperature --field humidity
  $ switchbot history range <id> --from 2026-04-18T00:00:00Z --to 2026-04-19T00:00:00Z
`)
    .action(async (
      deviceId: string,
      options: { since?: string; from?: string; to?: string; field?: string[]; limit?: string },
    ) => {
      // Usage-level validation: keep synchronous and pre-query so handleError
      // maps these to exit 2 (via UsageError) rather than runtime exit 1.
      if (options.since && (options.from || options.to)) {
        handleError(new UsageError('--since is mutually exclusive with --from/--to.'));
      }

      try {
        const records: HistoryRecord[] = await queryDeviceHistory(deviceId, {
          since: options.since,
          from: options.from,
          to: options.to,
          fields: options.field ?? [],
          limit: options.limit !== undefined ? Number(options.limit) : undefined,
        });

        if (isJsonMode()) {
          printJson({ deviceId, count: records.length, records });
          return;
        }
        if (records.length === 0) {
          console.log(`(no history records for ${deviceId} in requested range)`);
          return;
        }
        for (const r of records) {
          const payloadStr = JSON.stringify(r.payload);
          console.log(`${r.t}  ${r.topic}  ${payloadStr}`);
        }
      } catch (err) {
        // Convert history-query's plain Error range messages into UsageError so
        // they exit 2 instead of 1.
        if (err instanceof Error && /^(Invalid --|--from|--since)/i.test(err.message)) {
          handleError(new UsageError(err.message));
        }
        handleError(err);
      }
    });

  history
    .command('stats')
    .description('Show on-disk size + record counts for a device history')
    .argument('<deviceId>', 'Device ID to inspect')
    .action((deviceId: string) => {
      try {
        const stats = queryDeviceHistoryStats(deviceId);
        if (isJsonMode()) {
          printJson(stats);
          return;
        }
        console.log(`Device:        ${stats.deviceId}`);
        console.log(`History dir:   ${stats.historyDir}`);
        console.log(`JSONL files:   ${stats.fileCount} (${stats.jsonlFiles.join(', ') || '—'})`);
        console.log(`Total size:    ${stats.totalBytes.toLocaleString()} bytes`);
        console.log(`Record count:  ${stats.recordCount}`);
        console.log(`Oldest:        ${stats.oldest ?? '—'}`);
        console.log(`Newest:        ${stats.newest ?? '—'}`);
      } catch (err) {
        handleError(err);
      }
    });

  history
    .command('verify')
    .description('Check the audit log for malformed lines and schema-version drift')
    .option('--file <path>', `Path to the audit log (default ${DEFAULT_AUDIT})`, stringArg('--file'))
    .addHelpText('after', `
See docs/audit-log.md for the audit log format. Exit code:
  0  every line parses and carries the current auditVersion, or file is missing (warn)
  1  one or more lines are malformed or schema drift detected
  2  (usage) — not emitted by this subcommand

Examples:
  $ switchbot history verify
  $ switchbot history verify --file ./custom.log --json
`)
    .action((options: { file?: string }) => {
      const file = options.file ?? DEFAULT_AUDIT;
      const report = verifyAudit(file);

      // Determine status and exit code
      let status: 'ok' | 'warn' | 'fail' = 'ok';
      let exitCode = 0;

      if (report.fileMissing) {
        status = 'warn';
      } else if (report.malformedLines > 0 || report.unversionedEntries > 0) {
        status = 'fail';
        exitCode = 1;
      }

      if (isJsonMode()) {
        const output = {
          status,
          fileMissing: report.fileMissing === true,
          parsed: report.parsedLines,
          malformed: report.malformedLines,
          unversioned: report.unversionedEntries,
          message: report.fileMissing
            ? 'Audit log file not found (fresh install)'
            : report.malformedLines > 0 || report.unversionedEntries > 0
              ? 'Audit log has malformed or unversioned entries'
              : 'Audit log is valid',
        };
        printJson(output);
      } else {
        if (report.fileMissing) {
          console.log(`Audit log:       ${report.file} (missing — fresh install)`);
          console.log(`Status:          ✓ warn (expected for new accounts)`);
        } else {
          console.log(`Audit log:       ${report.file}`);
          console.log(`Parsed lines:    ${report.parsedLines} / ${report.totalLines}`);
          console.log(`Malformed:       ${report.malformedLines}`);
          console.log(`Unversioned:     ${report.unversionedEntries}`);
          const versions = Object.entries(report.versionCounts)
            .map(([v, n]) => `${v}:${n}`)
            .join(', ');
          console.log(`Version counts:  ${versions || '—'}`);
          if (report.earliest) console.log(`Earliest:        ${report.earliest}`);
          if (report.latest) console.log(`Latest:          ${report.latest}`);
          if (report.problems.length > 0) {
            console.log('\nProblems:');
            for (const p of report.problems) {
              console.log(`  line ${p.line}: ${p.reason}${p.preview ? ` — "${p.preview}"` : ''}`);
            }
          }
        }
      }
      process.exit(exitCode);
    });

  history
    .command('aggregate')
    .description('Aggregate time-ranged device history metrics into buckets')
    .argument('<deviceId>', 'Device ID to aggregate')
    .option('--since <duration>', 'Relative window ending now, e.g. "1h", "7d" (mutually exclusive with --from/--to)', stringArg('--since'))
    .option('--from <iso>', 'Range start (ISO-8601)', stringArg('--from'))
    .option('--to <iso>', 'Range end (ISO-8601)', stringArg('--to'))
    .option('--metric <name>', 'Payload field to aggregate (repeat for multiple)', (v: string, acc: string[] = []) => acc.concat(v), [] as string[])
    .option('--agg <csv>', 'Comma-separated aggregation functions (count,min,max,avg,sum,p50,p95)', stringArg('--agg'))
    .option('--bucket <duration>', 'Bucket width, e.g. "15m", "1h", "1d"', stringArg('--bucket'))
    .option('--max-bucket-samples <n>', 'Max samples per bucket for quantiles (1–100000)', intArg('--max-bucket-samples', { min: 1, max: 100_000 }))
    .action(async (
      deviceId: string,
      options: { since?: string; from?: string; to?: string; metric?: string[]; agg?: string; bucket?: string; maxBucketSamples?: string },
    ) => {
      const metrics: string[] = options.metric ?? [];
      if (metrics.length === 0) {
        handleError(new UsageError('at least one --metric is required.'));
      }

      if (options.since && (options.from || options.to)) {
        handleError(new UsageError('--since is mutually exclusive with --from/--to.'));
      }

      let aggs: AggFn[] | undefined;
      if (options.agg !== undefined) {
        const parts = options.agg.split(',').map((s) => s.trim()).filter(Boolean);
        const unknown = parts.filter((p) => !(ALL_AGG_FNS as readonly string[]).includes(p));
        if (unknown.length > 0) {
          handleError(new UsageError(
            `Unknown aggregation function(s): ${unknown.join(', ')}. Legal values: ${ALL_AGG_FNS.join(', ')}.`,
          ));
        }
        aggs = parts as AggFn[];
      }

      const aggOpts: AggOptions = {
        metrics,
        aggs,
        since: options.since,
        from: options.from,
        to: options.to,
        bucket: options.bucket,
        maxBucketSamples: options.maxBucketSamples !== undefined ? Number(options.maxBucketSamples) : undefined,
      };

      try {
        const res = await aggregateDeviceHistory(deviceId, aggOpts);

        if (isJsonMode()) {
          printJson(res);
          return;
        }

        if (res.buckets.length === 0) {
          console.log(`(no history records for ${deviceId} in requested range)`);
          return;
        }

        const aggCols = res.aggs;
        const cols = ['t', ...res.metrics.flatMap((m) => aggCols.map((a) => `${m}.${a}`))];
        console.log(cols.join('\t'));
        for (const bkt of res.buckets) {
          const row = cols.map((col) => {
            if (col === 't') return bkt.t;
            const [metric, agg] = col.split('.');
            const val = (bkt.metrics[metric] as Record<string, unknown> | undefined)?.[agg];
            return val !== undefined ? String(val) : '\u2014';
          });
          console.log(row.join('\t'));
        }

        if (res.partial) {
          for (const note of res.notes) {
            console.error('note: ' + note);
          }
        }
      } catch (err) {
        if (err instanceof Error) {
          if (/bucket/i.test(err.message) || /--since/i.test(err.message) || /--from/i.test(err.message) || /--to/i.test(err.message)) {
            handleError(new UsageError(err.message));
          }
        }
        handleError(err);
      }
    });
}
