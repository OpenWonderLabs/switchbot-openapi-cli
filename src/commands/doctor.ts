import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { printJson, isJsonMode } from '../utils/output.js';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { configFilePath, listProfiles } from '../config.js';
import { describeCache } from '../devices/cache.js';
import { getMqttConfig } from '../mqtt/credential.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

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
  return {
    name: 'profiles',
    status: 'ok',
    detail: profiles.length ? `found ${profiles.length}: ${profiles.join(', ')}` : 'profile dir empty',
  };
}

function checkClockSkew(): Check {
  const now = Date.now();
  const drift = now - Math.floor(now / 1000) * 1000;
  // HMAC signing uses ms timestamps — we can't detect remote skew without a
  // round-trip, but we can flag if the local clock has NTP issues via the
  // classic "jumps back" pattern. Best-effort: just report local time.
  const iso = new Date().toISOString();
  return { name: 'clock', status: 'ok', detail: `local time ${iso} (drift check needs API round-trip)` };
  void drift;
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
  const cfg = getMqttConfig();
  if (!cfg) {
    return {
      name: 'mqtt',
      status: 'warn',
      detail: "not configured — set SWITCHBOT_MQTT_HOST/USERNAME/PASSWORD to enable real-time events",
    };
  }
  return {
    name: 'mqtt',
    status: 'ok',
    detail: `configured (mqtts://${cfg.host}:${cfg.port}) — credentials not verified; run 'switchbot events mqtt-tail' to test live connectivity`,
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
        checkClockSkew(),
        checkMqtt(),
      ];
      const summary = {
        ok: checks.filter((c) => c.status === 'ok').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      };
      const overallFail = summary.fail > 0;

      if (isJsonMode()) {
        printJson({ overall: overallFail ? 'fail' : summary.warn > 0 ? 'warn' : 'ok', summary, checks });
      } else {
        for (const c of checks) {
          const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
          console.log(`${icon} ${c.name.padEnd(12)} ${c.detail}`);
        }
        console.log('');
        console.log(`${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`);
      }
      if (overallFail) process.exit(1);
    });
}
