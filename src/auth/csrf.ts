import crypto from 'node:crypto';

/** 32-byte random hex string used as CSRF state parameter in OAuth flows. */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}
