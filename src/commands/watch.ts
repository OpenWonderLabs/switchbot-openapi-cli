import { Command } from 'commander';
import { printJson, isJsonMode, handleError, UsageError, emitStreamHeader } from '../utils/output.js';
import { fetchDeviceStatus } from '../lib/devices.js';
import { getCachedDevice } from '../devices/cache.js';
import { parseDurationToMs, getFields } from '../utils/flags.js';
import { intArg, durationArg, stringArg, enumArg } from '../utils/arg-parsers.js';
import { createClient } from '../api/client.js';
import { resolveDeviceId } from '../utils/name-resolver.js';
import { resolveFieldList, listAllCanonical } from '../schema/field-aliases.js';

const DEFAULT_INTERVAL_MS = 30_000;
const MIN_INTERVAL_MS = 1_000;

interface TickEvent {
  t: string;
  tick: number;
  deviceId: string;
  type?: string;
  changed: Record<string, { from: unknown; to: unknown }>;
  snapshot?: Record<string, unknown>;
  error?: string;
}

const INITIAL_MODES = ['snapshot', 'emit', 'skip'] as const;

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
  if (ev.snapshot) {
    const pairs = Object.entries(ev.snapshot)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(', ');
    return `${head}: snapshot ${pairs}`;
  }
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
    .description('Poll device status on an interval and emit field-level changes (human table by default; JSONL with --json for agents)')
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
    .option('--initial <mode>', 'How to handle the first poll: snapshot | emit | skip (default: snapshot)', enumArg('--initial', INITIAL_MODES), 'snapshot')
    .addHelpText(
      'after',
      `
Default output is a human-readable table of field changes per tick; add --json
to get one JSON-Lines record per deviceId per tick (the agent-friendly form).

The first poll is configurable:
  --initial=snapshot  emit one baseline snapshot event, then only diffs
  --initial=emit      treat the first poll as null -> value changes
  --initial=skip      record the baseline silently, then only diffs

Subsequent ticks only include fields whose value changed (unless
--include-unchanged is passed).

Each --json line has the shape:
  { "t": "<ISO>", "tick": <n>, "deviceId": "ID", "type": "Bot",
    "changed": { "power": { "from": "off", "to": "on" } } }

Examples:
  $ switchbot devices watch ABC123 --interval 10s
  $ switchbot devices watch ABC123 --fields battery,power --interval 1m
  $ switchbot devices watch ABC123 DEF456 --interval 30s --max 10
  # Agent-friendly: one JSONL record per tick, pipeable to jq
  $ switchbot devices watch ABC123 --json | jq 'select(.changed.power)'
  $ switchbot devices watch --name "Living Room AC" --interval 10s
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
          initial: 'snapshot' | 'emit' | 'skip';
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

          const rawFields: string[] | null = getFields() ?? null;
          // Resolve aliases upfront against the static canonical registry.
          // Validating here lets UsageError exit the command before any
          // polling starts, and keeps mid-loop error handling free of
          // "misuse" concerns. Unknown fields that are not registered as
          // aliases but happen to match an API key pass through unchanged.
          const fields: string[] | null = rawFields
            ? resolveFieldList(rawFields, listAllCanonical())
            : null;

          const ac = new AbortController();
          const onSig = () => ac.abort();
          process.on('SIGINT', onSig);
          process.on('SIGTERM', onSig);
          const forTimer = forMs !== null && forMs > 0
            ? setTimeout(() => ac.abort(), forMs)
            : null;

          // P7: streaming JSON contract — first line under --json is the
          // stream header so consumers can route by eventKind/cadence.
          if (isJsonMode()) emitStreamHeader({ eventKind: 'tick', cadence: 'poll' });

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
                  const previous = prev.get(id);
                  const baseline = fields
                    ? Object.fromEntries(fields.map((f) => [f, body[f] ?? null]))
                    : body;
                  if (!prev.has(id)) {
                    if (options.initial === 'skip') {
                      prev.set(id, body);
                      return;
                    }
                    if (options.initial === 'snapshot') {
                      prev.set(id, body);
                      const ev: TickEvent = {
                        t,
                        tick,
                        deviceId: id,
                        type: cached?.type,
                        changed: {},
                        snapshot: baseline,
                      };
                      if (isJsonMode()) {
                        printJson(ev);
                      } else {
                        console.log(formatHumanLine(ev));
                      }
                      return;
                    }
                  }
                  const changed = diff(previous, body, fields);
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
