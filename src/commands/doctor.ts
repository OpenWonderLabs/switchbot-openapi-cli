import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printJson, isJsonMode } from '../utils/output.js';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { configFilePath, listProfiles, readProfileMeta } from '../config.js';
import { describeCache } from '../devices/cache.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string | Record<string, unknown>;
}

export const DOCTOR_SCHEMA_VERSION = 1;

async function checkCredentials(): Promise<Check> {
  const envOk = Boolean(process.env.SWITCHBOT_TOKEN && process.env.SWITCHBOT_SECRET);
  if (envOk) return { name: 'credentials', status: 'ok', detail: 'env: SWITCHBOT_TOKEN + SWITCHBOT_SECRET' };
  const file = configFilePath();
  if (!fs.existsSync(file)) {
    return {
      name: 'credentials',
      status: 'fail',
      detail: `No env vars and no config at ${file}. Run 'switchbot config set-token'.`,
    };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg.token || !cfg.secret) {
      return { name: 'credentials', status: 'fail', detail: `Config ${file} missing token/secret.` };
    }
    return { name: 'credentials', status: 'ok', detail: `file: ${file}` };
  } catch (err) {
    return {
      name: 'credentials',
      status: 'fail',
      detail: `Unreadable config ${file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function checkProfiles(): Check {
  const dir = path.join(os.homedir(), '.switchbot', 'profiles');
  if (!fs.existsSync(dir)) {
    return { name: 'profiles', status: 'ok', detail: 'no profile dir (default profile only)' };
  }
  const profiles = listProfiles();
  if (profiles.length === 0) {
    return { name: 'profiles', status: 'ok', detail: 'profile dir empty' };
  }
  const labelled = profiles.map((p) => {
    const meta = readProfileMeta(p);
    if (meta?.label) return `${p} (${meta.label})`;
    return p;
  });
  return {
    name: 'profiles',
    status: 'ok',
    detail: `found ${profiles.length}: ${labelled.join(', ')}`,
  };
}

async function checkClockSkew(): Promise<Check> {
  // Real probe: HEAD the SwitchBot API endpoint and compare the server's Date
  // header against local time. No auth required for the Date header — the API
  // returns 401 but still stamps the response. Gracefully degrades to
  // probeSource:'none' if offline / no network reachable.
  //
  // Under vitest, only run the probe if fetch has been stubbed (detected via
  // vi.fn marker) — otherwise skip network I/O to keep unrelated tests fast.
  const underVitest = Boolean(process.env.VITEST);
  const fetchFn = globalThis.fetch as unknown as { mock?: unknown } | undefined;
  const fetchIsMocked = Boolean(fetchFn && typeof fetchFn === 'function' && 'mock' in fetchFn);
  if (underVitest && !fetchIsMocked) {
    return {
      name: 'clock',
      status: 'warn',
      detail: { probeSource: 'none', skewMs: null, message: 'skipped: test environment' },
    };
  }

  const localBefore = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch('https://api.switch-bot.com/v1.1/devices', {
      method: 'HEAD',
      signal: ctrl.signal,
    });
    const localAfter = Date.now();
    const dateHeader = res.headers.get('date');
    if (!dateHeader) {
      return {
        name: 'clock',
        status: 'warn',
        detail: { probeSource: 'api', skewMs: null, message: 'server returned no Date header' },
      };
    }
    const serverMs = Date.parse(dateHeader);
    if (!Number.isFinite(serverMs)) {
      return {
        name: 'clock',
        status: 'warn',
        detail: { probeSource: 'api', skewMs: null, message: `unparseable Date header: ${dateHeader}` },
      };
    }
    // Split the round-trip in half to estimate the local instant that matches
    // the server's Date header. HTTP Date resolution is 1s, so treat anything
    // under 2000ms as ok, 2000–60000ms as warn, beyond that as fail (HMAC
    // auth rejects requests with skew > 5 minutes anyway).
    const midpoint = (localBefore + localAfter) / 2;
    const skewMs = Math.round(midpoint - serverMs);
    const absSkew = Math.abs(skewMs);
    const status: 'ok' | 'warn' | 'fail' = absSkew < 2000 ? 'ok' : absSkew < 60_000 ? 'warn' : 'fail';
    return {
      name: 'clock',
      status,
      detail: {
        probeSource: 'api',
        skewMs,
        localIso: new Date(midpoint).toISOString(),
        serverIso: new Date(serverMs).toISOString(),
      },
    };
  } catch (err) {
    return {
      name: 'clock',
      status: 'warn',
      detail: {
        probeSource: 'none',
        skewMs: null,
        message: `probe failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkCatalog(): Check {
  const catalog = getEffectiveCatalog();
  const missingRole = catalog.filter((e) => !e.role).length;
  if (catalog.length === 0) {
    return { name: 'catalog', status: 'fail', detail: 'catalog empty — package corrupt?' };
  }
  const status = missingRole > 0 ? 'warn' : 'ok';
  return {
    name: 'catalog',
    status,
    detail: `${catalog.length} types loaded${missingRole > 0 ? `, ${missingRole} missing role` : ''}`,
  };
}

function checkCache(): Check {
  try {
    const info = describeCache();
    const parts: string[] = [];
    parts.push(info.list.exists ? `list: ${info.list.path}` : 'list: (none)');
    parts.push(info.status.exists ? `status: ${info.status.entryCount} entries` : 'status: (none)');
    return { name: 'cache', status: 'ok', detail: parts.join(' | ') };
  } catch (err) {
    return { name: 'cache', status: 'warn', detail: `cache inspect failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function checkQuotaFile(): Check {
  const p = path.join(os.homedir(), '.switchbot', 'quota.json');
  if (!fs.existsSync(p)) {
    return { name: 'quota', status: 'ok', detail: 'no quota file yet (will be created on first call)' };
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    JSON.parse(raw);
    return { name: 'quota', status: 'ok', detail: p };
  } catch {
    return { name: 'quota', status: 'warn', detail: `${p} unreadable/malformed — run 'switchbot quota reset'` };
  }
}

function checkNodeVersion(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 18) {
    return { name: 'node', status: 'fail', detail: `Node ${process.versions.node} — minimum is 18` };
  }
  return { name: 'node', status: 'ok', detail: `Node ${process.versions.node}` };
}

function checkMqtt(): Check {
  // MQTT credentials are auto-provisioned from the SwitchBot API using the
  // account's token+secret — no extra env vars needed. Report availability
  // based on whether REST credentials are configured (no network call).
  const hasEnvCreds = Boolean(process.env.SWITCHBOT_TOKEN && process.env.SWITCHBOT_SECRET);
  if (hasEnvCreds) {
    return {
      name: 'mqtt',
      status: 'ok',
      detail: "auto-provisioned from credentials — run 'switchbot events mqtt-tail' to test live connectivity",
    };
  }
  const file = configFilePath();
  if (fs.existsSync(file)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (cfg.token && cfg.secret) {
        return {
          name: 'mqtt',
          status: 'ok',
          detail: "auto-provisioned from credentials — run 'switchbot events mqtt-tail' to test live connectivity",
        };
      }
    } catch { /* fall through */ }
  }
  return {
    name: 'mqtt',
    status: 'warn',
    detail: "unavailable — configure credentials first (see credentials check above)",
  };
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Self-check: credentials, catalog, cache, quota, profiles, Node version')
    .addHelpText('after', `
Runs a battery of local sanity checks and exits with code 0 only when every
check is 'ok'. 'warn' → exit 0 (informational); 'fail' → exit 1.

Examples:
  $ switchbot doctor
  $ switchbot --json doctor | jq '.checks[] | select(.status != "ok")'
`)
    .action(async () => {
      const checks: Check[] = [
        checkNodeVersion(),
        await checkCredentials(),
        checkProfiles(),
        checkCatalog(),
        checkCache(),
        checkQuotaFile(),
        await checkClockSkew(),
        checkMqtt(),
      ];
      const summary = {
        ok: checks.filter((c) => c.status === 'ok').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      };
      const overallFail = summary.fail > 0;
      const overall: 'ok' | 'warn' | 'fail' = overallFail ? 'fail' : summary.warn > 0 ? 'warn' : 'ok';

      if (isJsonMode()) {
        // Stable contract (locked as doctor.schemaVersion=1):
        //   { ok: boolean, overall: 'ok'|'warn'|'fail', generatedAt, schemaVersion,
        //     summary: { ok, warn, fail }, checks: [{ name, status, detail }] }
        // `ok` is an alias of (overall === 'ok') — agents prefer the boolean,
        // humans prefer the string; both are provided.
        printJson({
          ok: overall === 'ok',
          overall,
          generatedAt: new Date().toISOString(),
          schemaVersion: DOCTOR_SCHEMA_VERSION,
          summary,
          checks,
        });
      } else {
        for (const c of checks) {
          const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
          const detailStr = typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail);
          console.log(`${icon} ${c.name.padEnd(12)} ${detailStr}`);
        }
        console.log('');
        console.log(`${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`);
      }
      if (overallFail) process.exit(1);
    });
}
