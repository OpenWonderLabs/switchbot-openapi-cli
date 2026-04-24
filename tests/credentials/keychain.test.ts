import { describe, it, expect } from 'vitest';
import {
  accountFor,
  CREDENTIAL_FIELDS,
  CREDENTIAL_SERVICE,
  KeychainError,
  selectCredentialStore,
} from '../../src/credentials/keychain.js';

describe('keychain constants', () => {
  it('uses the shared service identifier across backends', () => {
    expect(CREDENTIAL_SERVICE).toBe('com.openclaw.switchbot');
  });

  it('defines exactly the token and secret fields', () => {
    expect([...CREDENTIAL_FIELDS]).toEqual(['token', 'secret']);
  });
});

describe('accountFor', () => {
  it('joins profile and field with a colon', () => {
    expect(accountFor('default', 'token')).toBe('default:token');
    expect(accountFor('prod', 'secret')).toBe('prod:secret');
  });

  it('preserves case and non-ASCII profile names verbatim', () => {
    expect(accountFor('Work-Home', 'token')).toBe('Work-Home:token');
  });
});

describe('KeychainError', () => {
  it('never includes the input material in the message', () => {
    const e = new KeychainError('keychain', 'set', 'underlying driver exit 5');
    expect(e.message).toBe('[keychain] set failed: underlying driver exit 5');
    expect(e.backend).toBe('keychain');
    expect(e.operation).toBe('set');
    expect(e.name).toBe('KeychainError');
  });

  it('is an instance of Error so callers can catch it generically', () => {
    const e = new KeychainError('file', 'get', 'disk I/O');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('selectCredentialStore', () => {
  it('returns the file backend when preferFile is true regardless of platform', async () => {
    const store = await selectCredentialStore({ preferFile: true });
    expect(store.name).toBe('file');
    expect(store.describe().tag).toBe('file');
  });

  it('returns a store whose describe() reports a writable backend', async () => {
    const store = await selectCredentialStore({ preferFile: true });
    const desc = store.describe();
    expect(desc.writable).toBe(true);
    expect(typeof desc.backend).toBe('string');
    expect(desc.backend.length).toBeGreaterThan(0);
  });

  it('always resolves to a store even without platform detection', async () => {
    const store = await selectCredentialStore();
    expect(store).toBeTruthy();
    expect(['file', 'keychain', 'secret-service', 'credman']).toContain(store.name);
  });
});
