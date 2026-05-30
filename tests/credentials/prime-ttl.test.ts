import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/credentials/keychain.js', () => ({
  selectCredentialStore: vi.fn(),
}));

import { selectCredentialStore } from '../../src/credentials/keychain.js';
import {
  primeCredentials,
  getPrimedCredentials,
  __resetPrimedCredentials,
} from '../../src/credentials/prime.js';

const mockSelectStore = vi.mocked(selectCredentialStore);

beforeEach(() => {
  __resetPrimedCredentials();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('primeCredentials TTL', () => {
  it('re-reads keychain after TTL expires', async () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), describe: vi.fn() };
    store.get.mockResolvedValueOnce({ token: 'old-token', secret: 'old-secret' });
    store.get.mockResolvedValueOnce({ token: 'new-token', secret: 'new-secret' });
    mockSelectStore.mockResolvedValue(store as never);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')?.token).toBe('old-token');
    expect(store.get).toHaveBeenCalledTimes(1);

    // Advance time past TTL (5 seconds)
    vi.advanceTimersByTime(6_000);

    await primeCredentials('default');
    expect(store.get).toHaveBeenCalledTimes(2);
    expect(getPrimedCredentials('default')?.token).toBe('new-token');
  });

  it('uses cache within TTL window', async () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), describe: vi.fn() };
    store.get.mockResolvedValue({ token: 'tok', secret: 'sec' });
    mockSelectStore.mockResolvedValue(store as never);

    await primeCredentials('default');
    vi.advanceTimersByTime(2_000); // Within TTL
    await primeCredentials('default');

    expect(store.get).toHaveBeenCalledTimes(1);
  });

  it('re-reads immediately when profile changes', async () => {
    const store = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), describe: vi.fn() };
    store.get.mockResolvedValue({ token: 'tok', secret: 'sec' });
    mockSelectStore.mockResolvedValue(store as never);

    await primeCredentials('default');
    await primeCredentials('work');

    expect(store.get).toHaveBeenCalledTimes(2);
  });
});
