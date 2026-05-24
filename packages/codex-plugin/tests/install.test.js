import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeInstall, resolvePluginIdentifier } from '../bin/install.js';

function makeOkCliCheck(version = '3.7.1') {
  return async () => ({ ok: true, version });
}
function makeFailCliCheck() {
  return async () => ({ ok: false, message: 'CLI not found' });
}
function makeRunAuth(exitCode = 0) {
  const calls = [];
  const runAuth = async () => {
    calls.push({ fn: 'runAuth' });
    return exitCode;
  };
  return { runAuth, calls };
}
function makeSpawn(exitCode = 0) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve(exitCode);
  };
  return { spawn, calls };
}

const TEST_ROOT = '/fake/codex-plugin';

describe('makeInstall', () => {
  it('skips npm install when CLI is already present', async () => {
    const { spawn, calls } = makeSpawn(0);
    const auth = makeRunAuth(0);
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 0);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0], { cmd: 'codex', args: ['plugin', 'marketplace', 'add', TEST_ROOT] });
    assert.deepEqual(calls[1], { cmd: 'codex', args: ['plugin', 'remove', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[2], { cmd: 'codex', args: ['plugin', 'add', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[3], { cmd: 'switchbot', args: ['doctor'] });
    assert.equal(auth.calls.length, 1);
  });

  it('runs npm install first when CLI is missing, then registers and adds plugin', async () => {
    const { spawn, calls } = makeSpawn(0);
    const auth = makeRunAuth(0);
    const install = makeInstall({
      checkCli: makeFailCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 0);
    assert.equal(calls.length, 5);
    assert.deepEqual(calls[0], { cmd: 'npm', args: ['install', '-g', '@switchbot/openapi-cli@latest'] });
    assert.deepEqual(calls[1], { cmd: 'codex', args: ['plugin', 'marketplace', 'add', TEST_ROOT] });
    assert.deepEqual(calls[2], { cmd: 'codex', args: ['plugin', 'remove', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[3], { cmd: 'codex', args: ['plugin', 'add', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[4], { cmd: 'switchbot', args: ['doctor'] });
    assert.equal(auth.calls.length, 1);
  });

  it('exits with npm install exit code and stops when CLI install fails', async () => {
    const { spawn, calls } = makeSpawn(1);
    const auth = makeRunAuth(0);
    const install = makeInstall({
      checkCli: makeFailCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cmd: 'npm', args: ['install', '-g', '@switchbot/openapi-cli@latest'] });
    assert.equal(auth.calls.length, 0);
  });

  it('exits with marketplace add exit code and stops when registration fails', async () => {
    let callCount = 0;
    const auth = makeRunAuth(0);
    const spawn = (cmd, args) => {
      callCount++;
      return Promise.resolve(callCount === 1 ? 2 : 0);
    };
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 2);
    assert.equal(callCount, 1);
    assert.equal(auth.calls.length, 0);
  });

  it('propagates plugin add exit code', async () => {
    let callCount = 0;
    const auth = makeRunAuth(0);
    const spawn = (cmd, args) => {
      callCount++;
      return Promise.resolve(callCount === 3 ? 3 : 0);
    };
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 3);
    assert.equal(callCount, 3);
    assert.equal(auth.calls.length, 0);
  });

  it('propagates auth exit code after plugin install succeeds', async () => {
    const { spawn, calls } = makeSpawn(0);
    const auth = makeRunAuth(4);
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 4);
    assert.equal(calls.length, 3);
    assert.equal(auth.calls.length, 1);
  });

  it('propagates final doctor exit code after auth succeeds', async () => {
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(cmd === 'switchbot' ? 5 : 0);
    };
    const auth = makeRunAuth(0);
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 5);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[3], { cmd: 'switchbot', args: ['doctor'] });
    assert.equal(auth.calls.length, 1);
  });

  it('returns 127 with a codex-specific message when codex is missing', async () => {
    let callCount = 0;
    const auth = makeRunAuth(0);
    const spawn = () => {
      callCount++;
      return Promise.resolve(127);
    };
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 127);
    assert.equal(callCount, 1);
    assert.equal(auth.calls.length, 0);
  });

  it('returns 1 with a prefixed message when resolveMarketplaceSourceRoot throws', async () => {
    const auth = makeRunAuth(0);
    const { spawn } = makeSpawn(0);
    const errChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { errChunks.push(String(chunk)); return true; };

    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
      resolveRoot: () => {
        throw new Error('alias path /home/user/.switchbot/codex-plugin-marketplace exists and is not a symlink/junction; remove it manually and retry');
      },
    });
    const code = await install();
    process.stderr.write = origWrite;

    assert.equal(code, 1);
    const combined = errChunks.join('');
    assert.ok(combined.includes('[switchbot-codex]'), `expected [switchbot-codex] prefix in: ${combined}`);
    assert.ok(combined.includes('codex-plugin-marketplace'), `expected alias path in: ${combined}`);
  });
});

describe('resolvePluginIdentifier', () => {
  it('falls back to basename when the plugin manifest is unavailable', () => {
    assert.equal(resolvePluginIdentifier('/fake/codex-plugin'), 'switchbot@codex-plugin');
  });
});
