import http from 'node:http';
import net from 'node:net';
import { LOGIN_TIMEOUT_MS } from './constants.js';

export interface CallbackResult {
  code: string;
}

export interface CallbackHandle {
  /** The loopback port the server is listening on. */
  port: number;
  /** Resolves with the OAuth code once the browser redirects here. */
  wait(): Promise<CallbackResult>;
}

function successHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SwitchBot CLI — Login successful</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#f0fdf4}
.card{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#16a34a;margin:0 0 12px}p{color:#374151;margin:0}</style>
</head><body><div class="card">
<h1>Login successful</h1>
<p>You can close this tab and return to your terminal.</p>
</div></body></html>`;
}

function errorHtml(detail: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SwitchBot CLI — Login failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#fef2f2}
.card{background:#fff;border-radius:12px;padding:40px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{color:#dc2626;margin:0 0 12px}p{color:#374151;margin:0;font-size:.9rem}</style>
</head><body><div class="card">
<h1>Login failed</h1>
<p>${detail}</p>
</div></body></html>`;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo | null;
      srv.close(() => {
        if (!addr) { reject(new Error('Could not allocate callback port')); return; }
        resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

/**
 * Bind a one-shot OAuth callback server on a free loopback port.
 *
 * Returns immediately with the bound `port` and a `wait()` function.
 * Call `wait()` to receive the authorization code once the user's browser
 * is redirected to `http://127.0.0.1:<port>/callback`.
 *
 * The server shuts itself down after the first valid callback or on timeout.
 */
export async function bindCallbackServer(
  expectedState: string,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<CallbackHandle> {
  const port = await getFreePort();

  let resolveResult!: (r: CallbackResult) => void;
  let rejectResult!: (e: Error) => void;
  const resultPromise = new Promise<CallbackResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const errorDesc = url.searchParams.get('error_description') ?? '';

    const finish = (statusCode: number, body: string, err?: Error) => {
      res.writeHead(statusCode, { 'Content-Type': 'text/html' });
      res.end(body);
      server.close();
      clearTimeout(timer);
      if (err) rejectResult(err); else resolveResult({ code: code! });
    };

    if (error) {
      finish(400, errorHtml(`${error}${errorDesc ? ': ' + errorDesc : ''}`),
        new Error(`OAuth error: ${error}${errorDesc ? ' — ' + errorDesc : ''}`));
      return;
    }

    if (state !== expectedState) {
      finish(400, errorHtml('State mismatch — possible CSRF. Please try again.'),
        new Error('OAuth state mismatch'));
      return;
    }

    if (!code) {
      finish(400, errorHtml('Missing authorization code in callback.'),
        new Error('Missing authorization code'));
      return;
    }

    finish(200, successHtml());
  });

  server.listen(port, '127.0.0.1');

  const timer = setTimeout(() => {
    server.close();
    rejectResult(new Error('Login timed out. Please run `switchbot auth login` again.'));
  }, timeoutMs);

  return { port, wait: () => resultPromise };
}
