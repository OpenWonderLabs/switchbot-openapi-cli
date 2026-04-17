import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

const uuidMock = vi.hoisted(() => ({ v4: vi.fn() }));
vi.mock('uuid', () => uuidMock);

import { buildAuthHeaders } from '../src/auth.js';

const TOKEN = 'test-token';
const SECRET = 'test-secret';

function expectedSign(token: string, t: string, nonce: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(token + t + nonce)
    .digest('base64')
    .toUpperCase();
}

describe('buildAuthHeaders', () => {
  beforeEach(() => {
    uuidMock.v4.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns exactly the six required headers', () => {
    uuidMock.v4.mockReturnValue('11111111-1111-4111-8111-111111111111');
    const headers = buildAuthHeaders(TOKEN, SECRET);
    expect(Object.keys(headers).sort()).toEqual(
      ['Authorization', 'Content-Type', 'nonce', 'sign', 'src', 't'].sort()
    );
  });

  it('sets src to "OpenClaw" (unlocks family/room info in devices list)', () => {
    uuidMock.v4.mockReturnValue('uuid-a');
    expect(buildAuthHeaders(TOKEN, SECRET).src).toBe('OpenClaw');
  });

  it('sets Authorization to the token verbatim', () => {
    uuidMock.v4.mockReturnValue('uuid-a');
    expect(buildAuthHeaders(TOKEN, SECRET).Authorization).toBe(TOKEN);
  });

  it('sets Content-Type to application/json', () => {
    uuidMock.v4.mockReturnValue('uuid-a');
    expect(buildAuthHeaders(TOKEN, SECRET)['Content-Type']).toBe('application/json');
  });

  it('t is a 13-digit ms timestamp string equal to Date.now()', () => {
    const fixed = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    uuidMock.v4.mockReturnValue('uuid-a');

    const headers = buildAuthHeaders(TOKEN, SECRET);
    expect(headers.t).toBe(String(fixed));
    expect(headers.t).toMatch(/^\d{13}$/);
  });

  it('sign is uppercase Base64 and matches HMAC-SHA256(token+t+nonce, secret)', () => {
    const fixed = 1_700_000_000_000;
    const nonce = 'abc-nonce';
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    uuidMock.v4.mockReturnValue(nonce);

    const headers = buildAuthHeaders(TOKEN, SECRET);
    expect(headers.sign).toBe(expectedSign(TOKEN, String(fixed), nonce, SECRET));
    expect(headers.sign).toBe(headers.sign.toUpperCase());
    expect(headers.sign).not.toMatch(/[a-z]/);
  });

  it('nonce differs between consecutive calls (uses fresh UUID each time)', () => {
    uuidMock.v4.mockReturnValueOnce('uuid-one').mockReturnValueOnce('uuid-two');
    const a = buildAuthHeaders(TOKEN, SECRET);
    const b = buildAuthHeaders(TOKEN, SECRET);
    expect(a.nonce).toBe('uuid-one');
    expect(b.nonce).toBe('uuid-two');
    expect(a.nonce).not.toBe(b.nonce);
    expect(uuidMock.v4).toHaveBeenCalledTimes(2);
  });

  it('produces a different sign when the secret changes (signature depends on secret)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    uuidMock.v4.mockReturnValue('fixed-nonce');

    const a = buildAuthHeaders(TOKEN, 'secret-a');
    uuidMock.v4.mockReturnValue('fixed-nonce');
    const b = buildAuthHeaders(TOKEN, 'secret-b');
    expect(a.sign).not.toBe(b.sign);
  });

  it('handles empty token and secret without throwing', () => {
    uuidMock.v4.mockReturnValue('uuid-e');
    const headers = buildAuthHeaders('', '');
    expect(headers.Authorization).toBe('');
    expect(headers.sign).toMatch(/^[A-Z0-9+/=]+$/);
  });
});
