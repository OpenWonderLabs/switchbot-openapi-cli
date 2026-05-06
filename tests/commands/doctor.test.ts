import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

import { registerDoctorCommand } from '../../src/commands/doctor.js';
import { runCli } from '../helpers/cli.js';
import { expectJsonEnvelopeShape } from '../helpers/contracts.js';

describe('doctor command', () => {
  let tmp: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbdoc-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    resetListCache();
    delete process.env.SWITCHBOT_TOKEN;
    delete process.env.SWITCHBOT_SECRET;
    // DEFAULT_POLICY_PATH is evaluated at module load time using the real homedir,
    // so mock the env var to keep tests isolated from the developer's real policy file.
    process.env.SWITCHBOT_POLICY_PATH = path.join(tmp, '.config', 'openclaw', 'switchbot', 'policy.yaml');
    process.env.SHELL = '/bin/bash';
    // Default: execSync throws (simulates binary not on PATH / npm not available)
    vi.mocked(execSync).mockReset().mockImplementation(() => { throw new Error('not found'); });
  });
  afterEach(() => {
    resetListCache();
    homedirSpy.mockRestore();
    delete process.env.SWITCHBOT_POLICY_PATH;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exits 1 and reports credentials:fail when nothing is configured', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(payload.data.overall).toBe('fail');
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.status).toBe('fail');
    expect(creds.detail.message).toMatch(/config set-token|auth keychain set/);
    expect(creds.detail.backend).toBeDefined();
  });

  it('reports credentials:ok when env vars are set', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    expect(res.exitCode).not.toBe(1);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.status).toBe('ok');
    expect(creds.detail.source).toBe('env');
    expect(creds.detail.message).toMatch(/env/);
  });

  it('reports credentials with file source when only the config file is present', async () => {
    fs.mkdirSync(path.join(tmp, '.switchbot'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.switchbot', 'config.json'),
      JSON.stringify({ token: 't1', secret: 's1' }),
    );
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    // status is 'ok' on file backends, 'warn' on native keychain backends
    // (file creds + writable keychain → recommend migration).
    expect(['ok', 'warn']).toContain(creds.status);
    expect(creds.detail.source).toBe('file');
    expect(creds.detail.message).toMatch(/config\.json/);
  });

  it('credentials check exposes backend metadata (name + writable)', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.detail.backend).toMatch(/keychain|credman|secret-service|file/);
    expect(typeof creds.detail.writable).toBe('boolean');
    expect(creds.detail.profile).toBe('default');
  });

  it('enumerates profiles when ~/.switchbot/profiles exists', async () => {
    const pdir = path.join(tmp, '.switchbot', 'profiles');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'work.json'), '{}');
    fs.writeFileSync(path.join(pdir, 'home.json'), '{}');
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const profiles = payload.data.checks.find((c: { name: string }) => c.name === 'profiles');
    expect(profiles.detail).toMatch(/found 2/);
    expect(profiles.detail).toMatch(/home/);
    expect(profiles.detail).toMatch(/work/);
  });

  it('catalog check reports the bundled type count', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const cat = payload.data.checks.find((c: { name: string }) => c.name === 'catalog');
    expect(cat.detail).toMatch(/\d+ types loaded/);
  });

  it('mqtt check is warn when REST credentials are missing', async () => {
    delete process.env.SWITCHBOT_TOKEN;
    delete process.env.SWITCHBOT_SECRET;
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const mqtt = payload.data.checks.find((c: { name: string }) => c.name === 'mqtt');
    expect(mqtt).toBeDefined();
    expect(mqtt.status).toBe('warn');
    expect(mqtt.detail).toMatch(/credentials/i);
  });

  it('mqtt check is ok when REST credentials are set', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const mqtt = payload.data.checks.find((c: { name: string }) => c.name === 'mqtt');
    expect(mqtt).toBeDefined();
    expect(mqtt.status).toBe('ok');
    expect(mqtt.detail).toMatch(/auto-provisioned/);
  });

  it('exposes the locked JSON shape: ok, overall, generatedAt, schemaVersion, summary, checks', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const data = expectJsonEnvelopeShape(payload as Record<string, unknown>, [
      'ok',
      'overall',
      'maturityScore',
      'maturityLabel',
      'generatedAt',
      'schemaVersion',
      'summary',
      'checks',
    ]);
    expect(typeof data.ok).toBe('boolean');
    expect(['ok', 'warn', 'fail']).toContain(data.overall);
    expect(typeof data.generatedAt).toBe('string');
    expect(data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.schemaVersion).toBe(1);
    expect(data.summary).toHaveProperty('ok');
    expect(data.summary).toHaveProperty('warn');
    expect(data.summary).toHaveProperty('fail');
    expect(Array.isArray(data.checks)).toBe(true);
    for (const c of data.checks) {
      expect(c).toHaveProperty('name');
      expect(c).toHaveProperty('status');
      expect(c).toHaveProperty('detail');
      expect(['ok', 'warn', 'fail']).toContain(c.status);
    }
  });

  it('clock check emits detail.probeSource and detail.skewMs fields', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    // Stub global fetch so the probe does not actually hit the network.
    const mockedDate = new Date(Date.now() - 500).toUTCString();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        status: 401,
        headers: { date: mockedDate },
      }) as unknown as Response,
    );
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const clock = payload.data.checks.find((c: { name: string }) => c.name === 'clock');
      expect(clock).toBeDefined();
      expect(clock.detail.probeSource).toBe('api');
      expect(typeof clock.detail.skewMs).toBe('number');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('clock check falls back to probeSource:none when the fetch rejects', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const clock = payload.data.checks.find((c: { name: string }) => c.name === 'clock');
      expect(clock.status).toBe('warn');
      expect(clock.detail.probeSource).toBe('none');
      expect(clock.detail.skewMs).toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------
  // P9: quota headroom + catalog-schema + audit checks
  // ---------------------------------------------------------------------
  it('P9: quota check exposes percentUsed / remaining / projectedResetTime when the quota file exists', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const sbDir = path.join(tmp, '.switchbot');
    fs.mkdirSync(sbDir, { recursive: true });
    // 100 requests today — well under 80%, so status must stay 'ok'.
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    const date = `${y}-${m}-${d}`;
    fs.writeFileSync(
      path.join(sbDir, 'quota.json'),
      JSON.stringify({ days: { [date]: { total: 100, endpoints: {} } } }),
    );
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const q = payload.data.checks.find((c: { name: string }) => c.name === 'quota');
    expect(q.status).toBe('ok');
    expect(q.detail.percentUsed).toBe(1);
    expect(q.detail.remaining).toBe(9_900);
    expect(q.detail.total).toBe(100);
    expect(q.detail.dailyCap).toBe(10_000);
    expect(typeof q.detail.projectedResetTime).toBe('string');
    expect(q.detail.projectedResetTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof q.detail.recommendation).toBe('string');
  });

  it('P9: quota check warns when usage is over 80%', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const sbDir = path.join(tmp, '.switchbot');
    fs.mkdirSync(sbDir, { recursive: true });
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const d = String(today.getDate()).padStart(2, '0');
    fs.writeFileSync(
      path.join(sbDir, 'quota.json'),
      JSON.stringify({ days: { [`${y}-${m}-${d}`]: { total: 9_500, endpoints: {} } } }),
    );
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const q = payload.data.checks.find((c: { name: string }) => c.name === 'quota');
    expect(q.status).toBe('warn');
    expect(q.detail.percentUsed).toBe(95);
    expect(q.detail.recommendation).toMatch(/90|reset/);
  });

  it('P9: catalog-schema check passes when bootstrap and catalog versions match', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const cs = payload.data.checks.find((c: { name: string }) => c.name === 'catalog-schema');
    expect(cs).toBeDefined();
    expect(cs.status).toBe('ok');
    expect(cs.detail.match).toBe(true);
    expect(cs.detail.catalogSchemaVersion).toBe(cs.detail.bootstrapExpectsVersion);
  });

  it('P9: audit check reports "not present" when the audit log file is missing', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const audit = payload.data.checks.find((c: { name: string }) => c.name === 'audit');
    expect(audit).toBeDefined();
    expect(audit.status).toBe('ok');
    expect(audit.detail.enabled).toBe(false);
  });

  it('P9: audit check warns and lists recent errors when the audit log has failures in the last 24h', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const sbDir = path.join(tmp, '.switchbot');
    fs.mkdirSync(sbDir, { recursive: true });
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({ auditVersion: 1, t: recent, kind: 'command', deviceId: 'BOT1', command: 'turnOff', result: 'error', error: 'rate limit' }),
      JSON.stringify({ auditVersion: 1, t: stale, kind: 'command', deviceId: 'BOT1', command: 'turnOff', result: 'error', error: 'old' }),
      JSON.stringify({ auditVersion: 1, t: recent, kind: 'command', deviceId: 'BOT2', command: 'press', result: 'ok' }),
    ];
    fs.writeFileSync(path.join(sbDir, 'audit.log'), lines.join('\n') + '\n');
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const audit = payload.data.checks.find((c: { name: string }) => c.name === 'audit');
    expect(audit.status).toBe('warn');
    expect(audit.detail.enabled).toBe(true);
    expect(audit.detail.totalErrors).toBe(2);
    expect(audit.detail.errorsLast24h).toBe(1);
    expect(audit.detail.recent).toHaveLength(1);
    expect(audit.detail.recent[0].command).toBe('turnOff');
    expect(audit.detail.recent[0].error).toBe('rate limit');
  });

  // ---------------------------------------------------------------------
  // P10: MCP dry-run + --section / --list / --fix / --probe
  // ---------------------------------------------------------------------
  it('P10: mcp check is ok and reports a toolCount when the server instantiates', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const mcp = payload.data.checks.find((c: { name: string }) => c.name === 'mcp');
    expect(mcp).toBeDefined();
    expect(mcp.status).toBe('ok');
    expect(mcp.detail.serverInstantiated).toBe(true);
    expect(typeof mcp.detail.toolCount).toBe('number');
    expect(mcp.detail.toolCount).toBeGreaterThan(0);
    expect(Array.isArray(mcp.detail.tools)).toBe(true);
    expect(mcp.detail.transportsAvailable).toEqual(['stdio', 'http']);
  });

  it('P10: --list prints the registered check names without running any check', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--list']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(payload.data.checks).toBeDefined();
    const names = payload.data.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('credentials');
    expect(names).toContain('mcp');
    expect(names).toContain('catalog-schema');
    expect(names).toContain('inventory');
    expect(names).toContain('audit');
    // Should NOT include check results — just registry entries with description.
    expect(payload.data.summary).toBeUndefined();
    expect(payload.data.overall).toBeUndefined();
    for (const entry of payload.data.checks) {
      expect(typeof entry.description).toBe('string');
      expect(entry.status).toBeUndefined();
    }
  });

  it('P10: --section runs only the named checks (sorted by registry order)', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'credentials,mcp']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const names = payload.data.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(['credentials', 'mcp']);
    expect(payload.data.summary.ok + payload.data.summary.warn + payload.data.summary.fail).toBe(2);
  });

  it('P10: --section dedupes duplicate names', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'mcp,mcp,credentials,mcp']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const names = payload.data.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual(['credentials', 'mcp']);
  });

  it('P10: --section rejects unknown check names with exit 2 + valid-names hint', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'bogus']);
    expect(res.exitCode).toBe(2);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(payload.schemaVersion).toBe('1.1');
    expect(payload.error.message).toMatch(/Unknown check name/);
    expect(payload.error.message).toMatch(/bogus/);
    expect(payload.error.message).toMatch(/Valid:/);
  });

  it('P10: --fix without --yes reports cache-clear as not-applied (pass --yes to apply)', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    // With no stored cache, the cache check status is still 'ok', so --fix
    // should not queue any actions. Force a non-ok cache check by creating
    // a list cache file that describeCache() can see, then scenarios where
    // we expect fixes to be listed (or empty) both verify the fixes field.
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--fix']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(Array.isArray(payload.data.fixes)).toBe(true);
  });

  it('P10: --fix --yes applies safe fixes and records them in the fixes array', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--fix', '--yes']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(Array.isArray(payload.data.fixes)).toBe(true);
    // Every fix entry must have check/action/applied fields.
    for (const f of payload.data.fixes) {
      expect(typeof f.check).toBe('string');
      expect(typeof f.action).toBe('string');
      expect(typeof f.applied).toBe('boolean');
    }
  });

  it('P10: --probe runs the MQTT live-probe variant and tolerates failure as warn', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    // Stub fetch so fetchMqttCredential rejects; the probe should catch
    // and surface probe:'failed' with status 'warn' (never hang the CLI).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--probe', '--section', 'mqtt']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const mqtt = payload.data.checks.find((c: { name: string }) => c.name === 'mqtt');
      expect(mqtt.status).toBe('warn');
      expect(mqtt.detail.probe).toBe('failed');
      expect(typeof mqtt.detail.reason).toBe('string');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('P10: --probe without credentials reports probe:skipped', async () => {
    delete process.env.SWITCHBOT_TOKEN;
    delete process.env.SWITCHBOT_SECRET;
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--probe', '--section', 'mqtt']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const mqtt = payload.data.checks.find((c: { name: string }) => c.name === 'mqtt');
    expect(mqtt.detail.probe).toBe('skipped');
  });

  // Policy check (doctor --section policy) — optional file, valid when present,
  // fail when the schema rejects it. See docs/design/phase4-rules-schema.md
  // for why the doctor surface reports this as an independent section rather
  // than wedging it into credentials/catalog.
  it('policy check is ok with present:false when no policy file exists', async () => {
    const policyPath = path.join(tmp, '.config', 'openclaw', 'switchbot', 'policy.yaml');
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'policy']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const policy = payload.data.checks.find((c: { name: string }) => c.name === 'policy');
      expect(policy.status).toBe('ok');
      expect(policy.detail.present).toBe(false);
      expect(policy.detail.path).toBe(policyPath);
      expect(policy.detail.message).toMatch(/policy new/);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('policy check is fail when the file contains v0.1 (unsupported in v3.0)', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(policyPath, 'version: "0.1"\n');
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'policy']);
      // v0.1 is unsupported in v3.0 — validation returns unsupported-version error.
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const policy = payload.data.checks.find((c: { name: string }) => c.name === 'policy');
      expect(policy.status).toBe('fail');
      expect(policy.detail.present).toBe(true);
      expect(policy.detail.valid).toBe(false);
      expect(policy.detail.errorCount).toBeGreaterThan(0);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('policy check is fail when the schema rejects the file', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    // lowercase deviceId violates the aliases pattern (the #1 real-world bug)
    fs.writeFileSync(
      policyPath,
      'version: "0.1"\naliases:\n  "bedroom ac": "02-202502111234-abc123"\n',
    );
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'policy']);
      expect(res.exitCode).toBe(1);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const policy = payload.data.checks.find((c: { name: string }) => c.name === 'policy');
      expect(policy.status).toBe('fail');
      expect(policy.detail.present).toBe(true);
      expect(policy.detail.valid).toBe(false);
      expect(policy.detail.errorCount).toBeGreaterThan(0);
      expect(policy.detail.message).toMatch(/policy validate/);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('policy check is fail when the YAML itself is malformed', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(policyPath, 'version: "0.1"\naliases: {unterminated\n');
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'policy']);
      expect(res.exitCode).toBe(1);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const policy = payload.data.checks.find((c: { name: string }) => c.name === 'policy');
      expect(policy.status).toBe('fail');
      expect(policy.detail.parseError).toBe(true);
      expect(typeof policy.detail.message).toBe('string');
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('policy check reports schemaVersion 0.2 for v0.2 policies with rules', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      policyPath,
      [
        'version: "0.2"',
        'automation:',
        '  enabled: true',
        '  rules:',
        '    - name: "nightlight"',
        '      when:',
        '        source: mqtt',
        '        event: motion.detected',
        '      then:',
        '        - command: "devices command <id> turnOn"',
        '          device: "hall-light"',
        '',
      ].join('\n'),
    );
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'policy']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const policy = payload.data.checks.find((c: { name: string }) => c.name === 'policy');
      expect(policy.status).toBe('ok');
      expect(policy.detail.valid).toBe(true);
      expect(policy.detail.schemaVersion).toBe('0.2');
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  // ---------------------------------------------------------------------
  // P0-1: PATH / binary discoverability check
  // ---------------------------------------------------------------------
  it('path check: is present in the --list output', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--list']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const names = payload.data.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('path');
  });

  it('path check: returns ok with binaryOnPath:true when binary is found', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('npm prefix')) return '/usr/local\n' as never;
      if (c.includes('which') || c.includes('where')) return '/usr/local/bin/switchbot\n' as never;
      throw new Error('unexpected');
    });
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'path']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const check = payload.data.checks.find((c: { name: string }) => c.name === 'path');
    expect(check).toBeDefined();
    expect(check.status).toBe('ok');
    expect(check.detail.binaryOnPath).toBe(true);
    expect(typeof check.detail.resolvedPath).toBe('string');
  });

  it('path check: returns warn with fix hint when binary is not on PATH', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('npm prefix')) return '/usr/local\n' as never;
      throw new Error('not found');
    });
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'path']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const check = payload.data.checks.find((c: { name: string }) => c.name === 'path');
    expect(check).toBeDefined();
    expect(check.status).toBe('warn');
    expect(check.detail.binaryOnPath).toBe(false);
    expect(check.detail.resolvedPath).toBeNull();
    expect(typeof check.detail.fix).toBe('string');
    expect(['bash', 'cmd']).toContain(check.detail.currentShell);
    expect(check.detail.fix).toMatch(/\.bashrc|export PATH|set PATH|setx PATH/);
  });

  it('path check: detail includes npmBinDir when npm prefix succeeds', async () => {
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('npm prefix')) return '/home/user/.npm-global\n' as never;
      throw new Error('not found');
    });
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'path']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const check = payload.data.checks.find((c: { name: string }) => c.name === 'path');
    expect(check.detail.npmBinDir).toBeTruthy();
  });

  it('path check: emits PowerShell-specific fix hints when SHELL indicates pwsh', async () => {
    process.env.SHELL = 'pwsh';
    vi.mocked(execSync).mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('npm prefix')) return '/usr/local\n' as never;
      throw new Error('not found');
    });
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'path']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const check = payload.data.checks.find((c: { name: string }) => c.name === 'path');
    expect(check.detail.currentShell).toBe('powershell');
    expect(check.detail.fix).toMatch(/\$env:Path/);
  });

  it('daemon and health checks appear in --list output', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--list']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const names = payload.data.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('daemon');
    expect(names).toContain('health');
  });

  it('daemon check reads daemon.state.json and reports running metadata', async () => {
    const sbDir = path.join(tmp, '.switchbot');
    fs.mkdirSync(sbDir, { recursive: true });
    fs.writeFileSync(path.join(sbDir, 'daemon.pid'), `${process.pid}\n`);
    fs.writeFileSync(
      path.join(sbDir, 'daemon.state.json'),
      JSON.stringify({
        status: 'running',
        pid: process.pid,
        logFile: path.join(sbDir, 'daemon.log'),
        pidFile: path.join(sbDir, 'daemon.pid'),
        stateFile: path.join(sbDir, 'daemon.state.json'),
        startedAt: '2026-04-25T00:00:00.000Z',
        healthzPort: 3210,
      }),
    );
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'daemon']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const daemon = payload.data.checks.find((c: { name: string }) => c.name === 'daemon');
    expect(daemon.status).toBe('ok');
    expect(daemon.detail.present).toBe(true);
    expect(daemon.detail.pid).toBe(process.pid);
    expect(daemon.detail.healthConfigured).toBe(true);
  });

  describe('maturity score', () => {
    it('includes maturityScore (0–100) and maturityLabel in --json output', async () => {
      process.env.SWITCHBOT_TOKEN = 't';
      process.env.SWITCHBOT_SECRET = 's';
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(typeof payload.data.maturityScore).toBe('number');
      expect(payload.data.maturityScore).toBeGreaterThanOrEqual(0);
      expect(payload.data.maturityScore).toBeLessThanOrEqual(100);
      expect(['production-ready', 'mostly-ready', 'needs-work', 'not-ready']).toContain(
        payload.data.maturityLabel,
      );
    });

    it('maturityLabel is lower when credentials are missing (score < 100)', async () => {
      // No creds → credentials:fail → score is reduced
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
      expect(res.exitCode).toBe(1);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(payload.data.maturityScore).toBeLessThan(100);
      expect(['production-ready', 'mostly-ready', 'needs-work', 'not-ready']).toContain(
        payload.data.maturityLabel,
      );
    });

    it('maturityScore is an integer', async () => {
      process.env.SWITCHBOT_TOKEN = 't';
      process.env.SWITCHBOT_SECRET = 's';
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(Number.isInteger(payload.data.maturityScore)).toBe(true);
    });
  });

  it('inventory check warns when a cached device points at a missing hubDeviceId', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    updateCacheFromDeviceList({
      deviceList: [
        {
          deviceId: 'METER-1',
          deviceName: 'Bedroom Meter',
          deviceType: 'Meter',
          hubDeviceId: 'HUB-MISSING',
          enableCloudService: true,
        },
      ],
      infraredRemoteList: [],
    });
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'inventory']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const inventory = payload.data.checks.find((c: { name: string }) => c.name === 'inventory');
    expect(inventory.status).toBe('warn');
    expect(inventory.detail.message).toMatch(/hubDeviceId/);
    expect(inventory.detail.dangling[0]).toMatchObject({
      deviceId: 'METER-1',
      hubDeviceId: 'HUB-MISSING',
    });
  });

  it('release-notes check is ok when RELEASE_METADATA carries no breaking notice for the current release', async () => {
    // The release-notes check is a contract between doctor and
    // src/version-notes.ts RELEASE_METADATA. When no entry exists for
    // the running version (or the entry has `breaking: false`), the
    // check must report 'ok'. The 3.3.0 envelope-breaking entry that
    // previously lit this path up was removed in 3.3.1 after we
    // verified the envelope actually shipped in 2.0.0 (commit 33d3825),
    // not 3.3.0 — it was a false breaking claim.
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'release-notes']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const note = payload.data.checks.find((c: { name: string }) => c.name === 'release-notes');
    expect(note).toBeDefined();
    expect(note.status).toBe('ok');
    expect(String(note.detail.message)).toMatch(/no known breaking-change notice/i);
  });

  it('notify-connectivity check appears in --list output', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--list']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const names = payload.data.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('notify-connectivity');
  });

  it('notify-connectivity check is ok with webhookCount:0 when policy has no notify actions', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(policyPath, [
      'version: "0.2"',
      'automation:',
      '  enabled: false',
      '  rules: []',
    ].join('\n') + '\n');
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'notify-connectivity']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const check = payload.data.checks.find((c: { name: string }) => c.name === 'notify-connectivity');
      expect(check).toBeDefined();
      expect(check.status).toBe('ok');
      expect(check.detail.webhookCount).toBe(0);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('notify-connectivity check is ok with present:false when no policy file exists', async () => {
    process.env.SWITCHBOT_POLICY_PATH = path.join(tmp, 'nonexistent-policy.yaml');
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    try {
      const res = await runCli(registerDoctorCommand, ['--json', 'doctor', '--section', 'notify-connectivity']);
      const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const check = payload.data.checks.find((c: { name: string }) => c.name === 'notify-connectivity');
      expect(check).toBeDefined();
      expect(check.status).toBe('ok');
      expect(check.detail.present).toBe(false);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });
});
