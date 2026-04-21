import { Command } from 'commander';
import type { AxiosInstance } from 'axios';
import { intArg, enumArg, stringArg } from '../utils/arg-parsers.js';
import { printJson, isJsonMode, handleError, buildErrorPayload, UsageError, emitJsonError, exitWithError, type ErrorPayload } from '../utils/output.js';
import {
  fetchDeviceList,
  executeCommand,
  isDestructiveCommand,
  buildHubLocationMap,
} from '../lib/devices.js';
import { createClient } from '../api/client.js';
import { parseFilter, applyFilter, FilterSyntaxError } from '../utils/filter.js';
import { isDryRun } from '../utils/flags.js';
import { DryRunSignal } from '../api/client.js';
import { getCachedTypeMap, getCachedDevice, loadStatusCache } from '../devices/cache.js';

interface BatchStepTiming {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  replayed?: boolean;
}

interface BatchResult {
  succeeded: Array<{
    deviceId: string;
    result: unknown;
    subKind?: 'ir-no-feedback';
    verification?: {
      verifiable: false;
      reason: string;
      suggestedFollowup: string;
    };
  } & BatchStepTiming>;
  failed: Array<{ deviceId: string; error: ErrorPayload } & BatchStepTiming>;
  skipped?: Array<{ deviceId: string; reason: 'offline' }>;
  summary: {
    total: number;
    ok: number;
    failed: number;
    skipped: number;
    durationMs: number;
    unverifiableCount: number;
    dryRun?: boolean;
    schemaVersion?: string;
    maxConcurrent?: number;
    staggerMs?: number;
  };
}

const DEFAULT_CONCURRENCY = 5;
const COMMAND_TYPES = ['command', 'customize'] as const;

/**
 * Run `task(x)` for every element with at most `concurrency` running at once.
 * `staggerMs`: when > 0, delay each task start by this fixed interval (replaces
 * the default 20-60ms jitter). Useful for rate-limited endpoints.
 */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  staggerMs: number,
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
          // Fixed stagger wins over random jitter when set; else keep the
          // default polite spacing so we don't hammer the endpoint.
          const delay = staggerMs > 0 ? staggerMs : 20 + Math.random() * 40;
          await new Promise((r) => setTimeout(r, delay));
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
}, getClient?: () => AxiosInstance): Promise<{ ids: string[]; typeMap: Map<string, string> }> {
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

  const typeMap = getCachedTypeMap(explicit);

  let ids: string[];
  if (hasFilter) {
    const body = await fetchDeviceList(getClient?.());
    const hubLoc = buildHubLocationMap(body.deviceList);
    for (const d of body.deviceList) if (d.deviceType) typeMap.set(d.deviceId, d.deviceType);
    for (const ir of body.infraredRemoteList) typeMap.set(ir.deviceId, ir.remoteType);
    const clauses = parseFilter(options.filter);
    const matched = applyFilter(clauses, body.deviceList, body.infraredRemoteList, hubLoc);
    const filteredIds = new Set(matched.map((m) => m.deviceId));
    ids =
      explicit.length > 0 ? explicit.filter((id) => filteredIds.has(id)) : [...filteredIds];
  } else {
    ids = explicit;
    const missingTypeInfo = ids.some((id) => !typeMap.has(id));
    if (missingTypeInfo) {
      const body = await fetchDeviceList(getClient?.());
      for (const d of body.deviceList) if (d.deviceType) typeMap.set(d.deviceId, d.deviceType);
      for (const ir of body.infraredRemoteList) typeMap.set(ir.deviceId, ir.remoteType);
    }
  }

  return { ids, typeMap };
}

export function registerBatchCommand(devices: Command): void {
  devices
    .command('batch')
    .description('Send the same command to many devices in one run (filter- or stdin-driven)')
    .argument('<command>', 'Command name, e.g. turnOn, turnOff, setBrightness')
    .argument('[parameter]', 'Command parameter (same rules as `devices command`; omit for no-arg)')
    .option('--filter <expr>', 'Target devices matching a filter, e.g. type=Bot,family=Home', stringArg('--filter'))
    .option('--ids <csv>', 'Explicit comma-separated list of deviceIds', stringArg('--ids'))
    .option('--concurrency <n>', 'Max parallel in-flight requests (default 5)', intArg('--concurrency', { min: 1 }), '5')
    .option('--max-concurrent <n>', 'Alias for --concurrency; takes priority when set', intArg('--max-concurrent', { min: 1 }))
    .option('--stagger <ms>', 'Fixed delay between task starts in ms (default 0 = random 20-60ms jitter)', intArg('--stagger', { min: 0 }), '0')
    .option('--plan', 'With --dry-run: emit a plan JSON document instead of executing anything')
    .option('--yes', 'Allow destructive commands (Smart Lock unlock, garage open, ...)')
    .option('--type <commandType>', '"command" (default) or "customize" for user-defined IR buttons', enumArg('--type', COMMAND_TYPES), 'command')
    .option('--stdin', 'Read deviceIds from stdin, one per line (same as trailing "-")')
    .option('--idempotency-key-prefix <prefix>', 'Client-supplied prefix for idempotency keys (key per device: <prefix>-<deviceId>). process-local 60s window; cache is per Node process (MCP session, batch run, plan run). Independent CLI invocations do not share cache.', stringArg('--idempotency-key-prefix'))
    .option('--idempotency-key <prefix>', 'Alias for --idempotency-key-prefix.', stringArg('--idempotency-key'))
    .option('--skip-offline', 'Skip devices whose cached status is offline (no API call; cache miss → send as usual).')
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
  --json:      {succeeded[], failed[{deviceId,error}], summary:{total,ok,failed,skipped,durationMs,maxConcurrent,staggerMs}}
  Each step includes startedAt / finishedAt / durationMs / replayed (when cached).

Concurrency & pacing:
  --max-concurrent <n>   Upper bound on in-flight requests (alias for --concurrency).
  --stagger <ms>         Fixed delay between task starts; default 0 uses random 20-60ms jitter.

Planning:
  --dry-run --plan       Print the plan JSON without executing anything. Useful
                         for agents that want to show the user what will run.

Safety:
  Destructive commands (Smart Lock unlock, Garage Door Opener turnOn/turnOff,
  Keypad createKey/deleteKey) are blocked by default. Pass --yes to override.
  --dry-run intercepts every POST and reports the intended calls without
  hitting the API.

Examples:
  $ switchbot devices batch turnOff --filter 'type~=Light,family=home'
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
          maxConcurrent?: string;
          stagger: string;
          plan?: boolean;
          yes?: boolean;
          type: string;
          stdin?: boolean;
          idempotencyKeyPrefix?: string;
          idempotencyKey?: string;
          skipOffline?: boolean;
        },
        commandObj: Command
      ) => {
        // Trailing "-" sentinel selects stdin mode.
        const extra = commandObj.args ?? [];
        const readStdin = Boolean(options.stdin) || extra.includes('-');
        // Accept --idempotency-key as alias; reject when both forms are supplied.
        if (options.idempotencyKey !== undefined && options.idempotencyKeyPrefix !== undefined) {
          handleError(new UsageError('Use either --idempotency-key or --idempotency-key-prefix, not both.'));
          return;
        }
        if (options.idempotencyKey !== undefined && options.idempotencyKeyPrefix === undefined) {
          options.idempotencyKeyPrefix = options.idempotencyKey;
        }
        let client: AxiosInstance | undefined;
        const getClient = (): AxiosInstance => (client ??= createClient());

        let resolved: Awaited<ReturnType<typeof resolveTargetIds>>;
        try {
          resolved = await resolveTargetIds({
            filter: options.filter,
            ids: options.ids,
            readStdin,
          }, getClient);
        } catch (error) {
          if (error instanceof FilterSyntaxError) {
            exitWithError(`Error: ${error.message}`);
          }
          if (error instanceof Error && error.message.startsWith('No target devices')) {
            exitWithError(`Error: ${error.message}`);
          }
          handleError(error);
        }

        if (resolved.ids.length === 0) {
          const out: BatchResult = {
            succeeded: [],
            failed: [],
            summary: { total: 0, ok: 0, failed: 0, skipped: 0, durationMs: 0, unverifiableCount: 0 },
          };
          if (isJsonMode()) printJson(out);
          else console.log('No devices matched — nothing to do.');
          return;
        }

        const effectiveType = (options.type === 'customize' ? 'customize' : 'command') as
          | 'command'
          | 'customize';

        // --skip-offline: preflight using the status cache (no network). Cache
        // miss = send as usual; only definite "offline" cached entries skip.
        const preSkipped: Array<{ deviceId: string; reason: 'offline' }> = [];
        if (options.skipOffline && resolved.ids.length > 0) {
          const statusCache = loadStatusCache();
          const kept: string[] = [];
          for (const id of resolved.ids) {
            const entry = statusCache.entries[id];
            const online = entry?.body?.onlineStatus;
            if (online === 'offline') {
              preSkipped.push({ deviceId: id, reason: 'offline' });
            } else {
              kept.push(id);
            }
          }
          resolved = { ...resolved, ids: kept };
        }

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
          if (isJsonMode()) {
            const deviceIds = blockedForDestructive.map((b) => b.deviceId);
            emitJsonError({
              code: 2,
              kind: 'guard',
              message: `Destructive command "${cmd}" requires --yes to run on ${blockedForDestructive.length} device(s).`,
              hint: 'Re-issue the call with --yes to proceed.',
              context: { command: cmd, deviceIds },
            });
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

        const maxConcurrentRaw = options.maxConcurrent ?? options.concurrency;
        const concurrency = Math.max(1, Number.parseInt(maxConcurrentRaw, 10) || DEFAULT_CONCURRENCY);
        const staggerMs = Math.max(0, Number.parseInt(options.stagger, 10) || 0);
        const dryRun = isDryRun();

        // --dry-run --plan: emit a plan document and return without executing.
        if (dryRun && options.plan) {
          const steps = resolved.ids.map((id) => ({
            deviceId: id,
            command: cmd,
            parameter: parsedParam,
            type: effectiveType,
            idempotencyKey: options.idempotencyKeyPrefix
              ? `${options.idempotencyKeyPrefix}-${id}`
              : undefined,
          }));
          const planDoc = {
            schemaVersion: '1.1',
            dryRun: true,
            plan: {
              command: cmd,
              parameter: parsedParam,
              type: effectiveType,
              maxConcurrent: concurrency,
              staggerMs,
              stepCount: steps.length,
              steps,
            },
          };
          if (isJsonMode()) {
            printJson(planDoc);
          } else {
            console.log(
              `Plan: ${steps.length} step(s), command=${cmd}, maxConcurrent=${concurrency}, staggerMs=${staggerMs}`
            );
            for (const s of steps) console.log(`  → ${s.deviceId} ${s.type} ${s.command}`);
          }
          return;
        }

        const startedAt = Date.now();

        const outcomes = await runPool(resolved.ids, concurrency, staggerMs, async (id) => {
          const stepStart = Date.now();
          const startedIso = new Date(stepStart).toISOString();
          try {
            const idempotencyKey = options.idempotencyKeyPrefix
              ? `${options.idempotencyKeyPrefix}-${id}`
              : undefined;
            const result = await executeCommand(id, cmd, parsedParam, effectiveType, getClient(), {
              idempotencyKey,
            });
            const finishedIso = new Date().toISOString();
            const durationMs = Date.now() - stepStart;
            const replayed =
              typeof result === 'object' && result !== null && (result as { replayed?: boolean }).replayed === true;
            if (!isJsonMode()) {
              console.log(`✓ ${id}: ${cmd}${replayed ? ' (replayed)' : ''}`);
            }
            return {
              ok: true as const,
              deviceId: id,
              result,
              startedAt: startedIso,
              finishedAt: finishedIso,
              durationMs,
              replayed,
            };
          } catch (err) {
            // --dry-run uses DryRunSignal to short-circuit; surface that as a
            // "skipped" outcome, not a failure.
            if (err instanceof DryRunSignal) {
              return {
                ok: 'dry-run' as const,
                deviceId: id,
                startedAt: startedIso,
                finishedAt: new Date().toISOString(),
                durationMs: Date.now() - stepStart,
              };
            }
            const errorPayload = buildErrorPayload(err);
            if (!isJsonMode()) {
              console.error(`✗ ${id}: ${errorPayload.message}`);
            }
            return {
              ok: false as const,
              deviceId: id,
              error: errorPayload,
              startedAt: startedIso,
              finishedAt: new Date().toISOString(),
              durationMs: Date.now() - stepStart,
            };
          }
        });

        const succeeded = outcomes.filter((o) => o.ok === true) as Array<{
          ok: true;
          deviceId: string;
          result: unknown;
          startedAt: string;
          finishedAt: string;
          durationMs: number;
          replayed: boolean;
        }>;
        const failed = outcomes.filter((o) => o.ok === false) as Array<{
          ok: false;
          deviceId: string;
          error: ErrorPayload;
          startedAt: string;
          finishedAt: string;
          durationMs: number;
        }>;
        const dryRunned = outcomes.filter((o) => o.ok === 'dry-run') as Array<{
          ok: 'dry-run';
          deviceId: string;
          startedAt: string;
          finishedAt: string;
          durationMs: number;
        }>;

        const result: BatchResult = {
          succeeded: succeeded.map((s) => {
            const isIr = getCachedDevice(s.deviceId)?.category === 'ir';
            const entry: BatchResult['succeeded'][number] = {
              deviceId: s.deviceId,
              result: s.result,
              startedAt: s.startedAt,
              finishedAt: s.finishedAt,
              durationMs: s.durationMs,
              replayed: s.replayed,
            };
            if (isIr) {
              entry.subKind = 'ir-no-feedback';
              entry.verification = {
                verifiable: false,
                reason: 'IR transmission is unidirectional; no receipt acknowledgment is possible.',
                suggestedFollowup: 'Confirm visible change manually or via a paired state sensor.',
              };
            }
            return entry;
          }),
          failed: failed.map((f) => ({
            deviceId: f.deviceId,
            error: f.error,
            startedAt: f.startedAt,
            finishedAt: f.finishedAt,
            durationMs: f.durationMs,
          })),
          ...(preSkipped.length > 0 ? { skipped: preSkipped } : {}),
          summary: {
            total: resolved.ids.length + preSkipped.length,
            ok: succeeded.length,
            failed: failed.length,
            skipped: dryRunned.length + preSkipped.length,
            durationMs: Date.now() - startedAt,
            unverifiableCount: succeeded.filter((s) => getCachedDevice(s.deviceId)?.category === 'ir').length,
            schemaVersion: '1.1',
            maxConcurrent: concurrency,
            staggerMs,
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
