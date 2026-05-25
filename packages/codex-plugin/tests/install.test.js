import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    // Order: plugin remove×2, marketplace remove×3, marketplace add, plugin add, doctor
    assert.equal(calls.length, 8);
    assert.deepEqual(calls[0], { cmd: 'codex', args: ['plugin', 'remove', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[1], { cmd: 'codex', args: ['plugin', 'remove', 'switchbot@switchbot-skill'] });
    assert.deepEqual(calls[2], { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'switchbot'] });
    assert.deepEqual(calls[3], { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'codex-plugin'] });
    assert.deepEqual(calls[4], { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'switchbot-skill'] });
    assert.deepEqual(calls[5], { cmd: 'codex', args: ['plugin', 'marketplace', 'add', TEST_ROOT] });
    assert.deepEqual(calls[6], { cmd: 'codex', args: ['plugin', 'add', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[7], { cmd: 'switchbot', args: ['doctor'] });
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
    // Order: npm install, plugin remove×2, marketplace remove×3, marketplace add, plugin add, doctor
    assert.equal(calls.length, 9);
    assert.deepEqual(calls[0], { cmd: 'npm', args: ['install', '-g', '@switchbot/openapi-cli@latest'] });
    assert.deepEqual(calls[1], { cmd: 'codex', args: ['plugin', 'remove', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[2], { cmd: 'codex', args: ['plugin', 'remove', 'switchbot@switchbot-skill'] });
    assert.deepEqual(calls[3], { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'switchbot'] });
    assert.deepEqual(calls[4], { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'codex-plugin'] });
    assert.deepEqual(calls[5], { cmd: 'codex', args: ['plugin', 'marketplace', 'remove', 'switchbot-skill'] });
    assert.deepEqual(calls[6], { cmd: 'codex', args: ['plugin', 'marketplace', 'add', TEST_ROOT] });
    assert.deepEqual(calls[7], { cmd: 'codex', args: ['plugin', 'add', 'switchbot@codex-plugin'] });
    assert.deepEqual(calls[8], { cmd: 'switchbot', args: ['doctor'] });
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
      // calls 1-2: plugin removes (warn+continue), 3-5: marketplace removes (warn+continue)
      // call 6: marketplace add — fail
      return Promise.resolve(callCount === 6 ? 2 : 0);
    };
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 2);
    assert.equal(callCount, 6);
    assert.equal(auth.calls.length, 0);
  });

  it('propagates plugin add exit code', async () => {
    let callCount = 0;
    const auth = makeRunAuth(0);
    const spawn = (cmd, args) => {
      callCount++;
      // calls: 1-2=plugin removes, 3-5=marketplace removes, 6=marketplace add, 7=plugin add
      return Promise.resolve(callCount === 7 ? 3 : 0);
    };
    const install = makeInstall({
      checkCli: makeOkCliCheck(),
      runInherit: spawn,
      packageRoot: TEST_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 3);
    assert.equal(callCount, 7);
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
    // plugin remove×2, marketplace remove×3, marketplace add, plugin add (no doctor — auth failed)
    assert.equal(calls.length, 7);
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
    // plugin remove×2, marketplace remove×3, marketplace add, plugin add, doctor
    assert.equal(calls.length, 8);
    assert.deepEqual(calls[7], { cmd: 'switchbot', args: ['doctor'] });
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
    // plugin remove×2 and marketplace remove×3 warn+continue; marketplace add returns 127 → stops
    assert.equal(callCount, 6);
    assert.equal(auth.calls.length, 0);
  });

  it('returns 1 with a prefixed message when resolveMarketplaceSourceRoot throws', async () => {
    const auth = makeRunAuth(0);
    const { spawn } = makeSpawn(0);
    const errChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { errChunks.push(String(chunk)); return true; };

    let code;
    try {
      const install = makeInstall({
        checkCli: makeOkCliCheck(),
        runInherit: spawn,
        packageRoot: TEST_ROOT,
        runAuth: auth.runAuth,
        resolveRoot: () => {
          throw new Error('alias path /home/user/.switchbot/codex-plugin-marketplace exists and is not a symlink/junction; remove it manually and retry');
        },
      });
      code = await install();
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(code, 1);
    const combined = errChunks.join('');
    assert.ok(combined.includes('[switchbot-codex]'), `expected [switchbot-codex] prefix in: ${combined}`);
    assert.ok(combined.includes('codex-plugin-marketplace'), `expected alias path in: ${combined}`);
  });

  it('logs a warning and continues when plugin remove exits non-zero', async () => {
    let callCount = 0;
    const spawn = (cmd, args) => {
      callCount++;
      // calls: 1=plugin remove current, 2=plugin remove legacy → fail, rest succeed
      return Promise.resolve(callCount === 2 ? 1 : 0);
    };
    const auth = makeRunAuth(0);
    const errChunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { errChunks.push(String(chunk)); return true; };

    let code;
    try {
      const install = makeInstall({
        checkCli: makeOkCliCheck(),
        runInherit: spawn,
        packageRoot: TEST_ROOT,
        runAuth: auth.runAuth,
      });
      code = await install();
    } finally {
      process.stderr.write = origWrite;
    }

    assert.equal(code, 0, 'install should still succeed');
    // plugin remove×2, marketplace remove×3, marketplace add, plugin add, doctor
    assert.equal(callCount, 8, 'all eight spawn calls should be made');
    const combined = errChunks.join('');
    assert.ok(
      combined.includes('Warning') && combined.includes('remove') && combined.includes('exited'),
      `expected warning about remove exit code in: ${combined}`,
    );
  });

  it('fresh install from the current package root registers switchbot@switchbot', async () => {
    const { spawn, calls } = makeSpawn(0);
    const auth = makeRunAuth(0);
    const install = makeInstall({
      checkCli: makeFailCliCheck(),
      runInherit: spawn,
      packageRoot: PACKAGE_ROOT,
      runAuth: auth.runAuth,
    });
    const code = await install();
    assert.equal(code, 0);
    assert.ok(
      calls.some(({ cmd, args }) =>
        cmd === 'codex' &&
        args[0] === 'plugin' &&
        args[1] === 'add' &&
        args[2] === 'switchbot@switchbot'),
      `expected plugin add switchbot@switchbot in calls: ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.some(({ cmd, args }) =>
        cmd === 'codex' &&
        args[0] === 'plugin' &&
        args[1] === 'marketplace' &&
        args[2] === 'add' &&
        args[3] === PACKAGE_ROOT),
      `expected marketplace add ${PACKAGE_ROOT} in calls: ${JSON.stringify(calls)}`,
    );
  });
});

describe('resolvePluginIdentifier', () => {
  it('falls back to basename when the plugin manifest is unavailable', () => {
    assert.equal(resolvePluginIdentifier('/fake/codex-plugin'), 'switchbot@codex-plugin');
  });

  it('uses the published marketplace manifest from the current package root', () => {
    assert.equal(resolvePluginIdentifier(PACKAGE_ROOT), 'switchbot@switchbot');
  });
});
