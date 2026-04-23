import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { WebhookTokenStore, generateToken } from '../../src/rules/webhook-token.js';

describe('WebhookTokenStore', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-token-'));
    file = path.join(tmpDir, 'webhook-token');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates a 64-char hex token on first call and persists it', () => {
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => undefined });
    const t = store.getOrCreate();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const onDisk = fs.readFileSync(file, 'utf-8').trim();
    expect(onDisk).toBe(t);
  });

  it('returns the same token on subsequent calls', () => {
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => undefined });
    const a = store.getOrCreate();
    const b = store.getOrCreate();
    expect(b).toBe(a);
  });

  it('env var wins over on-disk token', () => {
    fs.writeFileSync(file, 'from-disk\n', { mode: 0o600 });
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => 'from-env' });
    expect(store.getOrCreate()).toBe('from-env');
  });

  it('rotate() replaces the persisted token', () => {
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => undefined });
    const original = store.getOrCreate();
    const fresh = store.rotate();
    expect(fresh).not.toBe(original);
    expect(fs.readFileSync(file, 'utf-8').trim()).toBe(fresh);
  });

  it('readFromDisk returns null when the file is absent', () => {
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => undefined });
    expect(store.readFromDisk()).toBeNull();
  });

  it('readFromDisk trims whitespace', () => {
    fs.writeFileSync(file, '  abcd  \n\n');
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => undefined });
    expect(store.readFromDisk()).toBe('abcd');
  });

  it('getOrCreate ignores an empty env value', () => {
    fs.writeFileSync(file, 'from-disk\n', { mode: 0o600 });
    const store = new WebhookTokenStore({ filePath: file, envLookup: () => '   ' });
    expect(store.getOrCreate()).toBe('from-disk');
  });

  it('generateToken returns 64-char hex', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});
