import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileBackend } from '../../../src/credentials/backends/file.js';

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-file-backend-'));
  process.env.HOME = tmpHome;
  // On Windows os.homedir() uses USERPROFILE; keep both in sync for tests.
  if (process.platform === 'win32') {
    process.env.USERPROFILE = tmpHome;
  }
});

afterEach(() => {
  process.env.HOME = originalHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('file backend — describe', () => {
  it('identifies itself as the file backend and claims to be writable', () => {
    const backend = createFileBackend();
    const desc = backend.describe();
    expect(desc.tag).toBe('file');
    expect(desc.writable).toBe(true);
    expect(desc.backend).toMatch(/File/);
  });

  it('exposes the file tag on the store name', () => {
    expect(createFileBackend().name).toBe('file');
  });
});

describe('file backend — default profile round-trip', () => {
  it('writes token/secret to ~/.switchbot/config.json and reads them back', async () => {
    const backend = createFileBackend();
    await backend.set('default', { token: 't-abc', secret: 's-xyz' });
    const read = await backend.get('default');
    expect(read).toEqual({ token: 't-abc', secret: 's-xyz' });

    const file = path.join(tmpHome, '.switchbot', 'config.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('preserves existing label/description/limits when overwriting credentials', async () => {
    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        token: 'old-token',
        secret: 'old-secret',
        label: 'my account',
        description: 'primary',
        limits: { dailyCap: 100 },
      }),
      { mode: 0o600 },
    );

    const backend = createFileBackend();
    await backend.set('default', { token: 'new-token', secret: 'new-secret' });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.token).toBe('new-token');
    expect(parsed.secret).toBe('new-secret');
    expect(parsed.label).toBe('my account');
    expect(parsed.description).toBe('primary');
    expect(parsed.limits).toEqual({ dailyCap: 100 });
  });
});

describe('file backend — named profile', () => {
  it('writes a named profile under ~/.switchbot/profiles/<name>.json', async () => {
    const backend = createFileBackend();
    await backend.set('work', { token: 't1', secret: 's1' });
    const file = path.join(tmpHome, '.switchbot', 'profiles', 'work.json');
    expect(fs.existsSync(file)).toBe(true);
    const read = await backend.get('work');
    expect(read).toEqual({ token: 't1', secret: 's1' });
  });

  it('returns null for a profile that has no file yet', async () => {
    const backend = createFileBackend();
    expect(await backend.get('does-not-exist')).toBeNull();
  });

  it('returns null for a file missing token or secret', async () => {
    const file = path.join(tmpHome, '.switchbot', 'profiles', 'partial.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ token: 'only-token' }));

    const backend = createFileBackend();
    expect(await backend.get('partial')).toBeNull();
  });

  it('returns null when the JSON is corrupt', async () => {
    const file = path.join(tmpHome, '.switchbot', 'profiles', 'broken.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not-valid-json{');

    const backend = createFileBackend();
    expect(await backend.get('broken')).toBeNull();
  });
});

describe('file backend — delete', () => {
  it('removes both credentials but keeps sibling metadata', async () => {
    const file = path.join(tmpHome, '.switchbot', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({
        token: 't',
        secret: 's',
        label: 'keep me',
      }),
    );

    const backend = createFileBackend();
    await backend.delete('default');
    expect(fs.existsSync(file)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.token).toBeUndefined();
    expect(parsed.secret).toBeUndefined();
    expect(parsed.label).toBe('keep me');
  });

  it('unlinks the file when nothing else is stored in it', async () => {
    const backend = createFileBackend();
    await backend.set('solo', { token: 't', secret: 's' });
    const file = path.join(tmpHome, '.switchbot', 'profiles', 'solo.json');
    expect(fs.existsSync(file)).toBe(true);

    await backend.delete('solo');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('is a no-op when the profile does not exist', async () => {
    const backend = createFileBackend();
    await expect(backend.delete('ghost')).resolves.toBeUndefined();
  });
});
