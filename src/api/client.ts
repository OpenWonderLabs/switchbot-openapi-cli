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
  getBackoffStrategy,
  isQuotaDisabled,
} from '../utils/flags.js';
import { nextRetryDelayMs, sleep } from '../utils/retry.js';
import { recordRequest } from '../utils/quota.js';

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

type RetryableConfig = InternalAxiosRequestConfig & { __retryCount?: number };

export function createClient(): AxiosInstance {
  const { token, secret } = loadConfig();
  const verbose = isVerbose();
  const dryRun = isDryRun();
  const maxRetries = getRetryOn429();
  const backoff = getBackoffStrategy();
  const quotaEnabled = !isQuotaDisabled();

  const client = axios.create({
    baseURL: 'https://api.switch-bot.com',
    timeout: getTimeout(),
  });

  // Inject auth headers; optionally log the request; short-circuit on --dry-run.
  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const authHeaders = buildAuthHeaders(token, secret);
    Object.assign(config.headers, authHeaders);

    const method = (config.method ?? 'get').toUpperCase();
    const url = `${config.baseURL ?? ''}${config.url ?? ''}`;

    if (verbose) {
      process.stderr.write(chalk.grey(`[verbose] ${method} ${url}\n`));
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

    return config;
  });

  // Handle API-level errors (HTTP 200 but statusCode !== 100)
  client.interceptors.response.use(
    (response: AxiosResponse) => {
      if (verbose) {
        process.stderr.write(chalk.grey(`[verbose] ${response.status} ${response.statusText}\n`));
      }
      if (quotaEnabled && response.config) {
        const method = (response.config.method ?? 'get').toUpperCase();
        const url = `${response.config.baseURL ?? ''}${response.config.url ?? ''}`;
        recordRequest(method, url);
      }
      const data = response.data as { statusCode?: number; message?: string };
      if (data.statusCode !== undefined && data.statusCode !== 100) {
        const msg =
          API_ERROR_MESSAGES[data.statusCode] ??
          data.message ??
          `API error code: ${data.statusCode}`;
        throw new ApiError(msg, data.statusCode);
      }
      return response;
    },
    (error) => {
      if (error instanceof DryRunSignal) throw error;
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw new ApiError(
            `Request timed out after ${getTimeout()}ms (override with --timeout <ms>)`,
            0,
            { transient: true, retryable: false }
          );
        }
        const status = error.response?.status;
        const config = error.config as RetryableConfig | undefined;

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

        // Record exhausted/non-retryable HTTP responses too — they count
        // against the daily quota.
        if (quotaEnabled && error.response && config) {
          const method = (config.method ?? 'get').toUpperCase();
          const url = `${config.baseURL ?? ''}${config.url ?? ''}`;
          recordRequest(method, url);
        }

        if (status === 401) {
          throw new ApiError(
            'Authentication failed: invalid token or daily 10,000-request quota exceeded',
            401,
            {
              transient: false,
              retryable: false,
              hint: 'Run `switchbot config set-token <token> <secret>` to re-enter credentials, or `switchbot quota status` to check today\'s local count.'
            }
          );
        }
        if (status === 429) {
          const retryAfter = error.response?.headers?.['retry-after'];
          const retryAfterMs = nextRetryDelayMs(maxRetries - 1, backoff, retryAfter);
          throw new ApiError(
            'Request rate too high: daily 10,000-request quota exceeded (retries exhausted)',
            429,
            {
              retryable: true,
              transient: true,
              retryAfterMs,
              hint: 'Use `switchbot quota status` to see today\'s usage; raise `--retry-on-429 <n>` for more retries.'
            }
          );
        }
        throw new ApiError(
          `HTTP ${status ?? '?'}: ${error.message}`,
          status ?? 0,
          {
            retryable: status !== undefined && status >= 500,
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
