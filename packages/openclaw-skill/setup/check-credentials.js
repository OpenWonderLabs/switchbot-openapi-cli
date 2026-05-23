import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from '../lib/error-messages.js';

async function tryDoctor(exec) {
  try {
    const { stdout } = await exec('switchbot', ['doctor', '--json'], { timeout: 10000 });
    const parsed = JSON.parse(stdout);
    const data = parsed?.data ?? parsed;
    return data?.credentials?.configured === true
      ? { ok: true }
      : { ok: false, reason: 'not-configured' };
  } catch (err) {
    if (err?.code === 'ENOENT') throw err;
    return { ok: false, reason: 'doctor-failed' };
  }
}

async function tryKeychainDescribe(exec) {
  try {
    await exec('switchbot', ['auth', 'keychain', 'describe', '--json'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

export function makeCheckCredentials(exec) {
  return async function checkCredentials() {
    let doctorResult = null;
    try {
      doctorResult = await tryDoctor(exec);
      if (doctorResult.ok) return { ok: true };
    } catch {
      // CLI missing — fall through to keychain
    }

    // Doctor ran but exited non-zero → likely token expired
    if (doctorResult?.reason === 'doctor-failed') {
      return { ok: false, message: formatError('token-expired') };
    }

    // Doctor says not configured, or CLI missing — try keychain as fallback
    if (await tryKeychainDescribe(exec)) return { ok: true };

    return { ok: false, message: formatError('auth-not-configured') };
  };
}

const defaultExec = promisify(execFile);
export const checkCredentials = makeCheckCredentials(defaultExec);
