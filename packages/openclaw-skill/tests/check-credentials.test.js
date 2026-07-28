import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCheckCredentials } from '../setup/check-credentials.js';

function execReturningDoctor(configured) {
  return async (_cmd, args) => {
    if (args[0] === 'doctor') {
      return { stdout: JSON.stringify({ data: { credentials: { configured } } }) };
    }
    throw Object.assign(new Error('keychain error'), { code: 1 });
  };
}

function execDoctorFails() {
  return async (_cmd, args) => {
    if (args[0] === 'doctor') {
      const err = new Error('non-zero exit');
      err.code = 1;
      throw err;
    }
    throw Object.assign(new Error('keychain error'), { code: 1 });
  };
}

function execCliMissing() {
  return async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
}

function execKeychainOk() {
  return async (_cmd, args) => {
    if (args[0] === 'doctor') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    if (args[1] === 'keychain') return { stdout: '{}' };
    throw new Error('unexpected');
  };
}

describe('makeCheckCredentials', () => {
  it('returns ok:true when doctor says configured', async () => {
    const check = makeCheckCredentials(execReturningDoctor(true));
    assert.deepEqual(await check(), { ok: true });
  });

  it('returns auth-not-configured when doctor says not configured and keychain fails', async () => {
    const check = makeCheckCredentials(execReturningDoctor(false));
    const result = await check();
    assert.equal(result.ok, false);
    assert.match(result.message, /credentials are not configured/);
    assert.match(result.message, /switchbot auth login/);
  });

  it('returns token-expired when doctor command exits non-zero', async () => {
    const check = makeCheckCredentials(execDoctorFails());
    const result = await check();
    assert.equal(result.ok, false);
    assert.match(result.message, /doctor check failed/);
    assert.match(result.message, /auth logout/);
  });

  it('returns ok:true when CLI missing but keychain succeeds', async () => {
    const check = makeCheckCredentials(execKeychainOk());
    assert.deepEqual(await check(), { ok: true });
  });

  it('returns auth-not-configured when CLI missing and keychain fails', async () => {
    const check = makeCheckCredentials(execCliMissing());
    const result = await check();
    assert.equal(result.ok, false);
    assert.match(result.message, /credentials are not configured/);
  });
});
