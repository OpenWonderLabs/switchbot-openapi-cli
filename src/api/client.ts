import axios, {
  type AxiosInstance,
  type InternalAxiosRequestConfig,
  type AxiosResponse,
} from 'axios';
import chalk from 'chalk';
import { buildAuthHeaders } from '../auth.js';
import { loadConfig } from '../config.js';
import {
  isVerbose,
  isDryRun,
  getTimeout,
  getRetryOn429,
  getRetryOn5xx,
  getBackoffStrategy,
  isQuotaDisabled,
} from '../utils/flags.js';
import { nextRetryDelayMs, sleep, CircuitBreaker, CircuitOpenError } from '../utils/retry.js';
import { recordRequest, checkDailyCap } from '../utils/quota.js';
import { readProfileMeta } from '../config.js';
import { getActiveProfile } from '../lib/request-context.js';
import { redactHeaders, warnOnceIfUnsafe } from '../utils/redact.js';
import { primeCredentials } from '../credentials/prime.js';
import { assertCredentialScope, readCredentialScope } from '../credentials/scope.js';
import { getCachedDevice } from '../devices/cache.js';
import { deriveSafetyTier, findExactCatalogEntry } from '../devices/catalog.js';

class DailyCapExceededError extends Error {
  constructor(public readonly cap: number, public readonly total: number, public readonly profile?: string) {
    super(
      `Local daily cap reached: ${total}/${cap} SwitchBot API calls used today${profile ? ` for profile "${profile}"` : ''}. ` +
      `Raise with: switchbot ${profile ? `--profile ${profile} ` : ''}config set-token --daily-cap <N>`,
    );
    this.name = 'DailyCapExceededError';
  }
}

const API_ERROR_MESSAGES: Record<number, string> = {
  151: 'Device type does not support this command',
  152: 'Device ID does not exist',
  160: 'This device does not support this command',
  161: 'Device offline (check Wi-Fi / Bluetooth connection)',
  171: 'Hub device offline (BLE devices require a Hub to communicate)',
  190: 'Device internal error — often an invalid deviceId, unsupported parameter, or device busy',
};

/** Thrown by the request interceptor when --dry-run intercepts a mutating call. */
export class DryRunSignal extends Error {
  constructor(public readonly method: string, public readonly url: string) {
    super('dry-run');
    this.name = 'DryRunSignal';
  }
}

/**
 * Module-level circuit breaker for the SwitchBot API. Shared across all
 * client instances in the process. Opens after 5 consecutive 5xx / network
 * errors; resets to half-open after 60 s.
 * Exported for health-check inspection.
 */
export const apiCircuitBreaker = new CircuitBreaker('switchbot-api', {
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

export { CircuitOpenError };

type RetryableConfig = InternalAxiosRequestConfig & { __retryCount?: number };
interface DeviceControlRequest { deviceId: string; command?: string }
function deviceControlRequest(config?: InternalAxiosRequestConfig): DeviceControlRequest | undefined {
  const deviceId = config?.url?.match(/\/v1\.1\/devices\/([^/?]+)\/commands(?:\?.*)?$/)?.[1];
  if (!config || !deviceId) return undefined;

  let data: unknown = config.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data) as unknown;
    } catch {
      return { deviceId };
    }
  }
  if (data && typeof data === 'object' && 'command' in data && typeof data.command === 'string' &&
      (!('commandType' in data) || data.commandType === 'command')) {
    return { deviceId, command: data.command };
  }
  return { deviceId };
}

function canRepeatRequest(method: string, config: InternalAxiosRequestConfig | undefined,
  control: DeviceControlRequest | undefined): boolean {
  if (method === 'GET' || (method === 'POST' && config?.url === '/v1.1/webhook/queryWebhook')) return true;
  if (!control?.command || control.command === 'deleteImage') return false;
  const device = getCachedDevice(control.deviceId);
  if (!device) return false;
  const entry = findExactCatalogEntry(device.type);
  const spec = entry?.commands.find(c => c.command === control.command && c.commandType !== 'customize');
  return spec?.idempotent === true && deriveSafetyTier(spec, entry ?? undefined) !== 'destructive';
}


export function createClient(assertSigningCredentials?: (token: string, secret: string, revision: string) => void): AxiosInstance {
  const scope = readCredentialScope();
  const verbose = isVerbose();
  const dryRun = isDryRun();
  const maxRetries = getRetryOn429();
  const max5xxRetries = getRetryOn5xx();
  const backoff = getBackoffStrategy();
  const quotaEnabled = !isQuotaDisabled();
  const profile = getActiveProfile();
  const profileMeta = readProfileMeta(profile);
  const dailyCap = profileMeta?.limits?.dailyCap;

  const client = axios.create({
    baseURL: 'https://api.switch-bot.com',
    timeout: getTimeout(),
  });

  // Inject auth headers; optionally log the request; short-circuit on --dry-run.
  client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    assertCredentialScope(scope);
    await primeCredentials(profile ?? 'default');
    assertCredentialScope(scope);
    const { token, secret } = loadConfig();
    // Circuit breaker check — fail fast when the API is consistently down.
    apiCircuitBreaker.checkAndAllow();

    // Pre-flight cap check: refuse the call before it touches the network.
    if (dailyCap) {
      const check = checkDailyCap(dailyCap);
      if (check.over) {
        throw new DailyCapExceededError(dailyCap, check.total, profile);
      }
    }
    assertCredentialScope(scope);
    assertSigningCredentials?.(token, secret, scope.revision);
    const authHeaders = buildAuthHeaders(token, secret);
    Object.assign(config.headers, authHeaders);

    const method = (config.method ?? 'get').toUpperCase();
    const url = `${config.baseURL ?? ''}${config.url ?? ''}`;

    if (verbose) {
      warnOnceIfUnsafe();
      process.stderr.write(chalk.grey(`[verbose] ${method} ${url}\n`));
      const { safe, redactedCount } = redactHeaders(config.headers as unknown as Record<string, unknown>);
      process.stderr.write(chalk.grey(`[verbose] headers: ${JSON.stringify(safe)}\n`));
      if (redactedCount > 0) {
        process.stderr.write(chalk.grey(`[verbose] 🔒 ${redactedCount} sensitive header(s) redacted.\n`));
      }
      if (config.data !== undefined) {
        process.stderr.write(chalk.grey(`[verbose] body: ${JSON.stringify(config.data)}\n`));
      }
    }

    if (dryRun && method !== 'GET') {
      process.stderr.write(chalk.yellow(`[dry-run] Would ${method} ${url}\n`));
      if (config.data !== undefined) {
        process.stderr.write(chalk.yellow(`[dry-run] body: ${JSON.stringify(config.data)}\n`));
      }
      throw new DryRunSignal(method, url);
    }

    // P8: record the quota attempt BEFORE the request is dispatched so
    // failures (timeouts / DNS errors / 5xx / aborted) also count. Only
    // pre-flight refusals (daily-cap, --dry-run) above skip recording
    // since they never touch the network. Retries re-enter this
    // interceptor and record again, which matches the SwitchBot API
    // billing model (every dispatched HTTP request consumes quota).
    if (quotaEnabled) {
      recordRequest(method, url);
    }

    return config;
  });

  // Handle API-level errors (HTTP 200 but statusCode !== 100)
  client.interceptors.response.use(
    (response: AxiosResponse) => {
      if (verbose) {
        process.stderr.write(chalk.grey(`[verbose] ${response.status} ${response.statusText}\n`));
      }
      const data = response.data as { statusCode?: number; message?: string };
      if (data.statusCode !== undefined && data.statusCode !== 100) {
        const msg = data.statusCode === 402 && deviceControlRequest(response.config)?.command === 'uploadImage'
          ? `Image upload quota reached${data.message ? `: ${data.message}` : ''}`
          : API_ERROR_MESSAGES[data.statusCode] ??
            data.message ??
            `API error code: ${data.statusCode}`;
        throw new ApiError(msg, data.statusCode);
      }
      // Successful HTTP response — record for circuit breaker.
      apiCircuitBreaker.recordSuccess();
      return response;
    },
    (error) => {
      if (error instanceof DryRunSignal) throw error;
      if (axios.isAxiosError(error)) {
        // Do not classify or retry an old account's failure using the new account's catalog.
        assertCredentialScope(scope);
        const config = error.config as RetryableConfig | undefined;
        const method = (config?.method ?? 'get').toUpperCase();
        const isIdempotentRead = method === 'GET';

        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          // Retry idempotent GETs on timeout up to `max5xxRetries` times.
          if (isIdempotentRead && config && max5xxRetries > 0) {
            const attempt = config.__retryCount ?? 0;
            if (attempt < max5xxRetries) {
              config.__retryCount = attempt + 1;
              const delay = nextRetryDelayMs(attempt, backoff, undefined);
              if (verbose) {
                process.stderr.write(
                  chalk.grey(
                    `[verbose] timeout — retry ${attempt + 1}/${max5xxRetries} in ${delay}ms\n`,
                  ),
                );
              }
              return sleep(delay).then(() => client.request(config));
            }
          }
          // Network-level failure — record for circuit breaker.
          apiCircuitBreaker.recordFailure();
          throw new ApiError(
            `Request timed out after ${getTimeout()}ms (override with --timeout <ms>)`,
            0,
            { transient: true, retryable: isIdempotentRead }
          );
        }
        const status = error.response?.status;
        const control = method === 'POST' ? deviceControlRequest(config) : undefined;
        const repeatable = canRepeatRequest(method, config, control);
        if (status === 429 && !repeatable) {
          const deletion = control?.command === 'deleteImage';
          throw new ApiError(`${deletion ? 'Image deletion' : 'Mutation'} rate limited (HTTP 429); not retried.`, 429, {
            transient: true, retryable: false, hint: deletion ? 'Check the album before approving another deletion.'
              : 'The operation is not known to be safe to repeat. Check its outcome before proposing a new action.',
          });
        }

        // 429 → transparent retry with Retry-After / exponential backoff.
        // Skipped when: no config (shouldn't happen for real axios errors),
        // retries disabled, or we've already used our budget.
        if (status === 429 && config && maxRetries > 0) {
          const attempt = config.__retryCount ?? 0;
          if (attempt < maxRetries) {
            config.__retryCount = attempt + 1;
            const delay = nextRetryDelayMs(
              attempt,
              backoff,
              error.response?.headers?.['retry-after']
            );
            if (verbose) {
              process.stderr.write(
                chalk.grey(
                  `[verbose] 429 received — retry ${attempt + 1}/${maxRetries} in ${delay}ms\n`
                )
              );
            }
            return sleep(delay).then(() => client.request(config));
          }
        }

        // Unlike an explicit rate limit, a 5xx may come after the server acted.
        // Only GETs are automatically retried on ambiguous transport failures.
        if (
          isIdempotentRead &&
          status !== undefined &&
          (status === 502 || status === 503 || status === 504) &&
          config &&
          max5xxRetries > 0
        ) {
          const attempt = config.__retryCount ?? 0;
          if (attempt < max5xxRetries) {
            config.__retryCount = attempt + 1;
            const delay = nextRetryDelayMs(
              attempt,
              backoff,
              error.response?.headers?.['retry-after'],
            );
            if (verbose) {
              process.stderr.write(
                chalk.grey(
                  `[verbose] ${status} received — retry ${attempt + 1}/${max5xxRetries} in ${delay}ms\n`,
                ),
              );
            }
            return sleep(delay).then(() => client.request(config));
          }
        }

        // Record 5xx and network errors for circuit breaker. 4xx errors are
        // expected business responses — don't count toward circuit threshold.
        if (status === undefined || status >= 500) {
          apiCircuitBreaker.recordFailure();
        }

        // P8: quota already recorded in the request interceptor before
        // dispatch — no extra bookkeeping needed here on the error path.
        // Timeouts, DNS failures, 5xx, and exhausted retries all counted
        // when the attempt was first made.

        if (status === 401) {
          throw new ApiError(
            'Authentication failed (HTTP 401): check token, secret, signature and system clock; inspect the provider response for account-limit details',
            401,
            {
              transient: false,
              retryable: false,
              hint: 'Re-authenticate with `switchbot auth login` or verify the host credential environment; `switchbot quota status` is only a local request count.'
            }
          );
        }
        if (status === 429) {
          const retryAfter = error.response?.headers?.['retry-after'];
          const retryAfterMs = nextRetryDelayMs(maxRetries - 1, backoff, retryAfter);
          throw new ApiError(
            'Request rate too high (HTTP 429; retries exhausted)',
            429,
            {
              retryable: true,
              transient: true,
              retryAfterMs,
              hint: 'Honor Retry-After and reduce request frequency. Check provider limits and `switchbot quota status`; HTTP 429 alone does not prove the daily allowance is exhausted.'
            }
          );
        }
        throw new ApiError(
          `HTTP ${status ?? '?'}: ${error.message}`,
          status ?? 0,
          {
            retryable: repeatable && status !== undefined && status >= 500,
            transient: status !== undefined && (status >= 500 || status === 0) // 5xx, 0 = connection error
          }
        );
      }
      throw error;
    }
  );

  return client;
}

export interface ApiErrorMeta {
  retryable?: boolean;
  hint?: string;
  retryAfterMs?: number;
  transient?: boolean;
}

export class ApiError extends Error {
  public readonly retryable: boolean;
  public readonly hint?: string;
  public readonly retryAfterMs?: number;
  public readonly transient: boolean;
  constructor(
    message: string,
    public readonly code: number,
    meta: ApiErrorMeta = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.retryable = meta.retryable ?? false;
    this.hint = meta.hint;
    this.retryAfterMs = meta.retryAfterMs;
    this.transient = meta.transient ?? false;
  }
}
