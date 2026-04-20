import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type RequestFn = (config: { headers: Record<string, string> }) => unknown;
type ResponseOkFn = (response: unknown) => unknown;
type ResponseErrFn = (error: unknown) => unknown;

interface CapturedInterceptors {
  request: RequestFn | null;
  success: ResponseOkFn | null;
  failure: ResponseErrFn | null;
}

const captured: CapturedInterceptors = { request: null, success: null, failure: null };

const axiosMock = vi.hoisted(() => {
  const fakeInstance = {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    request: vi.fn(),
  };
  return {
    default: {
      create: vi.fn(() => fakeInstance),
      isAxiosError: vi.fn(),
    },
    __instance: fakeInstance,
  };
});

vi.mock('axios', () => ({
  default: axiosMock.default,
  isAxiosError: axiosMock.default.isAxiosError,
}));

vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn(() => ({ token: 'fake-token', secret: 'fake-secret' })),
  readProfileMeta: vi.fn(() => null),
}));

vi.mock('../../src/auth.js', () => ({
  buildAuthHeaders: vi.fn(() => ({
    Authorization: 'fake-token',
    t: '1700000000000',
    sign: 'FAKE_SIGN',
    nonce: 'fake-nonce',
    'Content-Type': 'application/json',
  })),
}));

// Quota recording is best-effort file I/O — mock it out so tests don't
// touch the real home directory and so we can assert on recorded calls.
const quotaMock = vi.hoisted(() => ({
  recordRequest: vi.fn(),
}));
vi.mock('../../src/utils/quota.js', () => ({
  recordRequest: quotaMock.recordRequest,
  // The client doesn't import these, but export shims keep the module
  // surface stable if other tests import it transitively.
  loadQuota: vi.fn(),
  resetQuota: vi.fn(),
  todayUsage: vi.fn(),
  normaliseEndpoint: vi.fn(),
  DAILY_QUOTA: 10_000,
}));

import { createClient, ApiError, DryRunSignal } from '../../src/api/client.js';

describe('createClient', () => {
  beforeEach(() => {
    captured.request = null;
    captured.success = null;
    captured.failure = null;
    axiosMock.__instance.interceptors.request.use.mockReset();
    axiosMock.__instance.interceptors.response.use.mockReset();
    axiosMock.default.isAxiosError.mockReset();
    axiosMock.default.isAxiosError.mockReturnValue(false);

    axiosMock.__instance.interceptors.request.use.mockImplementation((fn: RequestFn) => {
      captured.request = fn;
    });
    axiosMock.__instance.interceptors.response.use.mockImplementation(
      (ok: ResponseOkFn, err: ResponseErrFn) => {
        captured.success = ok;
        captured.failure = err;
      }
    );

    createClient();
  });

  it('creates an axios instance with the SwitchBot baseURL and a timeout', () => {
    expect(axiosMock.default.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://api.switch-bot.com',
        timeout: expect.any(Number),
      })
    );
  });

  describe('request interceptor', () => {
    it('injects auth headers into every outgoing request', () => {
      const config = { headers: {} as Record<string, string> };
      const result = captured.request!(config) as { headers: Record<string, string> };
      expect(result.headers.Authorization).toBe('fake-token');
      expect(result.headers.sign).toBe('FAKE_SIGN');
      expect(result.headers.nonce).toBe('fake-nonce');
      expect(result.headers.t).toBe('1700000000000');
    });

    it('preserves pre-existing headers (merge, not replace)', () => {
      const config = { headers: { 'X-Custom': 'keep' } as Record<string, string> };
      const result = captured.request!(config) as { headers: Record<string, string> };
      expect(result.headers['X-Custom']).toBe('keep');
      expect(result.headers.Authorization).toBe('fake-token');
    });
  });

  describe('response interceptor — success path', () => {
    it('returns the response unchanged when statusCode === 100', () => {
      const response = { data: { statusCode: 100, message: 'success', body: { ok: true } } };
      expect(captured.success!(response)).toBe(response);
    });

    it('returns the response unchanged when statusCode is undefined (non-standard response)', () => {
      const response = { data: { body: 'something' } };
      expect(captured.success!(response)).toBe(response);
    });
  });

  describe('response interceptor — mapped API error codes', () => {
    const cases: Array<[number, string]> = [
      [151, 'Device type does not support this command'],
      [152, 'Device ID does not exist'],
      [160, 'This device does not support this command'],
      [161, 'Device offline (check Wi-Fi / Bluetooth connection)'],
      [171, 'Hub device offline (BLE devices require a Hub to communicate)'],
      [190, 'Device internal error — often an invalid deviceId, unsupported parameter, or device busy'],
    ];

    it.each(cases)('throws ApiError with code %d and the expected English message', (code, msg) => {
      const response = { data: { statusCode: code, message: 'ignored' } };
      try {
        captured.success!(response);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe(code);
        expect((err as ApiError).message).toBe(msg);
      }
    });

    it('falls back to the API message field for unmapped codes', () => {
      const response = { data: { statusCode: 999, message: 'Something the API said' } };
      try {
        captured.success!(response);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as ApiError).message).toBe('Something the API said');
        expect((err as ApiError).code).toBe(999);
      }
    });

    it('falls back to "API error code: N" when unmapped and no message', () => {
      const response = { data: { statusCode: 888 } };
      try {
        captured.success!(response);
        expect.fail('should have thrown');
      } catch (err) {
        expect((err as ApiError).message).toBe('API error code: 888');
        expect((err as ApiError).code).toBe(888);
      }
    });
  });

  describe('response interceptor — HTTP error handler', () => {
    function callFailure(input: unknown): unknown {
      try {
        captured.failure!(input);
      } catch (err) {
        return err;
      }
      throw new Error('failure handler did not throw');
    }

    it('maps HTTP 401 to an auth-failed ApiError', () => {
      axiosMock.default.isAxiosError.mockReturnValue(true);
      const thrown = callFailure({ response: { status: 401 }, message: 'Request failed' }) as ApiError;
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown.code).toBe(401);
      expect(thrown.message).toContain('Authentication failed');
    });

    it('maps HTTP 429 to a rate-limit ApiError', () => {
      axiosMock.default.isAxiosError.mockReturnValue(true);
      const thrown = callFailure({ response: { status: 429 }, message: 'rate limited' }) as ApiError;
      expect(thrown.code).toBe(429);
      expect(thrown.message).toContain('Request rate too high');
    });

    it('formats other HTTP errors as "HTTP <status>: <msg>"', () => {
      axiosMock.default.isAxiosError.mockReturnValue(true);
      const thrown = callFailure({ response: { status: 500 }, message: 'boom' }) as ApiError;
      expect(thrown.code).toBe(500);
      expect(thrown.message).toBe('HTTP 500: boom');
    });

    it('handles missing response status (code 0, "?")', () => {
      axiosMock.default.isAxiosError.mockReturnValue(true);
      const thrown = callFailure({ message: 'ENOTFOUND' }) as ApiError;
      expect(thrown.code).toBe(0);
      expect(thrown.message).toBe('HTTP ?: ENOTFOUND');
    });

    it('re-throws non-axios errors unchanged', () => {
      axiosMock.default.isAxiosError.mockReturnValue(false);
      const raw = new Error('raw');
      expect(callFailure(raw)).toBe(raw);
    });
  });
});

describe('ApiError', () => {
  it('is an Error subclass and exposes .code and .name', () => {
    const e = new ApiError('msg', 42);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.name).toBe('ApiError');
    expect(e.message).toBe('msg');
    expect(e.code).toBe(42);
  });
});

describe('DryRunSignal', () => {
  it('is an Error subclass carrying method and url', () => {
    const sig = new DryRunSignal('POST', 'https://example.com/x');
    expect(sig).toBeInstanceOf(Error);
    expect(sig).toBeInstanceOf(DryRunSignal);
    expect(sig.name).toBe('DryRunSignal');
    expect(sig.method).toBe('POST');
    expect(sig.url).toBe('https://example.com/x');
  });
});

describe('createClient — configurable globals', () => {
  const originalArgv = process.argv;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    captured.request = null;
    captured.success = null;
    captured.failure = null;
    axiosMock.__instance.interceptors.request.use.mockReset();
    axiosMock.__instance.interceptors.response.use.mockReset();
    axiosMock.default.create.mockClear();
    axiosMock.default.isAxiosError.mockReset();
    axiosMock.default.isAxiosError.mockReturnValue(false);

    axiosMock.__instance.interceptors.request.use.mockImplementation((fn: RequestFn) => {
      captured.request = fn;
    });
    axiosMock.__instance.interceptors.response.use.mockImplementation(
      (ok: ResponseOkFn, err: ResponseErrFn) => {
        captured.success = ok;
        captured.failure = err;
      }
    );

    writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = originalArgv;
    writeSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('honors --timeout <ms> when constructing the instance', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--timeout', '7500'];
    createClient();
    expect(axiosMock.default.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 7500 })
    );
  });

  it('falls back to 30000ms when --timeout is omitted', () => {
    process.argv = ['node', 'cli', 'devices', 'list'];
    createClient();
    expect(axiosMock.default.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 30_000 })
    );
  });

  it('with --verbose, logs outgoing requests to stderr', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--verbose'];
    createClient();
    captured.request!({
      headers: {} as Record<string, string>,
      method: 'get',
      baseURL: 'https://api.switch-bot.com',
      url: '/v1.1/devices',
    } as never);
    const combined = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(combined).toContain('[verbose]');
    expect(combined).toContain('GET');
    expect(combined).toContain('/v1.1/devices');
  });

  it('with --dry-run, short-circuits non-GET requests with a DryRunSignal and logs', () => {
    process.argv = ['node', 'cli', 'devices', 'command', 'ABC', 'turnOn', '--dry-run'];
    createClient();
    expect(() =>
      captured.request!({
        headers: {} as Record<string, string>,
        method: 'post',
        baseURL: 'https://api.switch-bot.com',
        url: '/v1.1/devices/ABC/commands',
        data: { command: 'turnOn' },
      } as never)
    ).toThrow(DryRunSignal);

    const out = writeSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('[dry-run]');
    expect(out).toContain('POST');
    expect(out).toContain('/v1.1/devices/ABC/commands');
  });

  it('with --dry-run, GET requests still pass through', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--dry-run'];
    createClient();
    const config = {
      headers: {} as Record<string, string>,
      method: 'get',
      baseURL: 'https://api.switch-bot.com',
      url: '/v1.1/devices',
    };
    expect(() => captured.request!(config as never)).not.toThrow();
  });

  it('re-throws DryRunSignal from the response-error handler without wrapping', () => {
    process.argv = ['node', 'cli', 'devices', 'list'];
    createClient();
    const sig = new DryRunSignal('POST', 'https://x/y');
    try {
      captured.failure!(sig);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBe(sig);
    }
  });

  it('maps ECONNABORTED / ETIMEDOUT into a timeout ApiError', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--timeout', '2500'];
    createClient();
    axiosMock.default.isAxiosError.mockReturnValue(true);
    try {
      captured.failure!({ code: 'ECONNABORTED', message: 'timeout' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(0);
      expect((err as ApiError).message).toContain('timed out');
      expect((err as ApiError).message).toContain('2500');
    }
  });
});

describe('createClient — 429 retry', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    captured.request = null;
    captured.success = null;
    captured.failure = null;
    axiosMock.__instance.interceptors.request.use.mockReset();
    axiosMock.__instance.interceptors.response.use.mockReset();
    axiosMock.__instance.request.mockReset();
    axiosMock.default.create.mockClear();
    axiosMock.default.isAxiosError.mockReset();
    axiosMock.default.isAxiosError.mockReturnValue(true);
    quotaMock.recordRequest.mockClear();

    axiosMock.__instance.interceptors.request.use.mockImplementation((fn: RequestFn) => {
      captured.request = fn;
    });
    axiosMock.__instance.interceptors.response.use.mockImplementation(
      (ok: ResponseOkFn, err: ResponseErrFn) => {
        captured.success = ok;
        captured.failure = err;
      }
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Fast-forward setTimeout inside the retry delay.
    vi.useFakeTimers();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries a 429 response and resolves with the retried response', async () => {
    process.argv = ['node', 'cli', 'devices', 'list'];
    createClient();

    const retriedResponse = { data: { statusCode: 100, body: { ok: true } } };
    axiosMock.__instance.request.mockResolvedValue(retriedResponse);

    const config = {
      method: 'get',
      baseURL: 'https://api.switch-bot.com',
      url: '/v1.1/devices',
    };
    const error = {
      response: { status: 429, headers: {} },
      config,
      message: 'rate limited',
    };

    const pending = captured.failure!(error);
    // The retry scheduler sleeps 1000ms on first attempt (exponential base).
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;
    expect(result).toBe(retriedResponse);
    expect(axiosMock.__instance.request).toHaveBeenCalledTimes(1);
    expect(axiosMock.__instance.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/v1.1/devices' })
    );
  });

  it('respects the server Retry-After header over the default backoff', async () => {
    process.argv = ['node', 'cli', 'devices', 'list'];
    createClient();

    axiosMock.__instance.request.mockResolvedValue({ data: { statusCode: 100, body: {} } });

    const config = {
      method: 'get',
      baseURL: 'https://api.switch-bot.com',
      url: '/v1.1/devices',
    };
    const error = {
      response: { status: 429, headers: { 'retry-after': '7' } },
      config,
      message: 'rate limited',
    };

    const pending = captured.failure!(error);
    // Retry-After=7 → should need >6000ms (not 1000ms).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(axiosMock.__instance.request).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;
    expect(axiosMock.__instance.request).toHaveBeenCalledTimes(1);
  });

  it('gives up after --retry-on-429 attempts and throws a retryable ApiError', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--retry-on-429', '2'];
    createClient();

    // Simulate the request having already been retried up to the cap —
    // interceptor should skip the retry branch and throw the exhaustion
    // error directly. This avoids re-entrant mocking.
    const config = {
      method: 'get',
      baseURL: 'https://api.switch-bot.com',
      url: '/v1.1/devices',
      __retryCount: 2,
    };

    try {
      captured.failure!({
        response: { status: 429, headers: {} },
        config,
        message: 'rate limited',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(429);
      expect((err as ApiError).retryable).toBe(true);
      expect((err as ApiError).hint).toContain('quota status');
    }
    expect(axiosMock.__instance.request).not.toHaveBeenCalled();
  });

  it('--no-retry disables retries entirely', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--no-retry'];
    createClient();

    const config = { method: 'get', baseURL: 'https://api.switch-bot.com', url: '/v1.1/devices' };
    try {
      captured.failure!({
        response: { status: 429, headers: {} },
        config,
        message: 'rate limited',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe(429);
    }
    expect(axiosMock.__instance.request).not.toHaveBeenCalled();
  });

  it('records a quota entry on a successful response', () => {
    process.argv = ['node', 'cli', 'devices', 'list'];
    createClient();
    const response = {
      data: { statusCode: 100, body: {} },
      config: {
        method: 'get',
        baseURL: 'https://api.switch-bot.com',
        url: '/v1.1/devices',
      },
    };
    captured.success!(response);
    expect(quotaMock.recordRequest).toHaveBeenCalledWith(
      'GET',
      'https://api.switch-bot.com/v1.1/devices'
    );
  });

  it('--no-quota skips quota recording', () => {
    process.argv = ['node', 'cli', 'devices', 'list', '--no-quota'];
    createClient();
    const response = {
      data: { statusCode: 100, body: {} },
      config: {
        method: 'get',
        baseURL: 'https://api.switch-bot.com',
        url: '/v1.1/devices',
      },
    };
    captured.success!(response);
    expect(quotaMock.recordRequest).not.toHaveBeenCalled();
  });
});
