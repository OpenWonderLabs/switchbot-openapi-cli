// packages/codex-plugin/setup/check-credentials.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from '../lib/error-messages.js';

const AUTH_FAILURE_PATTERNS = [
  /\b401\b/i,
  /\b403\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
  /\bauth(?:entication)? failed\b/i,
  /\btoken\b.*\bexpired\b/i,
  /\bexpired\b.*\btoken\b/i,
  /\binvalid\b.*\b(token|secret|credential|credentials)\b/i,
  /\b(credentials?|login)\b.*\b(required|invalid|expired|missing|failed)\b/i,
];

const NOT_CONFIGURED_PATTERNS = [
  /\bnot configured\b/i,
  /\bnot logged in\b/i,
  /\bno credentials?\b/i,
  /\blogin required\b/i,
  /\bmissing credentials?\b/i,
];

const NETWORK_FAILURE_PATTERNS = [
  /\bnetwork\b/i,
  /\bfetch failed\b/i,
  /\bdns\b/i,
  /\btimed? out\b/i,
  /\btimeout\b/i,
  /\betimedout\b/i,
  /\beconnreset\b/i,
  /\beconnrefused\b/i,
  /\benotfound\b/i,
  /\behostunreach\b/i,
];

function normalizeErrorText(err) {
  return [
    err?.stdout,
    err?.stderr,
    err?.message,
  ]
    .filter(Boolean)
    .map(value => Buffer.isBuffer(value) ? value.toString('utf8') : String(value))
    .join('\n');
}

function matchesAny(text, patterns) {
  return patterns.some(pattern => pattern.test(text));
}

function classifyDoctorFailure(text, hasKeychain) {
  if (matchesAny(text, NOT_CONFIGURED_PATTERNS)) {
    return hasKeychain ? 'credentials-invalid' : 'auth-not-configured';
  }

  if (matchesAny(text, AUTH_FAILURE_PATTERNS)) {
    return hasKeychain ? 'credentials-invalid' : 'auth-not-configured';
  }

  if (matchesAny(text, NETWORK_FAILURE_PATTERNS)) {
    return 'doctor-check-failed';
  }

  return hasKeychain ? 'doctor-check-failed' : 'auth-not-configured';
}

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
    return {
      ok: false,
      reason: 'doctor-failed',
      detail: normalizeErrorText(err),
    };
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
      if (doctorResult.ok) return { ok: true, source: 'doctor' };
    } catch {
      // CLI missing — fall through to keychain
    }

    const hasKeychainCredentials = await tryKeychainDescribe(exec);

    if (doctorResult?.reason === 'doctor-failed') {
      const errorKey = classifyDoctorFailure(doctorResult.detail ?? '', hasKeychainCredentials);
      return { ok: false, errorKey, message: formatError(errorKey) };
    }

    if (hasKeychainCredentials) return { ok: true, source: 'keychain' };

    return {
      ok: false,
      errorKey: 'auth-not-configured',
      message: formatError('auth-not-configured'),
    };
  };
}

const defaultExec = promisify(execFile);
export const checkCredentials = makeCheckCredentials(defaultExec);
