import crypto from 'node:crypto';

/** 32-byte random hex string for CSRF state parameter. */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}
