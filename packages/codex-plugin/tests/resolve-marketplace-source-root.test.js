import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMarketplaceSourceRoot } from '../bin/install.js';

const SCOPED_ROOT = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@switchbot\\codex-plugin';

function makeDeps(overrides = {}) {
  return {
    mkdirSync: () => undefined,
    lstatSync: () => null,
    realpathSync: (p) => p,
    symlinkSync: () => undefined,
    unlinkSync: () => undefined,
    ...overrides,
  };
}

describe('resolveMarketplaceSourceRoot', () => {
  it('returns packageRoot unchanged on non-Windows or non-scoped paths', () => {
    const calls = [];
    const deps = makeDeps({
      mkdirSync: () => calls.push('mkdir'),
      symlinkSync: () => calls.push('symlink'),
    });
    if (process.platform === 'win32') {
      assert.equal(resolveMarketplaceSourceRoot('C:\\plain\\path', deps), 'C:\\plain\\path');
    } else {
      assert.equal(resolveMarketplaceSourceRoot(SCOPED_ROOT, deps), SCOPED_ROOT);
    }
    assert.deepEqual(calls, []);
  });

  it('creates a junction when the alias is missing (win32 only)', { skip: process.platform !== 'win32' }, () => {
    const created = [];
    const deps = makeDeps({
      lstatSync: () => null,
      mkdirSync: (p) => created.push(['mkdir', p]),
      symlinkSync: (target, link) => created.push(['symlink', target, link]),
    });
    const resolved = resolveMarketplaceSourceRoot(SCOPED_ROOT, deps);
    assert.match(resolved, /codex-plugin-marketplace$/);
    assert.equal(created.length, 2);
    assert.equal(created[0][0], 'mkdir');
    assert.equal(created[1][0], 'symlink');
    assert.equal(created[1][1], SCOPED_ROOT);
  });

  it('reuses a healthy junction (win32 only)', { skip: process.platform !== 'win32' }, () => {
    const calls = [];
    const deps = makeDeps({
      lstatSync: () => ({ isSymbolicLink: () => true }),
      realpathSync: () => SCOPED_ROOT,
      symlinkSync: () => calls.push('symlink'),
      unlinkSync: () => calls.push('unlink'),
    });
    const resolved = resolveMarketplaceSourceRoot(SCOPED_ROOT, deps);
    assert.match(resolved, /codex-plugin-marketplace$/);
    assert.deepEqual(calls, []);
  });

  it('repairs a stale junction (win32 only)', { skip: process.platform !== 'win32' }, () => {
    const calls = [];
    const realpaths = ['D:\\old\\@switchbot\\codex-plugin', SCOPED_ROOT];
    const deps = makeDeps({
      lstatSync: () => ({ isSymbolicLink: () => true }),
      realpathSync: () => realpaths.shift(),
      unlinkSync: (p) => calls.push(['unlink', p]),
      symlinkSync: (target, link) => calls.push(['symlink', target, link]),
    });
    const resolved = resolveMarketplaceSourceRoot(SCOPED_ROOT, deps);
    assert.match(resolved, /codex-plugin-marketplace$/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0][0], 'unlink');
    assert.equal(calls[1][0], 'symlink');
    assert.equal(calls[1][1], SCOPED_ROOT);
  });

  it('throws on a real directory at the alias path (win32 only)', { skip: process.platform !== 'win32' }, () => {
    const deps = makeDeps({
      lstatSync: () => ({ isSymbolicLink: () => false }),
    });
    assert.throws(() => resolveMarketplaceSourceRoot(SCOPED_ROOT, deps), /exists and is not a junction/);
  });

  it('aliases Linux npm @scope package paths', () => {
    const savedPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const target = '/home/me/.npm-global/lib/node_modules/@switchbot/codex-plugin';
      const created = [];
      const deps = makeDeps({
        lstatSync: () => null,
        mkdirSync: (p) => created.push(['mkdir', p]),
        symlinkSync: (from, to, type) => created.push(['symlink', from, to, type]),
      });
      const resolved = resolveMarketplaceSourceRoot(target, deps);
      assert.match(resolved, /codex-plugin-marketplace$/);
      assert.equal(created[1][1], target);
      assert.equal(created[1][3], 'dir');
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
    }
  });

  it('aliases Linux custom-prefix path with no node_modules segment', () => {
    const savedPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const target = '/home/me/.local/lib/@switchbot/codex-plugin';
      const created = [];
      const deps = makeDeps({
        lstatSync: () => null,
        mkdirSync: (p) => created.push(['mkdir', p]),
        symlinkSync: (from, to, type) => created.push(['symlink', from, to, type]),
      });
      const resolved = resolveMarketplaceSourceRoot(target, deps);
      assert.match(resolved, /codex-plugin-marketplace$/);
      assert.equal(created[1][1], target);
      assert.equal(created[1][3], 'dir');
    } finally {
      Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
    }
  });
});
