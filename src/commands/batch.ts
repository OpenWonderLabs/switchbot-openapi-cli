import { Command } from 'commander';
import { printJson, isJsonMode, handleError } from '../utils/output.js';
import {
  fetchDeviceList,
  executeCommand,
  isDestructiveCommand,
  buildHubLocationMap,
} from '../lib/devices.js';
import { parseFilter, applyFilter, FilterSyntaxError } from '../utils/filter.js';
import { isDryRun } from '../utils/flags.js';
import { DryRunSignal } from '../api/client.js';

interface BatchResult {
  succeeded: Array<{ deviceId: string; result: unknown }>;
  failed: Array<{ deviceId: string; error: string }>;
  summary: {
    total: number;
    ok: number;
    failed: number;
    skipped: number;
    durationMs: number;
    dryRun?: boolean;
  };
}

const DEFAULT_CONCURRENCY = 5;

/** Run `task(x)` for every element with at most `concurrency` running at once. */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const width = Math.max(1, Math.min(concurrency, items.length));

  for (let w = 0; w < width; w++) {
    workers.push(
      (async () => {
        while (cursor < items.length) {
          const idx = cursor++;
          results[idx] = await task(items[idx]);
          // Tiny jitter between starts so we don't hammer the endpoint in a
          // perfectly aligned burst. Keeps the default concurrency=5 polite.
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
        }
      })()
    );
  }

  await Promise.all(workers);
  return results;
}

async function resolveTargetIds(options: {
  filter?: string;
  ids?: string;
  readStdin: boolean;
}): Promise<{ ids: string[]; typeMap: Map<string, string> }> {
  const explicit: string[] = [];

  if (options.ids) {
    for (const id of options.ids.split(',').map((s) => s.trim()).filter(Boolean)) {
      explicit.push(id);
    }
  }

  if (options.readStdin) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const id = line.trim();
      if (id) explicit.push(id);
    }
  }

  const hasFilter = Boolean(options.filter);
  if (explicit.length === 0 && !hasFilter) {
    throw new Error(
      'No target devices supplied — provide --ids, --filter, or pass "-" to read deviceIds from stdin.'
    );
  }

  // Always fetch the device list so we can (a) apply --filter when present
  // and (b) build a deviceId → deviceType map for destructive/validation
  // checks regardless of how the ids were provided.
  const body = await fetchDeviceList();
  const hubLoc = buildHubLocationMap(body.deviceList);

  const typeMap = new Map<string, string>();
  for (const d of body.deviceList) if (d.deviceType) typeMap.set(d.deviceId, d.deviceType);
  for (const ir of body.infraredRemoteList) typeMap.set(ir.deviceId, ir.remoteType);

  let ids: string[];
  if (hasFilter) {
    const clauses = parseFilter(options.filter);
    const matched = applyFilter(clauses, body.deviceList, body.infraredRemoteList, hubLoc);
    const filteredIds = new Set(matched.map((m) => m.deviceId));
    ids =
      explicit.length > 0 ? explicit.filter((id) => filteredIds.has(id)) : [...filteredIds];
  } else {
    ids = explicit;
  }

  return { ids, typeMap };
}

export function registerBatchCommand(devices: Command): void {
  devices
    .command('batch')
    .description('Send the same command to many devices in one run (filter- or stdin-driven)')
    .argument('<command>', 'Command name, e.g. turnOn, turnOff, setBrightness')
    .argument('[parameter]', 'Command parameter (same rules as `devices command`; omit for no-arg)')
    .option('--filter <expr>', 'Target devices matching a filter, e.g. type=Bot,family=Home')
    .option('--ids <csv>', 'Explicit comma-separated list of deviceIds')
    .option('--concurrency <n>', 'Max parallel in-flight requests (default 5)', '5')
    .option('--yes', 'Allow destructive commands (Smart Lock unlock, garage open, ...)')
    .option('--type <commandType>', '"command" (default) or "customize" for user-defined IR buttons', 'command')
    .option('--stdin', 'Read deviceIds from stdin, one per line (same as trailing "-")')
    .addHelpText('after', `
Targets are resolved in this priority order:
  1. --ids when present       (explicit deviceIds)
  2. stdin when --stdin / "-" (one deviceId per line)
  3. --filter                 (matches the account's device list)
  You can combine explicit ids with --filter to intersect them.

Filter grammar:
  key=value          exact match
  key~=value         case-insensitive substring match
  clauses are comma-separated AND

Supported keys:  type, family, room, category  (category: physical | ir)

Output:
  Human mode:  one status line per device, summary at the end.
  --json:      {succeeded[], failed[{deviceId,error}], summary:{total,ok,failed,skipped,durationMs}}

Safety:
  Destructive commands (Smart Lock unlock, Garage Door Opener turnOn/turnOff,
  Keypad createKey/deleteKey) are blocked by default. Pass --yes to override.
  --dry-run intercepts every POST and reports the intended calls without
  hitting the API.

Examples:
  $ switchbot devices batch turnOff --filter 'type~=Light,family=家里'
  $ switchbot devices batch turnOn --ids ID1,ID2,ID3
  $ switchbot devices list --format=id --filter 'type=Bot' | switchbot devices batch toggle -
  $ switchbot devices batch unlock --filter 'type=Smart Lock' --yes
`)
    .action(
      async (
        cmd: string,
        parameter: string | undefined,
        options: {
          filter?: string;
          ids?: string;
          concurrency: string;
          yes?: boolean;
          type: string;
          stdin?: boolean;
        },
        commandObj: Command
      ) => {
        // Trailing "-" sentinel selects stdin mode.
        const extra = commandObj.args ?? [];
        const readStdin = Boolean(options.stdin) || extra.includes('-');

        let resolved: Awaited<ReturnType<typeof resolveTargetIds>>;
        try {
          resolved = await resolveTargetIds({
            filter: options.filter,
            ids: options.ids,
            readStdin,
          });
        } catch (error) {
          if (error instanceof FilterSyntaxError) {
            console.error(`Error: ${error.message}`);
            process.exit(2);
          }
          if (error instanceof Error && error.message.startsWith('No target devices')) {
            console.error(`Error: ${error.message}`);
            process.exit(2);
          }
          handleError(error);
        }

        if (resolved.ids.length === 0) {
          const out: BatchResult = {
            succeeded: [],
            failed: [],
            summary: { total: 0, ok: 0, failed: 0, skipped: 0, durationMs: 0 },
          };
          if (isJsonMode()) printJson(out);
          else console.log('No devices matched — nothing to do.');
          return;
        }

        const effectiveType = (options.type === 'customize' ? 'customize' : 'command') as
          | 'command'
          | 'customize';

        // Pre-flight: identify destructive targets before spending API calls.
        const blockedForDestructive: Array<{ deviceId: string; reason: string }> = [];
        for (const id of resolved.ids) {
          const t = resolved.typeMap.get(id);
          if (isDestructiveCommand(t, cmd, effectiveType) && !options.yes) {
            blockedForDestructive.push({
              deviceId: id,
              reason: `destructive command "${cmd}" on ${t ?? 'unknown'} requires --yes`,
            });
          }
        }

        if (blockedForDestructive.length > 0 && !options.yes) {
          const out: BatchResult = {
            succeeded: [],
            failed: blockedForDestructive.map((b) => ({
              deviceId: b.deviceId,
              error: b.reason,
            })),
            summary: {
              total: resolved.ids.length,
              ok: 0,
              failed: blockedForDestructive.length,
              skipped: resolved.ids.length - blockedForDestructive.length,
              durationMs: 0,
            },
          };
          if (isJsonMode()) {
            printJson(out);
          } else {
            console.error(
              `Refusing to run destructive command "${cmd}" on ${blockedForDestructive.length} device(s) without --yes:`
            );
            for (const b of blockedForDestructive) console.error(`  ${b.deviceId}`);
          }
          process.exit(2);
        }

        // parameter may be a JSON object string; mirror the single-command action.
        let parsedParam: unknown = parameter ?? 'default';
        if (parameter) {
          try {
            parsedParam = JSON.parse(parameter);
          } catch {
            // keep as string
          }
        }

        const concurrency = Math.max(1, Number.parseInt(options.concurrency, 10) || DEFAULT_CONCURRENCY);
        const dryRun = isDryRun();
        const startedAt = Date.now();

        const outcomes = await runPool(resolved.ids, concurrency, async (id) => {
          try {
            const result = await executeCommand(id, cmd, parsedParam, effectiveType);
            if (!isJsonMode()) {
              console.log(`✓ ${id}: ${cmd}`);
            }
            return { ok: true as const, deviceId: id, result };
          } catch (err) {
            // --dry-run uses DryRunSignal to short-circuit; surface that as a
            // "skipped" outcome, not a failure.
            if (err instanceof DryRunSignal) {
              return { ok: 'dry-run' as const, deviceId: id };
            }
            const message = err instanceof Error ? err.message : String(err);
            if (!isJsonMode()) {
              console.error(`✗ ${id}: ${message}`);
            }
            return { ok: false as const, deviceId: id, error: message };
          }
        });

        const succeeded = outcomes.filter((o) => o.ok === true) as Array<{
          ok: true;
          deviceId: string;
          result: unknown;
        }>;
        const failed = outcomes.filter((o) => o.ok === false) as Array<{
          ok: false;
          deviceId: string;
          error: string;
        }>;
        const dryRunned = outcomes.filter((o) => o.ok === 'dry-run') as Array<{
          ok: 'dry-run';
          deviceId: string;
        }>;

        const result: BatchResult = {
          succeeded: succeeded.map((s) => ({ deviceId: s.deviceId, result: s.result })),
          failed: failed.map((f) => ({ deviceId: f.deviceId, error: f.error })),
          summary: {
            total: resolved.ids.length,
            ok: succeeded.length,
            failed: failed.length,
            skipped: dryRunned.length,
            durationMs: Date.now() - startedAt,
            ...(dryRun ? { dryRun: true } : {}),
          },
        };

        if (isJsonMode()) {
          printJson(result);
        } else {
          console.log(
            `\nSummary: ${result.summary.ok} ok, ${result.summary.failed} failed, ${result.summary.skipped} skipped (${result.summary.durationMs}ms)`
          );
        }

        // Non-zero exit when anything failed so scripts can react.
        if (failed.length > 0) process.exit(1);
      }
    );
}
