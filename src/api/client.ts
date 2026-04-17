import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';
import chalk from 'chalk';
import { buildAuthHeaders } from '../auth.js';
import { loadConfig } from '../config.js';
import { isVerbose, isDryRun, getTimeout } from '../utils/flags.js';

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

export function createClient(): AxiosInstance {
  const { token, secret } = loadConfig();
  const verbose = isVerbose();
  const dryRun = isDryRun();

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
      console.log(chalk.yellow(`[dry-run] Would ${method} ${url}`));
      if (config.data !== undefined) {
        console.log(chalk.yellow(`[dry-run] body: ${JSON.stringify(config.data)}`));
      }
      throw new DryRunSignal(method, url);
    }

    return config;
  });

  // Handle API-level errors (HTTP 200 but statusCode !== 100)
  client.interceptors.response.use(
    (response) => {
      if (verbose) {
        process.stderr.write(chalk.grey(`[verbose] ${response.status} ${response.statusText}\n`));
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
            0
          );
        }
        const status = error.response?.status;
        if (status === 401) {
          throw new ApiError('Authentication failed: invalid token or daily 10,000-request quota exceeded', 401);
        }
        if (status === 429) {
          throw new ApiError('Request rate too high: daily 10,000-request quota exceeded', 429);
        }
        throw new ApiError(
          `HTTP ${status ?? '?'}: ${error.message}`,
          status ?? 0
        );
      }
      throw error;
    }
  );

  return client;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
