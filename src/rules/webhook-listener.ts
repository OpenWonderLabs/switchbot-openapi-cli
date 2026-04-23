/**
 * Local HTTP listener that delivers webhook events to the rules engine.
 *
 * Scope (E2):
 *   - Binds to `127.0.0.1` only — the loopback interface keeps the
 *     listener off the network by default. The plan's integration story
 *     is that an agent or local script POSTs to this endpoint.
 *   - Default port is 18790 (phase-3 design doc choice); override with
 *     `--webhook-port <n>` in `switchbot rules run`. `--webhook-port 0`
 *     asks the OS for an ephemeral port — useful in tests.
 *   - Bearer-token auth on every request: `Authorization: Bearer <t>`.
 *     The expected token comes from `WebhookTokenStore`; unauthorized
 *     requests get a 401 with no body, no hint about which header
 *     failed, and an audit entry (`rule-webhook-rejected`).
 *   - Matches request path against registered webhook rules: only
 *     `POST /path/exactly/as/declared`. Unknown paths return 404.
 *
 * Non-goals:
 *   - No TLS; operators who expose this outside loopback are expected
 *     to sit behind a reverse proxy that terminates TLS.
 *   - No payload parsing beyond reading the body as a string — the
 *     engine passes the raw body through in the event payload.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { EngineEvent, Rule } from './types.js';
import { writeAudit } from '../utils/audit.js';
import { isWebhookTrigger } from './types.js';

export const DEFAULT_WEBHOOK_PORT = 18790;
const MAX_BODY_BYTES = 16 * 1024; // guard against huge POSTs from misbehaving callers

export interface WebhookDispatch {
  (rule: Rule, event: EngineEvent): Promise<void>;
}

export interface WebhookListenerOptions {
  rules: Rule[];
  /** Bearer token used to authorize incoming requests. */
  bearerToken: string;
  /**
   * Host interface to bind. Defaults to 127.0.0.1; tests can set this
   * to '127.0.0.1' + port 0 for ephemeral allocation.
   */
  host?: string;
  port?: number;
  dispatch: WebhookDispatch;
  /** Optional clock — tests inject a deterministic value. */
  now?: () => Date;
}

export class WebhookListener {
  private readonly opts: WebhookListenerOptions;
  private server: Server | null = null;
  private readonly pathIndex = new Map<string, Rule>();
  private actualPort: number | null = null;

  constructor(opts: WebhookListenerOptions) {
    this.opts = opts;
    for (const rule of opts.rules) {
      if (!isWebhookTrigger(rule.when)) continue;
      const normalised = normalisePath(rule.when.path);
      if (this.pathIndex.has(normalised)) {
        throw new Error(
          `WebhookListener: duplicate webhook path "${normalised}" — every webhook rule needs a unique path`,
        );
      }
      this.pathIndex.set(normalised, rule);
    }
  }

  /** Start listening. Resolves once the server has bound a port. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        // The dispatch chain should never reject — but if it does,
        // make sure we close the socket so the caller doesn't hang.
        if (!res.headersSent) {
          res.writeHead(500);
          res.end();
        }
        // eslint-disable-next-line no-console
        console.error(`webhook-listener: unhandled dispatch error: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
    const host = this.opts.host ?? '127.0.0.1';
    const port = this.opts.port ?? DEFAULT_WEBHOOK_PORT;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const address = server.address();
    this.actualPort = typeof address === 'object' && address ? address.port : port;
    this.server = server;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.actualPort = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  getPort(): number | null {
    return this.actualPort;
  }

  listPaths(): string[] {
    return [...this.pathIndex.keys()].sort();
  }

  /**
   * Replace the current rule → path index. Used by `engine.reload`: the
   * listener keeps its open port and accepted connections, but routes
   * subsequent requests against the fresh policy.
   */
  updateRules(rules: Rule[]): void {
    const next = new Map<string, Rule>();
    for (const rule of rules) {
      if (!isWebhookTrigger(rule.when)) continue;
      const normalised = normalisePath(rule.when.path);
      if (next.has(normalised)) {
        throw new Error(
          `WebhookListener.updateRules: duplicate webhook path "${normalised}"`,
        );
      }
      next.set(normalised, rule);
    }
    this.pathIndex.clear();
    for (const [k, v] of next) this.pathIndex.set(k, v);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth gate first — reject everything else so a wrong token never
    // reveals which paths exist.
    if (!this.isAuthorized(req)) {
      writeAudit({
        t: this.now().toISOString(),
        kind: 'rule-webhook-rejected',
        deviceId: 'unknown',
        command: req.url ?? '',
        parameter: null,
        commandType: 'command',
        dryRun: true,
        result: 'error',
        error: 'unauthorized',
      });
      res.writeHead(401);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    const reqUrl = req.url ?? '/';
    const questionMarkIdx = reqUrl.indexOf('?');
    const rawPath = questionMarkIdx === -1 ? reqUrl : reqUrl.slice(0, questionMarkIdx);
    const normalised = normalisePath(rawPath);
    const rule = this.pathIndex.get(normalised);
    if (!rule) {
      writeAudit({
        t: this.now().toISOString(),
        kind: 'rule-webhook-rejected',
        deviceId: 'unknown',
        command: rawPath,
        parameter: null,
        commandType: 'command',
        dryRun: true,
        result: 'error',
        error: 'unknown-path',
      });
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await readLimitedBody(req, MAX_BODY_BYTES);
    if (body === null) {
      res.writeHead(413);
      res.end();
      return;
    }

    const event: EngineEvent = {
      source: 'webhook',
      event: normalised,
      t: this.now(),
      payload: { path: normalised, body },
    };
    // Accept the request before dispatch so callers aren't held waiting
    // on rule actions (which can include SwitchBot API calls).
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted', path: normalised }));
    this.opts.dispatch(rule, event).catch(() => undefined);
  }

  private isAuthorized(req: IncomingMessage): boolean {
    const h = req.headers['authorization'];
    if (typeof h !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (!match) return false;
    const provided = Buffer.from(match[1].trim(), 'utf-8');
    const expected = Buffer.from(this.opts.bearerToken, 'utf-8');
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }
}

function normalisePath(p: string): string {
  if (!p) return '/';
  let out = p.trim();
  if (!out.startsWith('/')) out = `/${out}`;
  // Collapse a trailing slash (but leave the root '/').
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

function readLimitedBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > max) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}
