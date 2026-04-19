import { Command } from 'commander';
import http from 'node:http';
import { printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { parseEventStreamFilter, matchShadowEventFilter } from '../utils/filter.js';
import { loadConfig } from '../config.js';
import { MqttTlsClient } from '../mqtt/client.js';
import { getCredential } from '../mqtt/credential.js';
import type { DeviceShadowEvent } from '../mqtt/types.js';

const DEFAULT_PORT = 3000;
const DEFAULT_PATH = '/';
const MAX_BODY_BYTES = 1_000_000;

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
    .description('Subscribe to local webhook events forwarded by SwitchBot');

  events
    .command('tail')
    .description('Run a local HTTP receiver and print incoming webhook events as JSONL')
    .option('--port <n>', `Local port to listen on (default ${DEFAULT_PORT})`, String(DEFAULT_PORT))
    .option('--path <p>', `HTTP path to match (default "${DEFAULT_PATH}"; use "*" for all paths)`, DEFAULT_PATH)
    .option('--filter <expr>', 'Filter events, e.g. "deviceId=ABC123" or "type=Bot" (comma-separated)')
    .option('--max <n>', 'Stop after N matching events (default: run until Ctrl-C)')
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
    .action(async (options: { port: string; path: string; filter?: string; max?: string }) => {
      try {
        const port = Number(options.port);
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new UsageError(`Invalid --port "${options.port}". Must be 1..65535.`);
        }
        const maxMatched: number | null = options.max !== undefined ? Number(options.max) : null;
        if (maxMatched !== null && (!Number.isFinite(maxMatched) || maxMatched < 1)) {
          throw new UsageError(`Invalid --max "${options.max}". Must be a positive integer.`);
        }
        const filter = parseFilter(options.filter);

        let matchedCount = 0;
        const ac = new AbortController();
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
    .command('stream')
    .description('Subscribe to MQTT shadow updates for real-time device state changes')
    .option('--filter <expr>', 'Filter events, e.g. "deviceId=ABC123" or "type=Motion\ Sensor"')
    .option('--max <n>', 'Stop after N matching events (default: run until Ctrl-C)')
    .option('--probe', 'Verify broker connectivity and exit (does not stream events)')
    .option('--no-cache', 'Fetch fresh credentials instead of using cached credential')
    .addHelpText(
      'after',
      `
'events stream' connects to SwitchBot's MQTT broker over TLS and subscribes to device shadow updates.
This feature depends on the SwitchBot IoT MQTT service, which is not part of the official OpenAPI.
If SwitchBot's policy changes, this service may become unavailable; fall back to 'devices status' polling.

Credentials are cached in ~/.switchbot/mqtt-credential.json with a 1-hour TTL.

Output (JSONL, one event per line):
  { "ts": "<ISO>", "deviceId": "<id>", "deviceType": "<type>", "payload": {...} }

Filter grammar: comma-separated "key=value" pairs. Supported keys:
  deviceId=<id>    match by device ID
  type=<type>      match by device type (e.g. "Motion Sensor", "Contact Sensor")

Examples:
  $ switchbot events stream
  $ switchbot events stream --filter type="Motion Sensor"
  $ switchbot events stream --filter deviceId=ABC123 --max 10
  $ switchbot events stream --probe   # connectivity check, no streaming
`,
    )
    .action(async (options: { filter?: string; max?: string; probe?: boolean; cache?: boolean }) => {
      try {
        const config = loadConfig();
        const maxMatched: number | null = options.max !== undefined ? Number(options.max) : null;
        if (maxMatched !== null && (!Number.isFinite(maxMatched) || maxMatched < 1)) {
          throw new UsageError(`Invalid --max "${options.max}". Must be a positive integer.`);
        }
        const filter = parseEventStreamFilter(options.filter);

        const ac = new AbortController();
        let matchedCount = 0;

        await new Promise<void>((resolve, reject) => {
          (async () => {
            try {
              const credential = await getCredential(config.token, config.secret, !options.cache);
              const mqttClient = new MqttTlsClient();
              mqttClient.setAbortSignal(ac.signal);

              await mqttClient.connect(credential);

              if (!isJsonMode()) {
                const brokerHost = new URL(credential.brokerUrl).hostname || credential.brokerUrl;
                console.error(`[mqtt] connected to ${brokerHost}`);
                console.error(`[mqtt] subscribed to ${credential.topics.length} topics`);
              }

              if (options.probe) {
                await mqttClient.end();
                return resolve();
              }

              mqttClient.on('message', ((topic: string, payload: Buffer) => {
                try {
                  const message = JSON.parse(payload.toString('utf-8'));
                  const event = extractShadowEvent(message);
                  if (!event) return;
                  if (!matchShadowEventFilter(event, filter)) return;

                  matchedCount++;
                  if (isJsonMode()) {
                    printJson(event);
                  } else {
                    const when = new Date(event.ts).toLocaleTimeString();
                    const payloadStr = JSON.stringify(event.payload);
                    console.error(`[mqtt] ${when}  ${event.deviceId} (${event.deviceType})  ${payloadStr}`);
                  }

                  if (maxMatched !== null && matchedCount >= maxMatched) {
                    ac.abort();
                  }
                } catch {
                  // Silently skip unparseable events
                }
              }) as (...args: unknown[]) => void);

              mqttClient.onRuntimeError((err) => {
                reject(err);
                ac.abort();
              });

              await mqttClient.subscribeAll(credential.topics);

              const cleanup = () => {
                mqttClient.end().then(resolve).catch(reject);
              };
              process.once('SIGINT', cleanup);
              process.once('SIGTERM', cleanup);
              ac.signal.addEventListener('abort', cleanup, { once: true });
            } catch (err) {
              reject(err);
            }
          })();
        });
      } catch (error) {
        handleError(error);
      }
    });
}

export function extractShadowEvent(message: unknown): DeviceShadowEvent | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;

  const state = m.state as Record<string, unknown> | undefined;
  if (!state) return null;

  const deviceId = (m.clientId as string) || (state.deviceId as string);
  const deviceType = (state.deviceType as string) || 'Unknown';

  if (!deviceId) return null;

  return {
    ts: new Date().toISOString(),
    deviceId,
    deviceType,
    payload: state,
  };
}
