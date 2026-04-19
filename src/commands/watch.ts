import { Command } from 'commander';
import { printJsonLine, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { fetchDeviceStatus } from '../lib/devices.js';
import { getCachedDevice, loadStatusCache, setCachedStatus } from '../devices/cache.js';
import { parseDurationToMs, getFields, isVerbose } from '../utils/flags.js';
import { createClient } from '../api/client.js';
import { loadConfig } from '../config.js';
import { MqttTlsClient } from '../mqtt/client.js';
import { getCredential } from '../mqtt/credential.js';
import { extractShadowEvent } from '../mqtt/shadow.js';

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
    .argument('<deviceId...>', 'One or more deviceIds to watch')
    .option(
      '--interval <dur>',
      `Polling interval: "30s", "1m", "500ms", ... (default 30s, min ${MIN_INTERVAL_MS / 1000}s)`,
      '30s',
    )
    .option('--max <n>', 'Stop after N ticks (default: run until Ctrl-C)')
    .option('--include-unchanged', 'Emit a tick even when no field changed')
    .option('--via-mqtt', 'Subscribe to MQTT shadow updates instead of polling (requires online broker)')
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
`,
    )
    .action(
      async (
        deviceIds: string[],
        options: {
          interval: string;
          max?: string;
          includeUnchanged?: boolean;
          viaMqtt?: boolean;
        },
      ) => {
        try {
          let maxTicks: number | null = null;
          if (options.max !== undefined) {
            const n = Number(options.max);
            if (!Number.isFinite(n) || n < 1) {
              throw new UsageError(`Invalid --max "${options.max}". Must be a positive integer.`);
            }
            maxTicks = Math.floor(n);
          }

          const fields: string[] | null = getFields() ?? null;

          if (options.viaMqtt) {
            await watchViaMqtt(deviceIds, maxTicks, fields);
          } else {
            const parsed = parseDurationToMs(options.interval);
            if (parsed === null || parsed < MIN_INTERVAL_MS) {
              throw new UsageError(
                `Invalid --interval "${options.interval}". Minimum is ${MIN_INTERVAL_MS / 1000}s.`,
              );
            }
            const intervalMs = parsed;
            await watchViaPolling(deviceIds, intervalMs, maxTicks, fields, options.includeUnchanged);
          }
        } catch (error) {
          handleError(error);
        }
      },
    );
}

async function watchViaPolling(
  deviceIds: string[],
  intervalMs: number,
  maxTicks: number | null,
  fields: string[] | null,
  includeUnchanged?: boolean,
): Promise<void> {
  const prev = new Map<string, Record<string, unknown>>();
  const client = createClient();
  let tick = 0;

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  try {
    while (!ac.signal.aborted) {
      tick++;
      const t = new Date().toISOString();
      await Promise.all(
        deviceIds.map(async (id) => {
          const cached = getCachedDevice(id);
          try {
            const body = await fetchDeviceStatus(id, client);
            const changed = diff(prev.get(id), body, fields);
            prev.set(id, body);
            if (Object.keys(changed).length === 0 && !includeUnchanged) {
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
              printJsonLine(ev);
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
              printJsonLine(ev);
            } else {
              console.error(formatHumanLine(ev));
            }
          }
        }),
      );

      if (maxTicks !== null && tick >= maxTicks) break;
      await sleep(intervalMs, ac.signal);
    }
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

async function watchViaMqtt(
  deviceIds: string[],
  maxTicks: number | null,
  fields: string[] | null,
): Promise<void> {
  const config = loadConfig();
  const credential = await getCredential(config.token, config.secret);
  const mqttClient = new MqttTlsClient();
  const ac = new AbortController();

  const onSig = () => ac.abort();
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  try {
    mqttClient.setAbortSignal(ac.signal);
    await mqttClient.connect(credential);

    if (!isJsonMode()) {
      const brokerHost = new URL(credential.brokerUrl).hostname || credential.brokerUrl;
      console.error(`[mqtt] connected to ${brokerHost}`);
      console.error(`[mqtt] subscribed to ${credential.topics.length} topics`);
    }

    const prev = new Map<string, Record<string, unknown>>();
    const deviceIdSet = new Set(deviceIds);
    let tick = 0;

    mqttClient.on('message', ((_topic: string, payload: Buffer) => {
      try {
        const message = JSON.parse(payload.toString('utf-8'));
        const event = extractShadowEvent(message);
        if (!event) return;
        if (!deviceIdSet.has(event.deviceId)) return;

        const existing = loadStatusCache().entries[event.deviceId]?.body ?? {};
        setCachedStatus(event.deviceId, { ...existing, ...event.payload });

        tick++;
        const t = new Date().toISOString();
        const cached = getCachedDevice(event.deviceId);
        const changed = diff(prev.get(event.deviceId), event.payload, fields);
        prev.set(event.deviceId, event.payload);

        if (Object.keys(changed).length === 0) return;

        const ev: TickEvent = {
          t,
          tick,
          deviceId: event.deviceId,
          type: cached?.type,
          changed,
        };
        if (isJsonMode()) {
          printJsonLine(ev);
        } else {
          console.log(formatHumanLine(ev));
        }

        if (maxTicks !== null && tick >= maxTicks) {
          ac.abort();
        }
      } catch (err) {
        if (isVerbose()) {
          console.error(`[mqtt] skipped malformed message: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }) as (...args: unknown[]) => void);

    await mqttClient.subscribeAll(credential.topics);

    await new Promise<void>((resolve, reject) => {
      mqttClient.onRuntimeError((err) => {
        reject(err);
        ac.abort();
      });
      const cleanup = () => {
        mqttClient.end().then(resolve).catch(resolve);
      };
      ac.signal.addEventListener('abort', cleanup, { once: true });
    });
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}
