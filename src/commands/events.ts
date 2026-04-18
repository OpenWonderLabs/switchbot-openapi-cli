import { Command } from 'commander';
import http from 'node:http';
import { printJson, isJsonMode } from '../utils/output.js';

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
  const out: { deviceId?: string; type?: string } = {};
  for (const pair of flag.split(',')) {
    const [k, v] = pair.split('=').map((s) => s.trim());
    if (!k || !v) continue;
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
      const port = Number(options.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        console.error(`Invalid --port "${options.port}". Must be 1..65535.`);
        process.exit(2);
      }
      const maxMatched: number | null = options.max !== undefined ? Number(options.max) : null;
      if (maxMatched !== null && (!Number.isFinite(maxMatched) || maxMatched < 1)) {
        console.error(`Invalid --max "${options.max}". Must be a positive integer.`);
        process.exit(2);
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
    });
}
