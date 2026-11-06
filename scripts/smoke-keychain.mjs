#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { selectCredentialStore } from '../src/credentials/keychain.ts';

if (process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Native keychain smoke requires an isolated GitHub Actions runner.');
}
const expected = { linux: 'secret-service', darwin: 'keychain', win32: 'credman' }[process.platform];
assert.ok(expected, `Unsupported keychain smoke platform: ${process.platform}`);
const store = await selectCredentialStore();
assert.equal(store.name, expected, 'Native keychain is required; file fallback is not a passing smoke.');
const profile = `ci-${randomUUID()}`;
assert.equal(await store.get(profile), null);
try {
  const initial = { token: 'ci-dummy-token-A', secret: 'ci-dummy-secret-A' };
  await store.set(profile, initial);
  assert.deepEqual(await store.get(profile), initial);
  const replacement = { token: 'ci-dummy-token-B', secret: 'ci-dummy-secret-B' };
  await store.set(profile, replacement);
  assert.deepEqual(await store.get(profile), replacement);
} finally {
  await store.delete(profile);
}
assert.equal(await store.get(profile), null);
console.log(JSON.stringify({ backend: store.name, checks: ['create', 'replace', 'delete'] }));
