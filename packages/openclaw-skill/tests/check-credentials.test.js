import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeCheckCredentials } from '../setup/check-credentials.js';

function execReturningCredentialsSection(status) {
  return async (_cmd, args) => {
    if (args[0] === 'doctor') {
      assert.deepEqual(args, ['doctor', '--section', 'credentials', '--json']);
      return { stdout: JSON.stringify({ data: {
        overall: status,
        checks: [{ name: 'credentials', status, detail: { source: 'env' } }],
      } }) };
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
    if (args[1] === 'keychain') return { stdout: JSON.stringify({ data: { present: true } }) };
    throw new Error('unexpected');
  };
}

describe('makeCheckCredentials', () => {
  it('accepts a healthy credentials section independently of unrelated doctor checks', async () => {
    const check = makeCheckCredentials(execReturningCredentialsSection('ok'));
    assert.deepEqual(await check(), { ok: true });
  });

  it('rejects missing credentials even when the keychain backend is available', async () => {
    const exec = async (_cmd, args) => {
      if (args[0] === 'doctor') return { stdout: JSON.stringify({ data: {
        checks: [{ name: 'credentials', status: 'fail', detail: { source: 'none' } }],
      } }) };
      return { stdout: JSON.stringify({ data: { backend: 'file', available: true, present: false } }) };
    };
    const result = await makeCheckCredentials(exec)();
    assert.equal(result.ok, false);
  });

  it('returns auth-not-configured when doctor says not configured and keychain fails', async () => {
    const check = makeCheckCredentials(execReturningCredentialsSection('fail'));
    const result = await check();
    assert.equal(result.ok, false);
  });

  it('classifies an unusable doctor result separately from authentication failure', async () => {
    const check = makeCheckCredentials(execDoctorFails());
    const result = await check();
    assert.equal(result.ok, false);
    assert.equal(result.errorKey, 'doctor-check-failed');
  });

  it('returns ok:true when CLI missing but keychain succeeds', async () => {
    const check = makeCheckCredentials(execKeychainOk());
    assert.deepEqual(await check(), { ok: true });
  });

  it('returns auth-not-configured when CLI missing and keychain fails', async () => {
    const check = makeCheckCredentials(execCliMissing());
    const result = await check();
    assert.equal(result.ok, false);
  });
});
