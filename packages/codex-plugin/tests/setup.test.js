import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { makeCheckCli } from '../setup/check-cli.js';

describe('checkCli', () => {
  it('returns ok:true when CLI is >= 3.7.1', async () => {
    const fakeExec = async () => ({ stdout: '3.7.1\n' });
    const checkCli = makeCheckCli(fakeExec);
    const result = await checkCli();
    assert.deepEqual(result, { ok: true, version: '3.7.1' });
  });

  it('returns ok:false when CLI is below minimum', async () => {
    const fakeExec = async () => ({ stdout: '3.2.9\n' });
    const checkCli = makeCheckCli(fakeExec);
    const result = await checkCli();
    assert.equal(result.ok, false);
    assert.match(result.message, /3\.2\.9/);
    assert.match(result.message, /3\.7\.1/);
  });

  it('returns ok:false when CLI is missing (ENOENT)', async () => {
    const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const fakeExec = async () => { throw err; };
    const checkCli = makeCheckCli(fakeExec);
    const result = await checkCli();
    assert.equal(result.ok, false);
    assert.match(result.message, /not found/i);
  });

  it('returns ok:false when version string is unparseable', async () => {
    const fakeExec = async () => ({ stdout: 'development\n' });
    const checkCli = makeCheckCli(fakeExec);
    const result = await checkCli();
    assert.equal(result.ok, false);
    assert.match(result.message, /Upgrade/);
  });

  it('returns ok:true when CLI is above minimum (e.g. 5.0.0)', async () => {
    const fakeExec = async () => ({ stdout: '5.0.0\n' });
    const checkCli = makeCheckCli(fakeExec);
    const result = await checkCli();
    assert.deepEqual(result, { ok: true, version: '5.0.0' });
  });

  it('returns ok:false on non-ENOENT exec error', async () => {
    const fakeExec = async () => { throw new Error('permission denied'); };
    const checkCli = makeCheckCli(fakeExec);
    const result = await checkCli();
    assert.equal(result.ok, false);
    assert.match(result.message, /permission denied/);
  });
});

import { makeCheckCredentials } from '../setup/check-credentials.js';

describe('checkCredentials', () => {
  it('returns ok:true source:doctor when doctor reports credentials.configured:true', async () => {
    const fakeExec = async (cmd, args) => {
      if (args.includes('doctor')) {
        return { stdout: JSON.stringify({ data: { credentials: { configured: true } } }) };
      }
      throw new Error('unexpected call');
    };
    const check = makeCheckCredentials(fakeExec);
    const result = await check();
    assert.deepEqual(result, { ok: true, source: 'doctor' });
  });

  it('returns credentials-invalid when doctor reports an auth failure and keychain credentials exist', async () => {
    const fakeExec = async (cmd, args) => {
      if (args.includes('doctor')) {
        const err = new Error('401 Unauthorized');
        err.stderr = 'HTTP 401 unauthorized';
        throw err;
      }
      if (args.includes('describe')) return { stdout: '{}' };
      throw new Error('unexpected');
    };
    const check = makeCheckCredentials(fakeExec);
    const result = await check();
    assert.equal(result.ok, false);
    assert.equal(result.errorKey, 'credentials-invalid');
    assert.match(result.message, /rejected/i);
    assert.match(result.message, /switchbot auth logout/);
  });

  it('returns doctor-check-failed when doctor errors look like network failures', async () => {
    const fakeExec = async (cmd, args) => {
      if (args.includes('doctor')) {
        const err = new Error('ETIMEDOUT');
        err.stderr = 'connect ETIMEDOUT api.switch-bot.com';
        throw err;
      }
      if (args.includes('describe')) return { stdout: '{}' };
      throw new Error('unexpected');
    };
    const check = makeCheckCredentials(fakeExec);
    const result = await check();
    assert.equal(result.ok, false);
    assert.equal(result.errorKey, 'doctor-check-failed');
    assert.match(result.message, /health check/i);
    assert.match(result.message, /switchbot doctor/);
  });

  it('returns ok:false when both doctor and keychain describe fail', async () => {
    const fakeExec = async () => { throw new Error('all fail'); };
    const check = makeCheckCredentials(fakeExec);
    const result = await check();
    assert.equal(result.ok, false);
    assert.equal(result.errorKey, 'auth-not-configured');
    assert.match(result.message, /switchbot auth login/);
  });

  it('never passes token or secret values to exec', async () => {
    const passedArgs = [];
    const fakeExec = async (cmd, args) => {
      passedArgs.push(...args);
      if (args.includes('doctor')) {
        return { stdout: JSON.stringify({ data: { credentials: { configured: true } } }) };
      }
      throw new Error('unexpected');
    };
    const check = makeCheckCredentials(fakeExec);
    await check();
    const sensitive = passedArgs.filter(
      (a) => typeof a === 'string' && (a.includes('token') || a.includes('secret'))
    );
    assert.deepEqual(sensitive, [], `Sensitive args leaked: ${sensitive.join(', ')}`);
  });

  it('falls back to keychain when doctor returns credentials.configured:false', async () => {
    const fakeExec = async (cmd, args) => {
      if (args.includes('doctor')) {
        return { stdout: JSON.stringify({ data: { credentials: { configured: false } } }) };
      }
      if (args.includes('describe')) return { stdout: '{}' };
      throw new Error('unexpected');
    };
    const check = makeCheckCredentials(fakeExec);
    const result = await check();
    assert.deepEqual(result, { ok: true, source: 'keychain' });
  });
});
