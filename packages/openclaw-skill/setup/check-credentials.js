import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from '../lib/error-messages.js';
import { switchbotInvocation } from './cli-invocation.js';

function credentialsResult(stdout) {
  const parsed = JSON.parse(stdout);
  const data = parsed?.data ?? parsed;
  const credentials = data?.checks?.find((check) => check?.name === 'credentials');
  if (credentials?.status === 'ok') return { ok: true };
  return { ok: false, reason: 'not-configured' };
}

async function tryDoctor(exec) {
  try {
    const { stdout } = await exec('switchbot', ['doctor', '--section', 'credentials', '--json'], { timeout: 10000 });
    return credentialsResult(stdout);
  } catch (err) {
    if (err?.code === 'ENOENT') throw err;
    if (typeof err?.stdout === 'string') {
      try {
        return credentialsResult(err.stdout);
      } catch {
        // Fall through when a failing command did not return a doctor envelope.
      }
    }
    return { ok: false, reason: 'doctor-failed' };
  }
}

async function tryKeychainGet(exec) {
  try {
    const { stdout } = await exec('switchbot', ['auth', 'keychain', 'get', '--json'], { timeout: 8000 });
    const parsed = JSON.parse(stdout);
    return (parsed?.data ?? parsed)?.present === true;
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

    // An unusable diagnostic does not establish that a token is expired.
    if (doctorResult?.reason === 'doctor-failed') {
      return { ok: false, errorKey: 'doctor-check-failed', message: formatError('doctor-check-failed') };
    }

    // A backend description is not proof that a credential is stored.
    if (await tryKeychainGet(exec)) return { ok: true };

    return { ok: false, message: formatError('auth-not-configured') };
  };
}

const exec = promisify(execFile);
const defaultExec = (_command, args, options) => {
  const invocation = switchbotInvocation(args);
  return exec(invocation.command, invocation.args, options);
};
export const checkCredentials = makeCheckCredentials(defaultExec);
