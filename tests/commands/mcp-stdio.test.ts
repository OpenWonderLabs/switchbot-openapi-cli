import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';

interface ProcResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

async function runMcpStdioOnce(timeoutMs = 12000): Promise<ProcResult> {
  const cliPath = path.resolve(process.cwd(), 'dist/index.js');
  const child = spawn(process.execPath, [cliPath, 'mcp', 'serve'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const init = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vitest', version: '1' },
    },
  };
  const notify = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const tools = { jsonrpc: '2.0', id: 2, method: 'tools/list' };
  child.stdin.write(`${JSON.stringify(init)}\n`);
  child.stdin.write(`${JSON.stringify(notify)}\n`);
  child.stdin.write(`${JSON.stringify(tools)}\n`);
  child.stdin.end();

  return await new Promise<ProcResult>((resolve, reject) => {
    const t = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mcp stdio did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(t);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe('mcp serve stdio lifecycle', () => {
  it('exits gracefully on stdin EOF after initialize/tools/list', async () => {
    const res = await runMcpStdioOnce();
    expect(res.signal).toBeNull();
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('"id":1');
    expect(res.stdout).toContain('"id":2');
  });
});

