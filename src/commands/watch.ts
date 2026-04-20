import { Command } from 'commander';
import { printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { fetchDeviceStatus } from '../lib/devices.js';
import { getCachedDevice } from '../devices/cache.js';
import { parseDurationToMs, getFields } from '../utils/flags.js';
import { intArg, durationArg, stringArg } from '../utils/arg-parsers.js';
import { createClient } from '../api/client.js';
import { resolveDeviceId } from '../utils/name-resolver.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;

interface TickEvent {
  t: string;
  tick: number;
  deviceId: string;
  type?: string;
  changed: Record<string, { from: unknown; to: unknown }>;
  error?: string;
}

function diff(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  fields: string[] | null,
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  const keys = fields ?? Object.keys(next);
  for (const k of keys) {
    const a = prev ? prev[k] : undefined;
    const b = next[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out[k] = { from: prev ? a : null, to: b };
    }
  }
  return out;
}

function formatHumanLine(ev: TickEvent): string {
  const when = new Date(ev.t).toLocaleTimeString();
  const head = `[${when}] ${ev.deviceId}${ev.type ? ` (${ev.type})` : ''}`;
  if (ev.error) return `${head}: error — ${ev.error}`;
  const keys = Object.keys(ev.changed);
  if (keys.length === 0) return `${head}: no changes`;
  const pairs = keys
    .map((k) => {
      const { from, to } = ev.changed[k];
      if (from === null || from === undefined) return `${k}=${JSON.stringify(to)}`;
      return `${k}: ${JSON.stringify(from)} → ${JSON.stringify(to)}`;
    })
    .join(', ');
  return `${head} ${pairs}`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(), ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    if (signal.aborted) {
      clearTimeout(t);
      resolve();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function registerWatchCommand(devices: Command): void {
  devices
    .command('watch')
    .description('Poll device status on an interval and emit field-level changes (JSONL)')
    .argument('[deviceId...]', 'One or more deviceIds to watch (or use --name for one device)')
    .option('--name <query>', 'Resolve one device by fuzzy name (combined with any positional IDs)', stringArg('--name'))
    .option(
      '--interval <dur>',
      `Polling interval: "30s", "1m", "500ms", ... (default 30s, min ${MIN_INTERVAL_MS / 1000}s)`,
      durationArg('--interval'),
      '30s',
    )
    .option('--max <n>', 'Stop after N ticks (default: run until Ctrl-C)', intArg('--max', { min: 1 }))
    .option('--for <dur>', 'Stop after elapsed time (e.g. "5m", "30s"). Combines with --max: first limit wins.', durationArg('--for'))
    .option('--include-unchanged', 'Emit a tick even when no field changed')
    .addHelpText(
      'after',
      `
Each poll emits one JSON line per deviceId with the shape:
  { "t": "<ISO>", "tick": <n>, "deviceId": "ID", "type": "Bot",
    "changed": { "power": { "from": "off", "to": "on" } } }

The very first poll has "from": null for every field (seed).

Examples:
  $ switchbot devices watch ABC123 --interval 10s
  $ switchbot devices watch ABC123 --fields battery,power --interval 1m
  $ switchbot devices watch ABC123 DEF456 --interval 30s --max 10
  $ switchbot devices watch ABC123 --json | jq 'select(.changed.power)'
  $ switchbot devices watch --name "客厅空调" --interval 10s
`,
    )
    .action(
      async (
        deviceIds: string[],
        options: {
          name?: string;
          interval: string;
          max?: string;
          for?: string;
          includeUnchanged?: boolean;
        },
      ) => {
        try {
          const allIds = [...deviceIds];
          if (options.name) {
            const resolved = resolveDeviceId(undefined, options.name);
            if (!allIds.includes(resolved)) allIds.push(resolved);
          }
          if (allIds.length === 0) throw new UsageError('Provide at least one deviceId argument or --name.');
          const parsed = parseDurationToMs(options.interval);
          if (parsed === null || parsed < MIN_INTERVAL_MS) {
            throw new UsageError(
              `Invalid --interval "${options.interval}". Minimum is ${MIN_INTERVAL_MS / 1000}s.`,
            );
          }
          const intervalMs = parsed;

          let maxTicks: number | null = null;
          if (options.max !== undefined) {
            const n = Number(options.max);
            if (!Number.isFinite(n) || n < 1) {
              throw new UsageError(`Invalid --max "${options.max}". Must be a positive integer.`);
            }
            maxTicks = Math.floor(n);
          }

          const forMs = options.for ? parseDurationToMs(options.for) : null;

          const fields: string[] | null = getFields() ?? null;

          const ac = new AbortController();
          const onSig = () => ac.abort();
          process.on('SIGINT', onSig);
          process.on('SIGTERM', onSig);
          const forTimer = forMs !== null && forMs > 0
            ? setTimeout(() => ac.abort(), forMs)
            : null;

          try {
          const prev = new Map<string, Record<string, unknown>>();
          const client = createClient();
          let tick = 0;
          while (!ac.signal.aborted) {
            tick++;
            const t = new Date().toISOString();
            // Poll all devices in parallel; one failure per device doesn't stop
            // the others.
            await Promise.all(
              allIds.map(async (id) => {
                const cached = getCachedDevice(id);
                try {
                  const body = await fetchDeviceStatus(id, client);
                  const changed = diff(prev.get(id), body, fields);
                  prev.set(id, body);
                  if (Object.keys(changed).length === 0 && !options.includeUnchanged) {
                    return;
                  }
                  const ev: TickEvent = {
                    t,
                    tick,
                    deviceId: id,
                    type: cached?.type,
                    changed,
                  };
                  if (isJsonMode()) {
                    // JSONL: one event per line (printJson with newline).
                    printJson(ev);
                  } else {
                    console.log(formatHumanLine(ev));
                  }
                } catch (err) {
                  const ev: TickEvent = {
                    t,
                    tick,
                    deviceId: id,
                    type: cached?.type,
                    changed: {},
                    error: err instanceof Error ? err.message : String(err),
                  };
                  if (isJsonMode()) {
                    printJson(ev);
                  } else {
                    console.error(formatHumanLine(ev));
                  }
                }
              }),
            );

            if (maxTicks !== null && tick >= maxTicks) break;
            await sleep(intervalMs, ac.signal);
          }
          } catch (err) {
            handleError(err);
          } finally {
            if (forTimer) clearTimeout(forTimer);
            process.off('SIGINT', onSig);
            process.off('SIGTERM', onSig);
          }
        } catch (error) {
          handleError(error);
        }
      },
    );
}
