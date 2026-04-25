import { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { printJson, isJsonMode, exitWithError } from '../utils/output.js';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { configFilePath, listProfiles, readProfileMeta } from '../config.js';
import { describeCache, resetListCache } from '../devices/cache.js';
import { DAILY_QUOTA, todayUsage } from '../utils/quota.js';
import { AGENT_BOOTSTRAP_SCHEMA_VERSION } from './agent-bootstrap.js';
import { CATALOG_SCHEMA_VERSION } from '../devices/catalog.js';
import { createSwitchBotMcpServer, listRegisteredTools } from './mcp.js';
import {
  resolvePolicyPath,
  loadPolicyFile,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
} from '../policy/load.js';
import { validateLoadedPolicy } from '../policy/validate.js';
import { selectCredentialStore } from '../credentials/keychain.js';
import { getActiveProfile } from '../lib/request-context.js';
import { readDaemonState } from '../lib/daemon-state.js';
import { isPidAlive } from '../rules/pid-file.js';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string | Record<string, unknown>;
}

export const DOCTOR_SCHEMA_VERSION = 1;

async function checkCredentials(): Promise<Check> {
  const envOk = Boolean(process.env.SWITCHBOT_TOKEN && process.env.SWITCHBOT_SECRET);
  const profile = getActiveProfile() ?? 'default';

  let backendName: string = 'file';
  let backendLabel: string = 'file';
  let writable = true;
  let keychainHasProfile = false;
  try {
    const store = await selectCredentialStore();
    const desc = store.describe();
    backendName = store.name;
    backendLabel = desc.backend;
    writable = desc.writable;
    try {
      const creds = await store.get(profile);
      keychainHasProfile = Boolean(creds && creds.token && creds.secret);
    } catch {
      keychainHasProfile = false;
    }
  } catch {
    // selectCredentialStore falls back to file; a throw here is unexpected but
    // non-fatal — downstream callers degrade to the file path.
  }

  if (envOk) {
    return {
      name: 'credentials',
      status: 'ok',
      detail: {
        source: 'env',
        backend: backendName,
        backendLabel,
        writable,
        profile,
        message: 'env: SWITCHBOT_TOKEN + SWITCHBOT_SECRET',
      },
    };
  }

  if (keychainHasProfile && backendName !== 'file') {
    return {
      name: 'credentials',
      status: 'ok',
      detail: {
        source: 'keychain',
        backend: backendName,
        backendLabel,
        writable,
        profile,
        message: `keychain (${backendLabel}) has credentials for profile "${profile}"`,
      },
    };
  }

  const file = configFilePath();
  if (!fs.existsSync(file)) {
    return {
      name: 'credentials',
      status: 'fail',
      detail: {
        source: 'none',
        backend: backendName,
        backendLabel,
        writable,
        profile,
        message: `No env vars, no keychain entry for profile "${profile}", and no config at ${file}. Run 'switchbot config set-token' or 'switchbot auth keychain set'.`,
      },
    };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg.token || !cfg.secret) {
      return {
        name: 'credentials',
        status: 'fail',
        detail: {
          source: 'file',
          backend: backendName,
          backendLabel,
          writable,
          profile,
          message: `Config ${file} missing token/secret.`,
        },
      };
    }
    const status = writable && backendName !== 'file' ? 'warn' : 'ok';
    const hint = status === 'warn'
      ? `Consider running 'switchbot auth keychain migrate' to move credentials into ${backendLabel}.`
      : undefined;
    return {
      name: 'credentials',
      status,
      detail: {
        source: 'file',
        backend: backendName,
        backendLabel,
        writable,
        profile,
        message: `file: ${file}`,
        ...(hint ? { hint } : {}),
      },
    };
  } catch (err) {
    return {
      name: 'credentials',
      status: 'fail',
      detail: {
        source: 'file',
        backend: backendName,
        backendLabel,
        writable,
        profile,
        message: `Unreadable config ${file}: ${err instanceof Error ? err.message : String(err)}`,
      },
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
    return {
      name: 'quota',
      status: 'ok',
      detail: {
        path: p,
        percentUsed: 0,
        remaining: DAILY_QUOTA,
        message: 'no quota file yet (will be created on first call)',
      },
    };
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    JSON.parse(raw);
  } catch {
    return {
      name: 'quota',
      status: 'warn',
      detail: { path: p, message: `unreadable/malformed — run 'switchbot quota reset'` },
    };
  }
  // P9: surface headroom so agents can decide when to slow down or pause.
  // Quota resets at local midnight (the quota counter buckets by local
  // date), so project the next reset to the next 00:00:00 local.
  const usage = todayUsage();
  const percentUsed = Math.round((usage.total / DAILY_QUOTA) * 100);
  const now = new Date();
  const reset = new Date(now);
  reset.setHours(24, 0, 0, 0); // next local midnight
  const status: 'ok' | 'warn' = percentUsed > 80 ? 'warn' : 'ok';
  const recommendation = percentUsed > 90
    ? 'over 90% used — consider --no-quota for read-only triage or rescheduling work after the reset'
    : percentUsed > 80
    ? 'over 80% used — avoid bulk operations until the daily reset'
    : 'headroom available';
  return {
    name: 'quota',
    status,
    detail: {
      path: p,
      percentUsed,
      remaining: usage.remaining,
      total: usage.total,
      dailyCap: DAILY_QUOTA,
      projectedResetTime: reset.toISOString(),
      recommendation,
    },
  };
}

function checkCatalogSchema(): Check {
  // P9: sentinel against silent drift between the catalog shape and the
  // agent-bootstrap payload. Both constants are exported from their
  // respective modules; if a future refactor changes one without the
  // other, this check fails so consumers (agents) learn before the
  // mismatch corrupts their mental model.
  const match = CATALOG_SCHEMA_VERSION === AGENT_BOOTSTRAP_SCHEMA_VERSION;
  return {
    name: 'catalog-schema',
    status: match ? 'ok' : 'fail',
    detail: {
      catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
      bootstrapExpectsVersion: AGENT_BOOTSTRAP_SCHEMA_VERSION,
      match,
      message: match
        ? 'catalog and agent-bootstrap schemaVersion aligned'
        : 'catalog and agent-bootstrap schemaVersion have drifted — bump in lockstep',
    },
  };
}

interface AuditRecord {
  auditVersion?: number;
  t?: string;
  kind?: string;
  deviceId?: string;
  command?: string;
  result?: 'ok' | 'error';
  error?: string;
}

function checkAudit(): Check {
  // P9: surface recent command failures so agents / ops can spot problems
  // before they page. When --audit-log was never enabled, the file won't
  // exist — report that cleanly rather than as an error.
  const p = path.join(os.homedir(), '.switchbot', 'audit.log');
  if (!fs.existsSync(p)) {
    return {
      name: 'audit',
      status: 'ok',
      detail: {
        path: p,
        enabled: false,
        message: 'audit log not present (enable with --audit-log)',
      },
    };
  }
  try {
    const raw = fs.readFileSync(p, 'utf-8');
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const recent: Array<{ t: string; command: string; deviceId?: string; error: string }> = [];
    let total = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: AuditRecord;
      try {
        rec = JSON.parse(trimmed) as AuditRecord;
      } catch {
        continue;
      }
      if (rec.result !== 'error') continue;
      total += 1;
      const ts = rec.t ? Date.parse(rec.t) : NaN;
      if (Number.isFinite(ts) && ts >= since) {
        recent.push({
          t: rec.t as string,
          command: rec.command ?? '?',
          deviceId: rec.deviceId,
          error: rec.error ?? 'unknown',
        });
      }
    }
    // Cap the report to the 10 most recent so the doctor payload stays
    // bounded even on a log with thousands of errors.
    recent.sort((a, b) => (a.t < b.t ? 1 : -1));
    const clipped = recent.slice(0, 10);
    const status: 'ok' | 'warn' = recent.length > 0 ? 'warn' : 'ok';
    return {
      name: 'audit',
      status,
      detail: {
        path: p,
        enabled: true,
        totalErrors: total,
        errorsLast24h: recent.length,
        recent: clipped,
      },
    };
  } catch (err) {
    return {
      name: 'audit',
      status: 'warn',
      detail: {
        path: p,
        enabled: true,
        message: `could not read audit log: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

function checkPolicy(): Check {
  // A policy file is optional — many users run the CLI without one. Report
  // `ok` with `present: false` so agents can tell the difference between
  // "no policy configured" (fine) and "policy broken" (needs attention).
  const policyPath = resolvePolicyPath();
  try {
    const loaded = loadPolicyFile(policyPath);
    const result = validateLoadedPolicy(loaded);
    if (result.valid) {
      return {
        name: 'policy',
        status: 'ok',
        detail: {
          path: policyPath,
          present: true,
          valid: true,
          schemaVersion: result.schemaVersion,
        },
      };
    }
    return {
      name: 'policy',
      status: 'fail',
      detail: {
        path: policyPath,
        present: true,
        valid: false,
        schemaVersion: result.schemaVersion,
        errorCount: result.errors.length,
        firstError: result.errors[0]
          ? {
              path: result.errors[0].path,
              line: result.errors[0].line,
              message: result.errors[0].message,
            }
          : undefined,
        message: "run 'switchbot policy validate' for full diagnostics",
      },
    };
  } catch (err) {
    if (err instanceof PolicyFileNotFoundError) {
      return {
        name: 'policy',
        status: 'ok',
        detail: {
          path: policyPath,
          present: false,
          message: "no policy file (optional — run 'switchbot policy new' to scaffold one)",
        },
      };
    }
    if (err instanceof PolicyYamlParseError) {
      const first = err.yamlErrors[0];
      return {
        name: 'policy',
        status: 'fail',
        detail: {
          path: policyPath,
          present: true,
          valid: false,
          parseError: true,
          line: first?.line,
          col: first?.col,
          message: first?.message ?? err.message,
        },
      };
    }
    return {
      name: 'policy',
      status: 'warn',
      detail: {
        path: policyPath,
        message: `could not read policy file: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

async function checkKeychain(): Promise<Check> {
  try {
    const { selectCredentialStore } = await import('../credentials/keychain.js');
    const store = await selectCredentialStore();
    const desc = store.describe();
    const isNative = desc.backend !== 'file';
    if (!isNative) {
      // Native keychain not available or not detected
      return {
        name: 'keychain',
        status: 'warn',
        detail: {
          backend: desc.backend,
          message: 'OS native keychain not detected — credentials stored in plain file (~/.switchbot/config.json). Consider installing a keychain backend for better security.',
          hint: process.platform === 'linux'
            ? 'Install libsecret (secret-tool) for GNOME Keyring support.'
            : process.platform === 'darwin'
            ? 'macOS Keychain is available — re-run `switchbot config set-token` to store credentials there.'
            : 'Windows Credential Manager is available — re-run `switchbot config set-token` to use it.',
        },
      };
    }
    return {
      name: 'keychain',
      status: 'ok',
      detail: {
        backend: desc.backend,
        writable: desc.writable,
        message: `Credentials stored in OS keychain (${desc.backend}).`,
      },
    };
  } catch (err) {
    return {
      name: 'keychain',
      status: 'warn',
      detail: { message: `Keychain probe failed: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
}

function checkNodeVersion(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isFinite(major) && major < 18) {
    return { name: 'node', status: 'fail', detail: `Node ${process.versions.node} — minimum is 18` };
  }
  return { name: 'node', status: 'ok', detail: `Node ${process.versions.node}` };
}

type ShellFlavor = 'powershell' | 'cmd' | 'bash' | 'zsh' | 'fish' | 'unknown';

function detectShellFlavor(): ShellFlavor {
  const shell = (process.env.SHELL ?? '').toLowerCase();
  const comspec = (process.env.COMSPEC ?? '').toLowerCase();
  if (shell.includes('pwsh') || shell.includes('powershell')) return 'powershell';
  if (comspec.includes('powershell') || comspec.includes('pwsh')) return 'powershell';
  if (comspec.endsWith('cmd.exe')) return 'cmd';
  if (shell.endsWith('/fish') || shell === 'fish') return 'fish';
  if (shell.endsWith('/zsh') || shell === 'zsh') return 'zsh';
  if (shell.endsWith('/bash') || shell === 'bash') return 'bash';
  return process.platform === 'win32' ? 'powershell' : 'unknown';
}

function buildPathFix(shell: ShellFlavor, missingSegment: string | null, npmBinDir: string | null): string {
  if (!npmBinDir) {
    return process.platform === 'win32'
      ? 'Run: npm prefix -g and add that directory to your PATH.'
      : 'Run: npm prefix -g and add <prefix>/bin to your PATH.';
  }
  switch (shell) {
    case 'powershell':
      return `$env:Path = "${missingSegment};" + $env:Path  # persist via your PowerShell profile or System Properties`;
    case 'cmd':
      return `set PATH=${missingSegment};%PATH%  &&  setx PATH "${missingSegment};%PATH%"`;
    case 'fish':
      return `fish_add_path "${missingSegment}"`;
    case 'zsh':
      return `export PATH="${missingSegment}:$PATH"  # add to ~/.zshrc`;
    case 'bash':
      return `export PATH="${missingSegment}:$PATH"  # add to ~/.bashrc`;
    default:
      return `export PATH="${missingSegment}:$PATH"`;
  }
}

function checkPathDiscoverability(): Check {
  // Detect whether the `switchbot` binary is reachable on PATH.
  // This catches the common "npm install -g worked but PATH not updated" failure.
  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'switchbot.cmd' : 'switchbot';

  // Find where npm puts global bins.
  let npmBinDir: string | null = null;
  try {
    const prefix = execSync('npm prefix -g', { timeout: 4000, encoding: 'utf-8' }).trim();
    npmBinDir = isWindows ? prefix : path.join(prefix, 'bin');
  } catch {
    // npm not on PATH or other error; fall through.
  }

  // Check whether `switchbot` resolves via PATH.
  let binaryOnPath = false;
  let resolvedPath: string | null = null;
  try {
    const which = execSync(
      isWindows ? `where ${binaryName}` : `which ${binaryName}`,
      { timeout: 3000, encoding: 'utf-8' },
    ).trim().split(/\r?\n/)[0];
    if (which) {
      binaryOnPath = true;
      resolvedPath = which;
    }
  } catch {
    binaryOnPath = false;
  }

  if (binaryOnPath) {
    return {
      name: 'path',
      status: 'ok',
      detail: {
        binaryOnPath: true,
        resolvedPath,
        npmBinDir,
        message: `switchbot is reachable at ${resolvedPath}`,
      },
    };
  }

  // Not on PATH — figure out what the user should add.
  const currentPath = process.env.PATH ?? '';
  const missingSegment = npmBinDir && !currentPath.split(path.delimiter).includes(npmBinDir)
    ? npmBinDir
    : null;
  const currentShell = detectShellFlavor();
  const shellFix = buildPathFix(currentShell, missingSegment, npmBinDir);

  return {
    name: 'path',
    status: 'warn',
    detail: {
      binaryOnPath: false,
      resolvedPath: null,
      npmBinDir,
      missingPathSegment: missingSegment,
      currentShell,
      fix: shellFix,
      message: `'switchbot' is not on PATH. ${shellFix}`,
    },
  };
}

function checkDaemon(): Check {
  const state = readDaemonState();
  if (!state) {
    return {
      name: 'daemon',
      status: 'warn',
      detail: {
        present: false,
        message: 'No daemon state file found. Start one with `switchbot daemon start` if you want long-running automation.',
      },
    };
  }
  const pid = state.pid;
  const running = pid !== null && (pid === process.pid || isPidAlive(pid));
  return {
    name: 'daemon',
    status: running ? 'ok' : 'warn',
    detail: {
      present: true,
      status: running ? 'running' : state.status,
      pid: running ? pid : null,
      stateFile: state.stateFile,
      pidFile: state.pidFile,
      logFile: state.logFile,
      startedAt: state.startedAt ?? null,
      stoppedAt: state.stoppedAt ?? null,
      lastReloadAt: state.lastReloadAt ?? null,
      lastReloadStatus: state.lastReloadStatus ?? null,
      healthConfigured: typeof state.healthzPort === 'number',
      healthzPort: state.healthzPort ?? null,
      message: running
        ? 'daemon running'
        : 'daemon not running; use `switchbot daemon start` for long-running automation',
    },
  };
}

async function checkHealthEndpoint(): Promise<Check> {
  const state = readDaemonState();
  if (!state || typeof state.healthzPort !== 'number') {
    return {
      name: 'health',
      status: 'warn',
      detail: {
        present: false,
        message: 'No health endpoint configured. Start the daemon with `--healthz-port <n>` to enable it.',
      },
    };
  }
  const url = `http://127.0.0.1:${state.healthzPort}/healthz`;
  try {
    const res = await fetch(url);
    const body = await res.json() as { data?: { overall?: string } };
    const overall = body?.data?.overall ?? 'unknown';
    return {
      name: 'health',
      status: res.ok && overall !== 'down' ? 'ok' : 'warn',
      detail: {
        present: true,
        url,
        httpStatus: res.status,
        overall,
        message: res.ok ? `health endpoint reachable at ${url}` : `health endpoint returned HTTP ${res.status}`,
      },
    };
  } catch (err) {
    return {
      name: 'health',
      status: 'warn',
      detail: {
        present: true,
        url,
        message: `health endpoint probe failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
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

async function checkMqttProbe(): Promise<Check> {
  // P10: live-probe the MQTT broker. Only runs when --probe is passed.
  // Does not subscribe — just connects + disconnects to verify the
  // credential + TLS handshake works end-to-end. Hard 5s timeout so
  // a misbehaving broker never wedges the doctor command.
  const { fetchMqttCredential } = await import('../mqtt/credential.js');
  const { SwitchBotMqttClient } = await import('../mqtt/client.js');

  const token = process.env.SWITCHBOT_TOKEN;
  const secret = process.env.SWITCHBOT_SECRET;
  let creds: { token: string; secret: string } | null = null;
  if (token && secret) {
    creds = { token, secret };
  } else {
    const file = configFilePath();
    if (fs.existsSync(file)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (cfg.token && cfg.secret) {
          creds = { token: cfg.token, secret: cfg.secret };
        }
      } catch { /* fall through */ }
    }
  }
  if (!creds) {
    return {
      name: 'mqtt',
      status: 'warn',
      detail: { probe: 'skipped', reason: 'no credentials configured' },
    };
  }

  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('probe timeout after 5000ms')), 5000),
  );
  try {
    const cred = await Promise.race([fetchMqttCredential(creds.token, creds.secret), deadline]);
    const client = new SwitchBotMqttClient(cred);
    await Promise.race([client.connect(), deadline]);
    await client.disconnect();
    return {
      name: 'mqtt',
      status: 'ok',
      detail: { probe: 'connected', brokerUrl: cred.brokerUrl, region: cred.region },
    };
  } catch (err) {
    return {
      name: 'mqtt',
      status: 'warn',
      detail: { probe: 'failed', reason: err instanceof Error ? err.message : String(err) },
    };
  }
}

function checkMcp(): Check {
  // P10: dry-run instantiation of the MCP server to catch tool-registration
  // regressions. No network I/O, no token needed. If createSwitchBotMcpServer
  // throws (e.g. duplicate tool name, schema build error) the check fails.
  try {
    const server = createSwitchBotMcpServer();
    const tools = listRegisteredTools(server);
    return {
      name: 'mcp',
      status: 'ok',
      detail: {
        serverInstantiated: true,
        toolCount: tools.length,
        tools,
        transportsAvailable: ['stdio', 'http'],
        message: `${tools.length} tools registered; no network probe`,
      },
    };
  } catch (err) {
    return {
      name: 'mcp',
      status: 'fail',
      detail: {
        serverInstantiated: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

interface CheckDef {
  name: string;
  description: string;
  run: (opts: DoctorRunOpts) => Check | Promise<Check>;
}

interface DoctorRunOpts {
  probe: boolean;
}

const CHECK_REGISTRY: CheckDef[] = [
  { name: 'node', description: 'Node.js version compatibility', run: () => checkNodeVersion() },
  { name: 'path', description: 'switchbot binary reachable on PATH', run: () => checkPathDiscoverability() },
  { name: 'credentials', description: 'credentials file present and parseable', run: () => checkCredentials() },
  { name: 'keychain', description: 'OS keychain backend availability and usage', run: () => checkKeychain() },
  { name: 'profiles', description: 'profile definitions valid', run: () => checkProfiles() },
  { name: 'catalog', description: 'catalog loads', run: () => checkCatalog() },
  { name: 'catalog-schema', description: 'catalog vs agent-bootstrap version aligned', run: () => checkCatalogSchema() },
  { name: 'cache', description: 'device cache state', run: () => checkCache() },
  { name: 'quota', description: 'API quota headroom', run: () => checkQuotaFile() },
  { name: 'clock', description: 'system clock skew', run: () => checkClockSkew() },
  {
    name: 'mqtt',
    description: 'MQTT credentials (+ --probe for live broker handshake)',
    run: ({ probe }) => (probe ? checkMqttProbe() : checkMqtt()),
  },
  { name: 'mcp', description: 'MCP server instantiable + tool count', run: () => checkMcp() },
  { name: 'policy', description: 'policy.yaml present + schema-valid (if configured)', run: () => checkPolicy() },
  { name: 'audit', description: 'recent command errors (last 24h)', run: () => checkAudit() },
  { name: 'daemon', description: 'daemon state file + runtime status', run: () => checkDaemon() },
  { name: 'health', description: 'health endpoint availability (daemon --healthz-port)', run: () => checkHealthEndpoint() },
];

interface FixResult {
  check: string;
  action: string;
  applied: boolean;
  message?: string;
}

function applyFixes(checks: Check[], writeOk: boolean): FixResult[] {
  const results: FixResult[] = [];
  for (const c of checks) {
    if (c.name === 'cache' && c.status !== 'ok') {
      if (writeOk) {
        try {
          resetListCache();
          results.push({ check: 'cache', action: 'cache-cleared', applied: true });
        } catch (err) {
          results.push({
            check: 'cache',
            action: 'cache-clear',
            applied: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        results.push({
          check: 'cache',
          action: 'cache-clear',
          applied: false,
          message: 'pass --yes to apply',
        });
      }
    } else if (c.name === 'catalog-schema' && c.status !== 'ok') {
      results.push({
        check: 'catalog-schema',
        action: 'manual',
        applied: false,
        message: "drift detected — run 'switchbot capabilities --reload' to refresh overlay",
      });
    } else if (c.name === 'credentials' && c.status === 'fail') {
      results.push({
        check: 'credentials',
        action: 'manual',
        applied: false,
        message: "run 'switchbot config set-token' to configure credentials",
      });
    }
  }
  return results;
}

interface DoctorCliOptions {
  section?: string;
  list?: boolean;
  fix?: boolean;
  yes?: boolean;
  probe?: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Self-check the SwitchBot CLI setup: credentials, catalog, cache, quota, MQTT, daemon, health, MCP')
    .option('--section <names>', 'Comma-separated list of checks to run (see --list for names)')
    .option('--list', 'Print the registered check names and exit 0 without running any check')
    .option('--fix', 'Apply safe, reversible remediations for failing checks (e.g. clear stale cache)')
    .option('--yes', 'Required together with --fix to confirm write actions')
    .option('--probe', 'Perform live-probe variant of checks that support it (mqtt)')
    .addHelpText('after', `
Runs a battery of local sanity checks and exits with code 0 only when every
check is 'ok'. 'warn' → exit 0 (informational); 'fail' → exit 1.

Examples:
  $ switchbot doctor
  $ switchbot --json doctor | jq '.checks[] | select(.status != "ok")'
  $ switchbot doctor --list
  $ switchbot doctor --section credentials,mcp --json
  $ switchbot doctor --section daemon,health --json
  $ switchbot doctor --probe --json
  $ switchbot doctor --fix --yes --json
`)
    .action(async (opts: DoctorCliOptions) => {
      // --list: print the registry and exit 0.
      if (opts.list) {
        if (isJsonMode()) {
          printJson({
            checks: CHECK_REGISTRY.map((c) => ({ name: c.name, description: c.description })),
          });
        } else {
          console.log('Available checks:');
          for (const c of CHECK_REGISTRY) {
            console.log(`  ${c.name.padEnd(16)} ${c.description}`);
          }
        }
        return;
      }

      // --section: run only the named subset, dedup and validate.
      let selected: CheckDef[] = CHECK_REGISTRY;
      if (opts.section) {
        const raw = opts.section.split(',').map((s) => s.trim()).filter(Boolean);
        const names = Array.from(new Set(raw));
        const known = new Set(CHECK_REGISTRY.map((c) => c.name));
        const unknown = names.filter((n) => !known.has(n));
        if (unknown.length > 0) {
          exitWithError({
            code: 2,
            kind: 'usage',
            message: `Unknown check name(s): ${unknown.join(', ')}. Valid: ${CHECK_REGISTRY.map((c) => c.name).join(', ')}`,
          });
          return;
        }
        const order = new Map(CHECK_REGISTRY.map((c, i) => [c.name, i]));
        selected = names
          .map((n) => CHECK_REGISTRY.find((c) => c.name === n)!)
          .sort((a, b) => (order.get(a.name)! - order.get(b.name)!));
      }

      const runOpts: DoctorRunOpts = { probe: Boolean(opts.probe) };
      const checks: Check[] = [];
      for (const def of selected) {
        checks.push(await def.run(runOpts));
      }

      const summary = {
        ok: checks.filter((c) => c.status === 'ok').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      };
      const overallFail = summary.fail > 0;
      const overall: 'ok' | 'warn' | 'fail' = overallFail ? 'fail' : summary.warn > 0 ? 'warn' : 'ok';

      const total = summary.ok + summary.warn + summary.fail;
      const rawScore = total > 0 ? Math.round(((summary.ok + summary.warn * 0.5) / total) * 100) : 100;
      const maturityScore = Math.min(100, Math.max(0, rawScore));
      const maturityLabel: 'production-ready' | 'mostly-ready' | 'needs-work' | 'not-ready' =
        maturityScore >= 90 ? 'production-ready'
        : maturityScore >= 70 ? 'mostly-ready'
        : maturityScore >= 40 ? 'needs-work'
        : 'not-ready';

      let fixes: FixResult[] | undefined;
      if (opts.fix) {
        fixes = applyFixes(checks, Boolean(opts.yes));
      }

      if (isJsonMode()) {
        // Stable contract (locked as doctor.schemaVersion=1):
        //   { ok: boolean, overall: 'ok'|'warn'|'fail', generatedAt, schemaVersion,
        //     summary: { ok, warn, fail }, checks: [{ name, status, detail }] }
        // `ok` is an alias of (overall === 'ok') — agents prefer the boolean,
        // humans prefer the string; both are provided.
        const payload: Record<string, unknown> = {
          ok: overall === 'ok',
          overall,
          maturityScore,
          maturityLabel,
          generatedAt: new Date().toISOString(),
          schemaVersion: DOCTOR_SCHEMA_VERSION,
          summary,
          checks,
        };
        if (fixes !== undefined) payload.fixes = fixes;
        printJson(payload);
      } else {
        for (const c of checks) {
          const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
          const detailStr =
            typeof c.detail === 'string'
              ? c.detail
              : (typeof (c.detail as { message?: unknown }).message === 'string'
                  ? ((c.detail as { message: string }).message)
                  : JSON.stringify(c.detail));
          console.log(`${icon} ${c.name.padEnd(12)} ${detailStr}`);
        }
        console.log('');
        console.log(`${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`);
        if (fixes && fixes.length > 0) {
          console.log('');
          console.log('Fixes:');
          for (const f of fixes) {
            const marker = f.applied ? '✓' : '-';
            console.log(`  ${marker} ${f.check}: ${f.action}${f.message ? ' — ' + f.message : ''}`);
          }
        }
      }
      if (overallFail) process.exit(1);
    });
}
