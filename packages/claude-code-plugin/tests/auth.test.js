import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeRunOnInstall } from '../bin/auth.js';

function makeOkCliCheck(version = '3.7.1') {
  return async () => ({ ok: true, version });
}
function makeFailCliCheck(msg = 'switchbot CLI not found. Install with: npm install -g @switchbot/openapi-cli@latest') {
  return async () => ({ ok: false, message: msg });
}
function makeOkCredCheck(source = 'keychain') {
  return async () => ({ ok: true, source });
}
function makeFailCredCheck(errorKey = 'auth-not-configured') {
  return async () => ({ ok: false, errorKey, message: `Error: no creds (${errorKey})` });
}
function makeSpawn(exitCode = 0) {
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    return Promise.resolve(exitCode);
  };
  return { spawn, calls };
}

async function captureStderr(fn) {
  const originalWrite = process.stderr.write;
  let output = '';
  process.stderr.write = ((chunk, encoding, callback) => {
    output += String(chunk);
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  });
  try {
    return { code: await fn(), output };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe('runOnInstall', () => {
  it('exits 1 when CLI is missing', async () => {
    const { spawn, calls } = makeSpawn(0);
    const run = makeRunOnInstall({
      checkCli: makeFailCliCheck(),
      checkCredentials: makeOkCredCheck(),
      runInherit: spawn,
    });
    const result = await captureStderr(() => run());
    assert.equal(result.code, 1);
    assert.equal(calls.length, 0);
    assert.match(result.output, /npm install -g @switchbot\/openapi-cli/);
  });

  it('exits 0 when credentials are already present', async () => {
    const { spawn, calls } = makeSpawn(0);
    const run = makeRunOnInstall({
      checkCli: makeOkCliCheck(),
      checkCredentials: makeOkCredCheck('doctor'),
      runInherit: spawn,
    });
    const result = await captureStderr(() => run());
    assert.equal(result.code, 0);
    assert.equal(calls.length, 0);
    assert.match(result.output, /Setup complete/);
  });

  it('runs auth login and exits 0 when credentials missing but login succeeds', async () => {
    const { spawn, calls } = makeSpawn(0);
    let credCallCount = 0;
    const checkCredentials = async () => {
      credCallCount++;
      if (credCallCount === 1) return { ok: false, errorKey: 'auth-not-configured', message: 'not configured' };
      return { ok: true, source: 'keychain' };
    };
    const run = makeRunOnInstall({
      checkCli: makeOkCliCheck(),
      checkCredentials,
      runInherit: spawn,
    });
    const result = await captureStderr(() => run());
    assert.equal(result.code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cmd: 'switchbot', args: ['auth', 'login'] });
    assert.equal(credCallCount, 2);
    assert.match(result.output, /Setup complete/);
  });

  it('exits with login exit code when auth login fails', async () => {
    const { spawn, calls } = makeSpawn(1);
    const run = makeRunOnInstall({
      checkCli: makeOkCliCheck(),
      checkCredentials: makeFailCredCheck(),
      runInherit: spawn,
    });
    const result = await captureStderr(() => run());
    assert.equal(result.code, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { cmd: 'switchbot', args: ['auth', 'login'] });
    assert.match(result.output, /Login failed|auth-login-failed/i);
  });

  it('exits 1 when post-login credential check fails', async () => {
    const { spawn } = makeSpawn(0);
    let credCallCount = 0;
    const checkCredentials = async () => {
      credCallCount++;
      return { ok: false, errorKey: 'auth-not-configured', message: 'Error: still not configured' };
    };
    const run = makeRunOnInstall({
      checkCli: makeOkCliCheck(),
      checkCredentials,
      runInherit: spawn,
    });
    const result = await captureStderr(() => run());
    assert.equal(result.code, 1);
    assert.equal(credCallCount, 2);
    assert.match(result.output, /still not configured/);
  });
});
