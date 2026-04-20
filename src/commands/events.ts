import { Command } from 'commander';
import http from 'node:http';
import crypto from 'node:crypto';
import { printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { intArg, stringArg, durationArg } from '../utils/arg-parsers.js';
import { parseDurationToMs } from '../utils/flags.js';
import { SwitchBotMqttClient } from '../mqtt/client.js';
import { fetchMqttCredential } from '../mqtt/credential.js';
import { tryLoadConfig } from '../config.js';
import { SinkDispatcher } from '../sinks/dispatcher.js';
import { StdoutSink } from '../sinks/stdout.js';
import { FileSink } from '../sinks/file.js';
import { WebhookSink } from '../sinks/webhook.js';
import { OpenClawSink } from '../sinks/openclaw.js';
import { TelegramSink } from '../sinks/telegram.js';
import { HomeAssistantSink } from '../sinks/homeassistant.js';
import { parseSinkEvent } from '../sinks/format.js';
import type { MqttSinkEvent } from '../sinks/types.js';
import { deviceHistoryStore } from '../mcp/device-history.js';

const DEFAULT_PORT = 3000;
const DEFAULT_PATH = '/';
const MAX_BODY_BYTES = 1_000_000;

function extractEventId(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.eventId === 'string' && p.eventId.length > 0) return p.eventId;
  const ctx = p.context as Record<string, unknown> | undefined;
  if (ctx && typeof ctx.eventId === 'string' && ctx.eventId.length > 0) return ctx.eventId;
  return null;
}

interface EventRecord {
  t: string;
  remote: string;
  path: string;
  body: unknown;
  matched: boolean;
}

function matchFilter(
  body: unknown,
  filter: { deviceId?: string; type?: string } | null,
): boolean {
  if (!filter) return true;
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  const ctx = (b.context ?? b) as Record<string, unknown>;
  if (filter.deviceId && ctx.deviceMac !== filter.deviceId && ctx.deviceId !== filter.deviceId) {
    return false;
  }
  if (filter.type && ctx.deviceType !== filter.type) {
    return false;
  }
  return true;
}

function parseFilter(flag: string | undefined): { deviceId?: string; type?: string } | null {
  if (!flag) return null;
  const allowed = new Set(['deviceId', 'type']);
  const out: { deviceId?: string; type?: string } = {};
  for (const pair of flag.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1 || eq === 0) {
      throw new UsageError(
        `Invalid --filter pair "${pair.trim()}". Expected "key=value". Supported keys: deviceId, type.`
      );
    }
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (!v) {
      throw new UsageError(
        `Empty value for --filter key "${k}". Expected "key=value". Supported keys: deviceId, type.`
      );
    }
    if (!allowed.has(k)) {
      throw new UsageError(
        `Unknown --filter key "${k}". Supported keys: deviceId, type.`
      );
    }
    if (k === 'deviceId') out.deviceId = v;
    else if (k === 'type') out.type = v;
  }
  return out;
}

export function startReceiver(
  port: number,
  pathMatch: string,
  filter: { deviceId?: string; type?: string } | null,
  onEvent: (ev: EventRecord) => void,
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }
    if (req.url !== pathMatch && pathMatch !== '*') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let bailed = false;
    req.on('data', (c: Buffer) => {
      if (bailed) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        bailed = true;
        res.statusCode = 413;
        res.setHeader('connection', 'close');
        res.end('payload too large');
        // Drop remaining upload without destroying the socket mid-flush.
        req.on('data', () => {});
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (bailed) return;
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep raw
      }
      const matched = matchFilter(body, filter);
      onEvent({
        t: new Date().toISOString(),
        remote: `${req.socket.remoteAddress ?? ''}:${req.socket.remotePort ?? ''}`,
        path: req.url ?? '/',
        body,
        matched,
      });
      res.statusCode = 204;
      res.end();
    });
  });
  server.listen(port);
  return server;
}

export function registerEventsCommand(program: Command): void {
  const events = program
    .command('events')
    .description('Receive SwitchBot device events — webhook receiver (tail) or MQTT stream (mqtt-tail)');

  events
    .command('tail')
    .description('Run a local HTTP receiver and print incoming webhook events as JSONL')
    .option('--port <n>', `Local port to listen on (default ${DEFAULT_PORT})`, intArg('--port', { min: 1, max: 65535 }), String(DEFAULT_PORT))
    .option('--path <p>', `HTTP path to match (default "${DEFAULT_PATH}"; use "*" for all paths)`, stringArg('--path'), DEFAULT_PATH)
    .option('--filter <expr>', 'Filter events, e.g. "deviceId=ABC123" or "type=Bot" (comma-separated)', stringArg('--filter'))
    .option('--max <n>', 'Stop after N matching events (default: run until Ctrl-C)', intArg('--max', { min: 1 }))
    .option('--for <dur>', 'Stop after elapsed time (e.g. "5m", "30s"). Combines with --max: first limit wins.', durationArg('--for'))
    .addHelpText(
      'after',
      `
SwitchBot posts events to a single webhook URL configured via:
  $ switchbot webhook setup https://<your-public-host>/<path>

'events tail' only runs the LOCAL receiver — it does not tunnel. Expose
the port to the internet yourself (ngrok/cloudflared/reverse proxy) and
point the SwitchBot webhook at that public URL.

Output (JSONL, one event per line):
  { "t": "<ISO>", "remote": "<ip:port>", "path": "/",
    "body": <parsed JSON or raw string>, "matched": true }

Filter grammar: comma-separated "key=value" pairs. Supported keys:
  deviceId=<id>    match by context.deviceMac / context.deviceId
  type=<type>      match by context.deviceType (e.g. "Bot", "WoMeter")

Examples:
  $ switchbot events tail --port 3000
  $ switchbot events tail --port 3000 --filter deviceId=ABC123
  $ switchbot events tail --filter 'type=WoMeter' --max 5 --json
`,
    )
    .action(async (options: { port: string; path: string; filter?: string; max?: string; for?: string }) => {
      try {
        const port = Number(options.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new UsageError(`Invalid --port "${options.port}". Must be 1..65535.`);
        }
        const maxMatched: number | null = options.max !== undefined ? Number(options.max) : null;
        if (maxMatched !== null && (!Number.isFinite(maxMatched) || maxMatched < 1)) {
          throw new UsageError(`Invalid --max "${options.max}". Must be a positive integer.`);
        }
        const forMs = options.for ? parseDurationToMs(options.for) : null;
        const filter = parseFilter(options.filter);

        let matchedCount = 0;
        const ac = new AbortController();
        const forTimer = forMs !== null && forMs > 0
          ? setTimeout(() => ac.abort(), forMs)
          : null;
        await new Promise<void>((resolve, reject) => {
          let server: http.Server | null = null;
          try {
            server = startReceiver(port, options.path, filter, (ev) => {
              if (!ev.matched) return;
              matchedCount++;
              if (isJsonMode()) {
                printJson(ev);
              } else {
                const when = new Date(ev.t).toLocaleTimeString();
                console.log(`[${when}] ${ev.remote} ${ev.path} ${JSON.stringify(ev.body)}`);
              }
              if (maxMatched !== null && matchedCount >= maxMatched) {
                ac.abort();
              }
            });
            server.on('error', (err) => reject(err));
          } catch (err) {
            reject(err);
            return;
          }

          const startMsg = `Listening on http://127.0.0.1:${port}${options.path} (Ctrl-C to stop)`;
          if (!isJsonMode()) console.error(startMsg);

          const cleanup = () => {
            if (forTimer) clearTimeout(forTimer);
            server?.close();
            resolve();
          };
          process.once('SIGINT', cleanup);
          process.once('SIGTERM', cleanup);
          ac.signal.addEventListener('abort', cleanup, { once: true });
        });
      } catch (error) {
        handleError(error);
      }
    });

  events
    .command('mqtt-tail')
    .description('Subscribe to SwitchBot MQTT shadow events and stream them as JSONL')
    .option('--topic <pattern>', 'MQTT topic filter (default: SwitchBot shadow topic from credential)', stringArg('--topic'))
    .option('--max <n>', 'Stop after N events (default: run until Ctrl-C)', intArg('--max', { min: 1 }))
    .option('--for <dur>', 'Stop after elapsed time (e.g. "5m", "30s"). Combines with --max: first limit wins.', durationArg('--for'))
    .option(
      '--sink <type>',
      'Output sink: stdout (default), file, webhook, openclaw, telegram, homeassistant (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--sink-file <path>', 'File path for file sink', stringArg('--sink-file'))
    .option('--webhook-url <url>', 'Webhook URL for webhook sink', stringArg('--webhook-url'))
    .option('--openclaw-url <url>', 'OpenClaw gateway URL (default: http://localhost:18789)', stringArg('--openclaw-url'))
    .option('--openclaw-token <token>', 'Bearer token for OpenClaw (or env OPENCLAW_TOKEN)', stringArg('--openclaw-token'))
    .option('--openclaw-model <id>', 'OpenClaw agent model ID to route events to', stringArg('--openclaw-model'))
    .option('--telegram-token <token>', 'Telegram bot token (or env TELEGRAM_TOKEN)', stringArg('--telegram-token'))
    .option('--telegram-chat <id>', 'Telegram chat/channel ID to send messages to', stringArg('--telegram-chat'))
    .option('--ha-url <url>', 'Home Assistant base URL (e.g. http://homeassistant.local:8123)', stringArg('--ha-url'))
    .option('--ha-token <token>', 'HA long-lived access token (for REST event API)', stringArg('--ha-token'))
    .option('--ha-webhook-id <id>', 'HA webhook ID (no auth; takes priority over --ha-token)', stringArg('--ha-webhook-id'))
    .option('--ha-event-type <type>', 'HA event type for REST API (default: switchbot_event)', stringArg('--ha-event-type'))
    .addHelpText(
      'after',
      `
Connects to the SwitchBot MQTT service using your existing credentials
(SWITCHBOT_TOKEN + SWITCHBOT_SECRET or ~/.switchbot/config.json).
No additional MQTT configuration required.

Output (JSONL, one event per line):
  { "t": "<ISO>", "eventId": "<uuid>", "topic": "<mqtt-topic>", "payload": <parsed JSON or raw string> }

Control records (interleaved, no "payload" field — use type-prefix to filter):
  { "type": "__session_start", "at": "<ISO>", "eventId": "<uuid>", "state": "connecting" }  before credential fetch (JSON mode only)
  { "type": "__connect",     "at": "<ISO>", "eventId": "<uuid>" }   first successful connect
  { "type": "__reconnect",   "at": "<ISO>", "eventId": "<uuid>" }   connect after a disconnect
  { "type": "__disconnect",  "at": "<ISO>", "eventId": "<uuid>" }   reconnecting or failed

Reconnect policy: the MQTT client retries with exponential backoff
(1s → 30s capped, forever) while the credential is still valid; if the
credential is rejected or 5 consecutive reconnects fail, state goes to
'failed' and the command exits non-zero so supervisors can restart it.
QoS is 0 (at-most-once); agents requiring at-least-once delivery should
fan-out via --sink file and deduplicate by eventId on the consumer side.

Sink types (--sink, repeatable):
  stdout             Print JSONL to stdout (default when no --sink given)
  file               Append JSONL to --sink-file <path>
  webhook            HTTP POST to --webhook-url <url>
  openclaw           POST to OpenClaw via --openclaw-url / --openclaw-token / --openclaw-model
  telegram           Send to Telegram via --telegram-token / --telegram-chat
  homeassistant      POST to HA via --ha-url + --ha-webhook-id (or --ha-token)

Device state is also persisted to ~/.switchbot/device-history/<deviceId>.json
regardless of sink configuration.

Examples:
  $ switchbot events mqtt-tail
  $ switchbot events mqtt-tail --max 10 --json
  $ switchbot events mqtt-tail --sink file --sink-file ~/.switchbot/events.jsonl
  $ switchbot events mqtt-tail --sink openclaw --openclaw-token abc --openclaw-model home-agent
  $ switchbot events mqtt-tail --sink telegram --telegram-token <token> --telegram-chat <chatId>
  $ switchbot events mqtt-tail --sink homeassistant --ha-url http://ha.local:8123 --ha-webhook-id switchbot
  $ switchbot events mqtt-tail --sink stdout --sink openclaw --openclaw-token abc --openclaw-model home
`,
    )
    .action(async (options: {
      topic?: string;
      max?: string;
      for?: string;
      sink: string[];
      sinkFile?: string;
      webhookUrl?: string;
      openclawUrl?: string;
      openclawToken?: string;
      openclawModel?: string;
      telegramToken?: string;
      telegramChat?: string;
      haUrl?: string;
      haToken?: string;
      haWebhookId?: string;
      haEventType?: string;
    }) => {
      try {
        const maxEvents: number | null = options.max !== undefined ? Number(options.max) : null;
        if (maxEvents !== null && (!Number.isInteger(maxEvents) || maxEvents < 1)) {
          throw new UsageError(`Invalid --max "${options.max}". Must be a positive integer.`);
        }
        const forMs = options.for ? parseDurationToMs(options.for) : null;

        const loaded = tryLoadConfig();
        if (!loaded) {
          throw new UsageError(
            'No credentials found. Run \'switchbot config set-token\' or set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.',
          );
        }

        const sinkTypes = options.sink;
        let dispatcher: SinkDispatcher | null = null;

        if (sinkTypes.length > 0) {
          const sinks = sinkTypes.map((type) => {
            switch (type) {
              case 'stdout':
                return new StdoutSink();
              case 'file': {
                if (!options.sinkFile) throw new UsageError('--sink file requires --sink-file <path>');
                return new FileSink(options.sinkFile);
              }
              case 'webhook': {
                if (!options.webhookUrl) throw new UsageError('--sink webhook requires --webhook-url <url>');
                return new WebhookSink(options.webhookUrl);
              }
              case 'openclaw': {
                const token = options.openclawToken ?? process.env.OPENCLAW_TOKEN;
                if (!token) throw new UsageError('--sink openclaw requires --openclaw-token or env OPENCLAW_TOKEN');
                if (!options.openclawModel) throw new UsageError('--sink openclaw requires --openclaw-model <id>');
                return new OpenClawSink({ url: options.openclawUrl, token, model: options.openclawModel });
              }
              case 'telegram': {
                const token = options.telegramToken ?? process.env.TELEGRAM_TOKEN;
                if (!token) throw new UsageError('--sink telegram requires --telegram-token or env TELEGRAM_TOKEN');
                if (!options.telegramChat) throw new UsageError('--sink telegram requires --telegram-chat <id>');
                return new TelegramSink({ token, chatId: options.telegramChat });
              }
              case 'homeassistant': {
                if (!options.haUrl) throw new UsageError('--sink homeassistant requires --ha-url <url>');
                if (!options.haWebhookId && !options.haToken) {
                  throw new UsageError('--sink homeassistant requires --ha-webhook-id or --ha-token');
                }
                return new HomeAssistantSink({
                  url: options.haUrl,
                  token: options.haToken,
                  webhookId: options.haWebhookId,
                  eventType: options.haEventType,
                });
              }
              default:
                throw new UsageError(`Unknown --sink type "${type}". Supported: stdout, file, webhook, openclaw, telegram, homeassistant`);
            }
          });
          dispatcher = new SinkDispatcher(sinks);
        }

        if (!isJsonMode()) {
          console.error('Fetching MQTT credentials from SwitchBot service…');
        }
        // Emit a __session_start envelope immediately (before any credential
        // fetch) so JSON consumers can distinguish "connecting" from "never
        // connected" even when mqtt-tail exits before the broker connects.
        if (isJsonMode()) {
          printJson({
            type: '__session_start',
            at: new Date().toISOString(),
            eventId: crypto.randomUUID(),
            state: 'connecting',
          });
        }
        const credential = await fetchMqttCredential(loaded.token, loaded.secret);
        const topic = options.topic ?? credential.topics.status;

        let eventCount = 0;
        const ac = new AbortController();
        const forTimer = forMs !== null && forMs > 0
          ? setTimeout(() => ac.abort(), forMs)
          : null;
        const client = new SwitchBotMqttClient(
          credential,
          () => fetchMqttCredential(loaded.token, loaded.secret),
        );

        const unsub = client.onMessage((msgTopic, payload) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(payload.toString('utf-8'));
          } catch {
            parsed = payload.toString('utf-8');
          }

          const t = new Date().toISOString();
          // Every event carries an eventId so downstream sinks / replay tools
          // can dedupe. If the broker supplied one (some providers do via a
          // header), prefer that; otherwise synth a UUID locally.
          const existingId = extractEventId(parsed);
          const eventId = existingId ?? crypto.randomUUID();

          if (dispatcher) {
            const { deviceId, deviceType, text } = parseSinkEvent(parsed);
            const sinkEvent: MqttSinkEvent = { t, topic: msgTopic, deviceId, deviceType, payload: parsed, text, eventId };
            deviceHistoryStore.record(deviceId, msgTopic, deviceType, parsed, t);
            dispatcher.dispatch(sinkEvent).catch(() => {});
          } else {
            // Default behavior: record history + print to stdout
            const { deviceId, deviceType } = parseSinkEvent(parsed);
            deviceHistoryStore.record(deviceId, msgTopic, deviceType, parsed, t);
            const record = { t, eventId, topic: msgTopic, payload: parsed };
            if (isJsonMode()) {
              printJson(record);
            } else {
              console.log(JSON.stringify(record));
            }
          }

          eventCount++;
          if (maxEvents !== null && eventCount >= maxEvents) {
            ac.abort();
          }
        });

        let mqttFailed = false;
        let hasConnectedBefore = false;
        const emitControl = (kind: '__connect' | '__reconnect' | '__disconnect' | '__heartbeat'): void => {
          const ctl = { type: kind, at: new Date().toISOString(), eventId: crypto.randomUUID() };
          // Control events always go to stdout as JSONL so consumers that
          // filter real events by presence of `payload` can skip them.
          if (isJsonMode()) {
            printJson(ctl);
          } else {
            console.log(JSON.stringify(ctl));
          }
          // Persist to __control.jsonl — best-effort, never blocks the stream.
          try {
            deviceHistoryStore.recordControl(ctl);
          } catch {
            // swallow
          }
        };
        const unsubState = client.onStateChange((state) => {
          if (!isJsonMode()) {
            console.error(`[${new Date().toLocaleTimeString()}] MQTT state: ${state}`);
          }
          if (state === 'connected') {
            emitControl(hasConnectedBefore ? '__reconnect' : '__connect');
            hasConnectedBefore = true;
          } else if (state === 'reconnecting') {
            emitControl('__disconnect');
          } else if (state === 'failed') {
            mqttFailed = true;
            emitControl('__disconnect');
            if (!isJsonMode()) {
              console.error(
                'MQTT connection failed permanently (credential expired or reconnect exhausted) — exiting.',
              );
            }
            ac.abort();
          }
        });

        await client.connect();
        client.subscribe(topic);

        if (!isJsonMode()) {
          console.error(`Connected to ${credential.brokerUrl} (Ctrl-C to stop)`);
        }

        await new Promise<void>((resolve) => {
          const cleanup = () => {
            if (forTimer) clearTimeout(forTimer);
            process.removeListener('SIGINT', cleanup);
            process.removeListener('SIGTERM', cleanup);
            unsub();
            unsubState();
            dispatcher?.close().catch(() => {});
            client.disconnect().then(resolve).catch(resolve);
          };
          process.once('SIGINT', cleanup);
          process.once('SIGTERM', cleanup);
          ac.signal.addEventListener('abort', cleanup, { once: true });
        });

        if (mqttFailed) {
          // Surface as a runtime error so supervisors (pm2, systemd) can restart.
          process.exit(1);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
