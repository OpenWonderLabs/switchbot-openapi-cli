import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getConfigPath } from '../utils/flags.js';
import { getActiveProfile } from '../lib/request-context.js';

export interface CredentialScope {
  key: string;
  cacheDir: string;
  revision: string;
  requireKeychain: boolean;
}

const REVISION_FILE = '.credential-revision';

/** Resolve the existing cache storage scope without creating files on reads. */
export function readCredentialScope(profile = getActiveProfile(), ignoreConfigOverride = false): CredentialScope {
  const override = ignoreConfigOverride ? undefined : getConfigPath();
  let cacheDir = override
    ? path.dirname(path.resolve(override))
    : path.join(os.homedir(), '.switchbot');
  if (!override && profile !== undefined && profile !== 'default') {
    const hash = createHash('sha256').update(profile).digest('hex');
    cacheDir = path.join(cacheDir, 'cache', hash);
  }
  let revision: string;
  try {
    revision = fs.readFileSync(path.join(cacheDir, REVISION_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    revision = '';
  }
  return { key: cacheDir, cacheDir, revision, requireKeychain: revision.startsWith('keychain:') };
}

export class CredentialScopeChangedError extends Error {
  constructor() {
    super('Credentials changed during this operation; retry explicitly with the current account.');
    this.name = 'CredentialScopeChangedError';
  }
}

/** Never complete an old-account operation under a replacement account. */
export function assertCredentialScope(expected: CredentialScope, profile = getActiveProfile()): void {
  const current = readCredentialScope(profile);
  if (current.key !== expected.key || current.revision !== expected.revision) {
    throw new CredentialScopeChangedError();
  }
}

/** Publish only after old account caches have been removed. Contains no secrets. */
export function publishCredentialRevision(scope: CredentialScope, requireKeychain = false): void {
  fs.mkdirSync(scope.cacheDir, { recursive: true, mode: 0o700 });
  const revision = randomUUID();
  const temporary = path.join(scope.cacheDir, `${REVISION_FILE}.${revision}.tmp`);
  try {
    fs.writeFileSync(temporary, requireKeychain ? `keychain:${revision}` : revision, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, path.join(scope.cacheDir, REVISION_FILE));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
