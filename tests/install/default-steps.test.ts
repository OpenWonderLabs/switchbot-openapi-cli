import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  stepPromptCredentials,
  stepWriteKeychain,
  stepScaffoldPolicy,
  stepSymlinkSkill,
  stepDoctorVerify,
  skillLinkPathFor,
  type InstallContext,
  type DoctorSpawner,
  type SymlinkSkillOptions,
} from '../../src/install/default-steps.js';
import type { CredentialStore, CredentialBundle } from '../../src/credentials/keychain.js';

// Minimal in-memory credential store used across the tests — lets us
// assert set/delete flows without touching the OS keychain.
function makeMockStore(): CredentialStore & { _entries: Map<string, CredentialBundle> } {
  const entries = new Map<string, CredentialBundle>();
  return {
    name: 'file',
    _entries: entries,
    async get(profile: string) {
      return entries.get(profile) ?? null;
    },
    async set(profile: string, creds: CredentialBundle) {
      entries.set(profile, creds);
    },
    async delete(profile: string) {
      entries.delete(profile);
    },
    describe() {
      return { backend: 'mock', tag: 'file', writable: true };
    },
  };
}

function baseCtx(overrides: Partial<InstallContext> = {}): InstallContext {
  return {
    profile: 'default',
    agent: 'none',
    policyPath: '/dev/null/never-used',
    ...overrides,
  };
}

describe('stepPromptCredentials', () => {
  it('no-ops when credentials are already in context', async () => {
    const ctx = baseCtx({ credentials: { token: 't', secret: 's' } });
    const step = stepPromptCredentials();
    await step.execute(ctx);
    expect(ctx.credentials).toEqual({ token: 't', secret: 's' });
  });

  it('reads --token-file when provided', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-prompt-'));
    const file = path.join(tmp, 'creds.txt');
    fs.writeFileSync(file, 'mytoken\nmysecret\n', 'utf-8');
    const ctx = baseCtx({ tokenFile: file });
    const step = stepPromptCredentials();
    await step.execute(ctx);
    expect(ctx.credentials).toEqual({ token: 'mytoken', secret: 'mysecret' });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('throws in non-interactive mode without a token file', async () => {
    const ctx = baseCtx({ nonInteractive: true });
    const step = stepPromptCredentials();
    await expect(step.execute(ctx)).rejects.toThrow(/non-interactively/);
  });
});

describe('stepWriteKeychain', () => {
  it('writes credentials to the store and records it on the context', async () => {
    const store = makeMockStore();
    const ctx = baseCtx({ credentials: { token: 't', secret: 's' } });
    const spy = vi.spyOn(await import('../../src/credentials/keychain.js'), 'selectCredentialStore')
      .mockResolvedValue(store);
    const step = stepWriteKeychain();
    await step.execute(ctx);
    expect(store._entries.get('default')).toEqual({ token: 't', secret: 's' });
    expect(ctx.credentialsWereStored).toBe(true);
    expect(ctx.credentialStore).toBe(store);
    spy.mockRestore();
  });

  it('throws if credentials were not captured', async () => {
    const ctx = baseCtx();
    const step = stepWriteKeychain();
    await expect(step.execute(ctx)).rejects.toThrow(/credentials missing/);
  });

  it('undo removes the credentials we stored', async () => {
    const store = makeMockStore();
    const ctx: InstallContext = baseCtx({
      credentials: { token: 't', secret: 's' },
      credentialStore: store,
      credentialsWereStored: true,
    });
    store._entries.set('default', { token: 't', secret: 's' });
    const step = stepWriteKeychain();
    await step.undo(ctx);
    expect(store._entries.has('default')).toBe(false);
    expect(ctx.credentialsWereStored).toBe(false);
  });

  it('undo is a no-op if credentials were never stored', async () => {
    const store = makeMockStore();
    const ctx: InstallContext = baseCtx({ credentialStore: store });
    const step = stepWriteKeychain();
    await step.undo(ctx); // must not throw
    expect(store._entries.size).toBe(0);
  });
});

describe('stepScaffoldPolicy', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-policy-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates policy.yaml when absent', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const ctx = baseCtx({ policyPath });
    const step = stepScaffoldPolicy();
    step.execute(ctx);
    expect(fs.existsSync(policyPath)).toBe(true);
    expect(ctx.policyScaffoldResult?.skipped).toBeFalsy();
    expect(ctx.policyScaffoldResult?.bytesWritten).toBeGreaterThan(0);
  });

  it('skips when the file already exists', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    fs.writeFileSync(policyPath, 'version: "0.2"\n', 'utf-8');
    const ctx = baseCtx({ policyPath });
    const step = stepScaffoldPolicy();
    step.execute(ctx);
    expect(fs.readFileSync(policyPath, 'utf-8')).toBe('version: "0.2"\n');
    expect(ctx.policyScaffoldResult?.skipped).toBe(true);
  });

  it('undo removes a file we created', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    const ctx = baseCtx({ policyPath });
    const step = stepScaffoldPolicy();
    step.execute(ctx);
    expect(fs.existsSync(policyPath)).toBe(true);
    step.undo(ctx);
    expect(fs.existsSync(policyPath)).toBe(false);
  });

  it('undo leaves a pre-existing file alone', () => {
    const policyPath = path.join(tmpDir, 'policy.yaml');
    fs.writeFileSync(policyPath, 'existing\n', 'utf-8');
    const ctx = baseCtx({ policyPath });
    const step = stepScaffoldPolicy();
    step.execute(ctx);
    step.undo(ctx);
    expect(fs.readFileSync(policyPath, 'utf-8')).toBe('existing\n');
  });
});

describe('stepSymlinkSkill', () => {
  let tmpDir: string;
  let skillDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skill-'));
    skillDir = path.join(tmpDir, 'skill');
    fs.mkdirSync(skillDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when agent is none', () => {
    const ctx = baseCtx({ agent: 'none' });
    const step = stepSymlinkSkill();
    step.execute(ctx);
    expect(ctx.skillLinkCreated).toBeFalsy();
  });

  it('prints a recipe if skillPath is missing', () => {
    const ctx = baseCtx({ agent: 'claude-code' });
    const step = stepSymlinkSkill();
    step.execute(ctx);
    expect(ctx.skillRecipePrinted).toBe(true);
    expect(ctx.skillLinkCreated).toBeFalsy();
  });

  it('prints a recipe for non-automating agents even with skillPath', () => {
    const ctx = baseCtx({ agent: 'cursor', skillPath: skillDir });
    const step = stepSymlinkSkill();
    step.execute(ctx);
    expect(ctx.skillRecipePrinted).toBe(true);
    expect(ctx.skillLinkCreated).toBeFalsy();
  });

  it('throws if --skill-path does not exist', () => {
    const ctx = baseCtx({ agent: 'claude-code', skillPath: path.join(tmpDir, 'nope') });
    const step = stepSymlinkSkill();
    expect(() => step.execute(ctx)).toThrow(/does not exist/);
  });

  it('A2: throws if skillPath has no SKILL.md', () => {
    const ctx = baseCtx({ agent: 'claude-code', skillPath: skillDir });
    const step = stepSymlinkSkill(); // no force
    expect(() => step.execute(ctx)).toThrow(/SKILL\.md/);
  });

  it('A2: --force bypasses SKILL.md check', () => {
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const ctx = baseCtx({ agent: 'claude-code', skillPath: skillDir });
    const step = stepSymlinkSkill({ force: true });
    step.execute(ctx); // must not throw
    expect(ctx.skillLinkCreated).toBe(true);
    homeSpy.mockRestore();
  });

  it('creates a symlink/junction under the agent-specific path', () => {
    // Redirect HOME so the test does not touch the user's real ~/.claude.
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    // Add SKILL.md so the step does not complain.
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill\n');

    const ctx = baseCtx({ agent: 'claude-code', skillPath: skillDir });
    const step = stepSymlinkSkill();
    step.execute(ctx);

    const expected = path.join(fakeHome, '.claude', 'skills', 'switchbot');
    expect(ctx.skillLinkPath).toBe(expected);
    expect(ctx.skillLinkCreated).toBe(true);
    expect(fs.lstatSync(expected).isSymbolicLink()).toBe(true);

    step.undo(ctx);
    expect(fs.existsSync(expected)).toBe(false);

    homeSpy.mockRestore();
  });

  it('A3: is idempotent when existing symlink points at the same target', () => {
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill\n');

    const ctx = baseCtx({ agent: 'claude-code', skillPath: skillDir });
    const step = stepSymlinkSkill();
    step.execute(ctx); // first run creates the link
    ctx.skillLinkCreated = undefined;
    step.execute(ctx); // second run: same target → idempotent
    expect(ctx.skillLinkCreated).toBe(false); // did not recreate
    homeSpy.mockRestore();
  });

  it('A3: throws when existing symlink points at a different target without --force', () => {
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const otherSkill = path.join(tmpDir, 'other-skill');
    fs.mkdirSync(otherSkill);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill\n');

    // Pre-create a symlink pointing at otherSkill.
    const linkPath = path.join(fakeHome, '.claude', 'skills', 'switchbot');
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.resolve(otherSkill), linkPath, linkType);

    const ctx = baseCtx({ agent: 'claude-code', skillPath: skillDir });
    const step = stepSymlinkSkill();
    expect(() => step.execute(ctx)).toThrow(/already links/);
    homeSpy.mockRestore();
  });

  it('A3: --force replaces a symlink pointing at a different target', () => {
    const fakeHome = path.join(tmpDir, 'home');
    fs.mkdirSync(fakeHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);

    const otherSkill = path.join(tmpDir, 'other-skill');
    fs.mkdirSync(otherSkill);
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# skill\n');

    const linkPath = path.join(fakeHome, '.claude', 'skills', 'switchbot');
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(path.resolve(otherSkill), linkPath, linkType);

    const ctx = baseCtx({ agent: 'claude-code', skillPath: skillDir });
    const step = stepSymlinkSkill({ force: true });
    step.execute(ctx);
    expect(ctx.skillLinkCreated).toBe(true);
    homeSpy.mockRestore();
  });

  it('skillLinkPathFor maps agents to directories', () => {
    const home = '/h';
    expect(skillLinkPathFor('claude-code', home)).toBe(path.join(home, '.claude', 'skills', 'switchbot'));
    expect(skillLinkPathFor('cursor', home)).toBeNull();
    expect(skillLinkPathFor('copilot', home)).toBeNull();
    expect(skillLinkPathFor('none', home)).toBeNull();
  });
});

describe('stepDoctorVerify', () => {
  it('captures ok=true when doctor exits 0', () => {
    const fakeSpawner: DoctorSpawner = () => ({
      ok: true,
      exitCode: 0,
      stdout: JSON.stringify({ summary: { fail: 0 } }),
      stderr: '',
    });
    const ctx = baseCtx();
    const step = stepDoctorVerify({ cliPath: '/dev/null/cli.js', spawner: fakeSpawner });
    step.execute(ctx);
    expect(ctx.doctorOk).toBe(true);
    expect(ctx.doctorReport).toEqual({ summary: { fail: 0 } });
  });

  it('captures ok=false without throwing when doctor exits non-zero', () => {
    const fakeSpawner: DoctorSpawner = () => ({
      ok: false,
      exitCode: 1,
      stdout: JSON.stringify({ summary: { fail: 2 } }),
      stderr: '',
    });
    const ctx = baseCtx();
    const step = stepDoctorVerify({ cliPath: '/dev/null/cli.js', spawner: fakeSpawner });
    expect(() => step.execute(ctx)).not.toThrow();
    expect(ctx.doctorOk).toBe(false);
  });

  it('marks skipped when cliPath is empty', () => {
    const ctx = baseCtx();
    const step = stepDoctorVerify({ cliPath: '' });
    step.execute(ctx);
    expect(ctx.doctorOk).toBe(false);
    expect(ctx.doctorReport).toMatchObject({ skipped: true });
  });
});
