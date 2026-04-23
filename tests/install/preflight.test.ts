import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPreflight } from '../../src/install/preflight.js';

describe('runPreflight', () => {
  let tmp: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-preflight-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });
  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reports ok for a clean home directory', async () => {
    const res = await runPreflight();
    expect(res.ok).toBe(true);
    const home = res.checks.find((c) => c.name === 'home');
    expect(home?.status).toBe('ok');
    expect(home?.message).toContain(tmp);
  });

  it('fails when Node.js version is below the minimum', async () => {
    const res = await runPreflight({ nodeVersion: 'v16.20.0', minNodeMajor: 18 });
    expect(res.ok).toBe(false);
    const node = res.checks.find((c) => c.name === 'node');
    expect(node?.status).toBe('fail');
    expect(node?.message).toMatch(/v16/);
    expect(node?.hint).toMatch(/upgrade Node\.js/);
  });

  it('fails when Node.js version string is unparseable', async () => {
    const res = await runPreflight({ nodeVersion: 'nonsense' });
    const node = res.checks.find((c) => c.name === 'node');
    expect(node?.status).toBe('fail');
  });

  it('passes the Node.js check on current runtime by default', async () => {
    const res = await runPreflight();
    const node = res.checks.find((c) => c.name === 'node');
    expect(node?.status).toBe('ok');
  });

  it('policy check is ok when no policy file exists (installer will scaffold)', async () => {
    const prev = process.env.SWITCHBOT_POLICY_PATH;
    process.env.SWITCHBOT_POLICY_PATH = path.join(tmp, 'never-exists-policy.yaml');
    try {
      const res = await runPreflight();
      const policy = res.checks.find((c) => c.name === 'policy');
      expect(policy?.status).toBe('ok');
      expect(policy?.message).toMatch(/no policy at/);
    } finally {
      if (prev === undefined) delete process.env.SWITCHBOT_POLICY_PATH;
      else process.env.SWITCHBOT_POLICY_PATH = prev;
    }
  });

  it('policy check is ok when a valid policy file exists', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(path.join(policyDir, 'policy.yaml'), 'version: "0.1"\n');
    const prev = process.env.SWITCHBOT_POLICY_PATH;
    process.env.SWITCHBOT_POLICY_PATH = path.join(policyDir, 'policy.yaml');
    try {
      const res = await runPreflight();
      const policy = res.checks.find((c) => c.name === 'policy');
      expect(policy?.status).toBe('ok');
      expect(policy?.message).toMatch(/validates/);
    } finally {
      if (prev === undefined) delete process.env.SWITCHBOT_POLICY_PATH;
      else process.env.SWITCHBOT_POLICY_PATH = prev;
    }
  });

  it('policy check warns when the policy file fails schema validation', async () => {
    const policyDir = path.join(tmp, '.config', 'openclaw', 'switchbot');
    fs.mkdirSync(policyDir, { recursive: true });
    // Missing required "version" field.
    fs.writeFileSync(path.join(policyDir, 'policy.yaml'), 'allowlist: []\n');
    const prev = process.env.SWITCHBOT_POLICY_PATH;
    process.env.SWITCHBOT_POLICY_PATH = path.join(policyDir, 'policy.yaml');
    try {
      const res = await runPreflight();
      const policy = res.checks.find((c) => c.name === 'policy');
      expect(policy?.status).toBe('warn');
      expect(policy?.hint).toMatch(/policy validate/);
    } finally {
      if (prev === undefined) delete process.env.SWITCHBOT_POLICY_PATH;
      else process.env.SWITCHBOT_POLICY_PATH = prev;
    }
  });

  it('keychain check returns a backend name', async () => {
    const res = await runPreflight();
    const keychain = res.checks.find((c) => c.name === 'keychain');
    expect(keychain).toBeDefined();
    expect(keychain?.message).toMatch(/credential backend|keychain probe/);
  });

  it('result.ok is false when any check is fail', async () => {
    const res = await runPreflight({ nodeVersion: 'v10.0.0', minNodeMajor: 18 });
    expect(res.ok).toBe(false);
  });

  it('result.ok stays true when all checks are ok or warn', async () => {
    // No fail conditions; all checks should be at most warn.
    const res = await runPreflight();
    expect(res.ok).toBe(true);
  });

  it('is read-only: does not create ~/.switchbot or ~/.claude during checks', async () => {
    const switchbotDir = path.join(tmp, '.switchbot');
    const claudeDir = path.join(tmp, '.claude');
    expect(fs.existsSync(switchbotDir)).toBe(false);
    expect(fs.existsSync(claudeDir)).toBe(false);

    const res = await runPreflight({ agent: 'claude-code', expectSkillLink: true });
    expect(res.ok).toBe(true);

    expect(fs.existsSync(switchbotDir)).toBe(false);
    expect(fs.existsSync(claudeDir)).toBe(false);
  });

  it('skips agent-skills-dir check when expectSkillLink=false', async () => {
    const res = await runPreflight({ agent: 'claude-code', expectSkillLink: false });
    const agent = res.checks.find((c) => c.name === 'agent-skills-dir');
    expect(agent).toBeUndefined();
  });

  it('fails agent-skills-dir when a path component is a file', async () => {
    fs.writeFileSync(path.join(tmp, '.claude'), 'blocked', 'utf-8');
    const res = await runPreflight({ agent: 'claude-code', expectSkillLink: true });
    const agent = res.checks.find((c) => c.name === 'agent-skills-dir');
    expect(agent?.status).toBe('fail');
    expect(res.ok).toBe(false);
  });
});
