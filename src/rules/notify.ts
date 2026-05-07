import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { writeAudit } from '../utils/audit.js';
import type { NotifyAction, Rule } from './types.js';

export interface NotifyContext {
  rule: Rule;
  fireId: string;
  eventPayload?: unknown;
  deviceId?: string;
  globalDryRun?: boolean;
}

export interface NotifyResult {
  ok: boolean;
  channel: string;
  latencyMs: number;
  dryRun?: boolean;
  error?: string;
}

export function renderNotifyTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const val = vars[key];
    return val !== undefined ? String(val) : `{{ ${key} }}`;
  });
}

function flattenForTemplate(prefix: string, value: unknown, out: Record<string, unknown>, depth = 0): void {
  if (depth > 6) return;
  if (value === null) {
    out[prefix] = null;
    return;
  }
  if (value instanceof Date) {
    out[prefix] = value.toISOString();
    return;
  }
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') {
    out[prefix] = value;
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      flattenForTemplate(`${prefix}.${i}`, value[i], out, depth + 1);
    }
    return;
  }
  if (t === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenForTemplate(`${prefix}.${k}`, v, out, depth + 1);
    }
  }
  // undefined / function / symbol / bigint — skip silently
}

function buildTemplateVars(action: NotifyAction, ctx: NotifyContext): Record<string, unknown> {
  const vars: Record<string, unknown> = {
    'rule.name': ctx.rule.name,
    'rule.fired_at': new Date().toISOString(),
    'device.id': ctx.deviceId ?? '',
    'action.channel': action.channel,
    'action.to': action.to,
    'fireId': ctx.fireId,
  };
  if (ctx.eventPayload !== undefined && ctx.eventPayload !== null) {
    flattenForTemplate('event', ctx.eventPayload, vars);
  }
  return vars;
}

function buildDefaultBody(action: NotifyAction, ctx: NotifyContext): string {
  return JSON.stringify({
    rule: ctx.rule.name,
    fireId: ctx.fireId,
    deviceId: ctx.deviceId,
    channel: action.channel,
    firedAt: new Date().toISOString(),
    payload: ctx.eventPayload,
  });
}

async function sendWebhook(url: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`invalid URL: ${url}`));
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      reject(new Error(`unsupported protocol "${parsed.protocol}" — only http: and https: are allowed`));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'switchbot-cli/notify',
      },
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      if (status >= 200 && status < 300) {
        resolve();
      } else {
        reject(new Error(`HTTP ${status}`));
      }
    });

    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('webhook request timed out'));
    });
    req.write(body);
    req.end();
  });
}

function appendToFile(filePath: string, body: string): void {
  if (!path.isAbsolute(filePath)) {
    throw new Error(
      `notify file path must be absolute, got "${filePath}" — use e.g. /var/log/switchbot/notify.jsonl on POSIX or C:\\path\\notify.jsonl on Windows. Tilde (~) is not expanded.`,
    );
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, body + '\n', 'utf-8');
}

export async function executeNotifyAction(
  action: NotifyAction,
  ctx: NotifyContext,
): Promise<NotifyResult> {
  const dryRun = ctx.globalDryRun === true || ctx.rule.dry_run === true;
  const start = Date.now();
  const vars = buildTemplateVars(action, ctx);
  const body = action.template
    ? renderNotifyTemplate(action.template, vars)
    : buildDefaultBody(action, ctx);

  if (dryRun) {
    const latencyMs = Date.now() - start;
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-notify',
      deviceId: ctx.deviceId ?? '',
      command: `notify:${action.channel}`,
      parameter: action.to,
      commandType: 'command',
      dryRun: true,
      result: 'ok',
      notifyChannel: action.channel,
      notifyLatencyMs: latencyMs,
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        fireId: ctx.fireId,
      },
    });
    return { ok: true, channel: action.channel, latencyMs, dryRun: true };
  }

  let error: string | undefined;
  try {
    if (action.channel === 'webhook' || action.channel === 'openclaw') {
      await sendWebhook(action.to, body);
    } else {
      appendToFile(action.to, body);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    if ((action.on_failure ?? 'log') === 'retry') {
      await new Promise<void>(r => setTimeout(r, 1000));
      try {
        if (action.channel === 'webhook' || action.channel === 'openclaw') {
          await sendWebhook(action.to, body);
        } else {
          appendToFile(action.to, body);
        }
        error = undefined;
      } catch (err2) {
        error = err2 instanceof Error ? err2.message : String(err2);
      }
    }
  }

  const latencyMs = Date.now() - start;
  const ok = error === undefined;

  // `parameter` carries the raw `action.to` even when the path was rejected
  // as relative — keeping the unsanitised value is intentional for forensics
  // (operators need to see what bad input slipped past lint).
  writeAudit({
    t: new Date().toISOString(),
    kind: 'rule-notify',
    deviceId: ctx.deviceId ?? '',
    command: `notify:${action.channel}`,
    parameter: action.to,
    commandType: 'command',
    dryRun: false,
    result: ok ? 'ok' : 'error',
    error,
    notifyChannel: action.channel,
    notifyLatencyMs: latencyMs,
    rule: {
      name: ctx.rule.name,
      triggerSource: ctx.rule.when.source,
      fireId: ctx.fireId,
    },
  });

  return { ok, channel: action.channel, latencyMs, dryRun: false, error };
}
