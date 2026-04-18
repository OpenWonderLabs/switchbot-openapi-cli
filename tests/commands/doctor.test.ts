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
    expect(payload.overall).toBe('fail');
    const creds = payload.checks.find((c: { name: string }) => c.name === 'credentials');
    expect(creds.status).toBe('fail');
    expect(creds.detail).toMatch(/config set-token/);
  });

  it('reports credentials:ok when env vars are set', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    expect(res.exitCode).not.toBe(1);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const creds = payload.checks.find((c: { name: string }) => c.name === 'credentials');
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
    const creds = payload.checks.find((c: { name: string }) => c.name === 'credentials');
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
    const profiles = payload.checks.find((c: { name: string }) => c.name === 'profiles');
    expect(profiles.detail).toMatch(/found 2/);
    expect(profiles.detail).toMatch(/home/);
    expect(profiles.detail).toMatch(/work/);
  });

  it('catalog check reports the bundled type count', async () => {
    process.env.SWITCHBOT_TOKEN = 't';
    process.env.SWITCHBOT_SECRET = 's';
    const res = await runCli(registerDoctorCommand, ['--json', 'doctor']);
    const payload = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
    const cat = payload.checks.find((c: { name: string }) => c.name === 'catalog');
    expect(cat.detail).toMatch(/\d+ types loaded/);
  });
});
