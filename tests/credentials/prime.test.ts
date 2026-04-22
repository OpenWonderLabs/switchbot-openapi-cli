import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  primeCredentials,
  getPrimedCredentials,
  __resetPrimedCredentials,
} from '../../src/credentials/prime.js';

const selectMock = vi.fn();

vi.mock('../../src/credentials/keychain.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/credentials/keychain.js')>(
    '../../src/credentials/keychain.js',
  );
  return {
    ...actual,
    selectCredentialStore: (...args: unknown[]) => selectMock(...args),
  };
});

beforeEach(() => {
  selectMock.mockReset();
  __resetPrimedCredentials();
});

afterEach(() => {
  __resetPrimedCredentials();
});

describe('primeCredentials', () => {
  it('caches a successful keychain read and makes it accessible via getPrimedCredentials', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')).toEqual({ token: 'T', secret: 'S' });
    expect(selectMock).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('default');
  });

  it('returns null from getPrimedCredentials when the keychain lookup returned null', async () => {
    const get = vi.fn().mockResolvedValue(null);
    selectMock.mockResolvedValue({ name: 'file', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('default')).toBeNull();
  });

  it('returns null for a profile different from the primed one', async () => {
    const get = vi.fn().mockResolvedValue({ token: 'T', secret: 'S' });
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await primeCredentials('default');
    expect(getPrimedCredentials('work')).toBeNull();
  });

  it('repriming the same profile short-circuits (no extra store selection)', async () => {
    const get = vi.fn().mockResolvedValue(null);
    selectMock.mockResolvedValue({ name: 'file', get } as any);

    await primeCredentials('default');
    await primeCredentials('default');
    await primeCredentials('default');
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it('repriming a different profile invalidates the previous entry', async () => {
    const getA = vi.fn().mockResolvedValue({ token: 'TA', secret: 'SA' });
    const getB = vi.fn().mockResolvedValue({ token: 'TB', secret: 'SB' });
    selectMock
      .mockResolvedValueOnce({ name: 'keychain', get: getA } as any)
      .mockResolvedValueOnce({ name: 'keychain', get: getB } as any);

    await primeCredentials('a');
    expect(getPrimedCredentials('a')).toEqual({ token: 'TA', secret: 'SA' });

    await primeCredentials('b');
    expect(getPrimedCredentials('b')).toEqual({ token: 'TB', secret: 'SB' });
    expect(getPrimedCredentials('a')).toBeNull();
  });

  it('swallows errors from selectCredentialStore', async () => {
    selectMock.mockRejectedValue(new Error('explode'));
    await expect(primeCredentials('default')).resolves.toBeUndefined();
    expect(getPrimedCredentials('default')).toBeNull();
  });

  it('swallows errors from the backend get()', async () => {
    const get = vi.fn().mockRejectedValue(new Error('timeout'));
    selectMock.mockResolvedValue({ name: 'keychain', get } as any);

    await expect(primeCredentials('default')).resolves.toBeUndefined();
    expect(getPrimedCredentials('default')).toBeNull();
  });
});
