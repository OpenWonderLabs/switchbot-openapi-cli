import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerDoctorCommand } from '../../src/commands/doctor.js';
import { runCli } from '../helpers/cli.js';

describe('doctor command', () => {
  let tmp: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbdoc-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    delete process.env.SWITCHBOT_TOKEN;
    delete process.env.SWITCHBOT_SECRET;
  });
  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('exits 1 and reports credentials:fail when nothing is configured', async () => {
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    expect(payload.data.overall).toBe('fail');
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.status).toBe('fail');
    expect(creds.detail).toMatch(/config set-token/);
  });

  it('reports credentials:ok when env vars are set', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    expect(res.exitCode).not.toBe(1);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.status).toBe('ok');
    expect(creds.detail).toMatch(/env/);
  });

  it('reports credentials:ok when the config file is valid', async () => {
    fs.mkdirSync(path.join(tmp, '.switchbot'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.switchbot', 'config.json'),
      JSON.stringify({ token: 't1', secret: 's1' }),
    );
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const creds = payload.data.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.status).toBe('ok');
    expect(creds.detail).toMatch(/config\.json/);
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
    const data = payload.data;
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
});
