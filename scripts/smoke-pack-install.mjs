import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
const expectedVersion = String(pkg.version);

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, ...args], options);
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(npmCmd, args, options);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-pack-smoke-'));
let tarballPath = null;

try {
  const packJson = runNpm(['pack', '--json'], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  const [packResult] = JSON.parse(packJson);
  if (!packResult?.filename) {
    throw new Error(`npm pack did not return a filename: ${packJson}`);
  }

  tarballPath = path.join(repoRoot, packResult.filename);

  runNpm(['init', '-y'], {
    cwd: workDir,
    stdio: 'ignore',
  });

  runNpm(['install', tarballPath], {
    cwd: workDir,
    stdio: 'inherit',
  });

  const switchbotBin = process.platform === 'win32'
    ? path.join(workDir, 'node_modules', '.bin', 'switchbot.cmd')
    : path.join(workDir, 'node_modules', '.bin', 'switchbot');

  function runBin(args) {
    if (process.platform === 'win32') {
      return execFileSync(switchbotBin, args, {
        cwd: workDir,
        encoding: 'utf-8',
        shell: true,
      });
    }
    return execFileSync(switchbotBin, args, {
      cwd: workDir,
      encoding: 'utf-8',
    });
  }

  // 1. --version (existing check)
  const actualVersion = runBin(['--version']).trim();
  if (actualVersion !== expectedVersion) {
    throw new Error(`Packed CLI version mismatch: expected ${expectedVersion}, got ${actualVersion}`);
  }
  console.log(`pack-install smoke ok: switchbot --version -> ${actualVersion}`);

  // 2. policy new — exercises readPolicyExampleYaml for the example template.
  //    If the bundle's embedded-asset resolver can't find the template, this fails
  //    with ENOENT before writing the file — which is exactly the 3.2.2 P0.
  const policyPath = path.join(workDir, 'policy.yaml');
  runBin(['policy', 'new', policyPath]);
  const policyStat = statSync(policyPath);
  if (policyStat.size < 500) {
    throw new Error(`policy new wrote ${policyStat.size} bytes to ${policyPath}; expected >= 500`);
  }
  console.log(`pack-install smoke ok: policy new -> ${policyPath} (${policyStat.size} bytes)`);

  // 3. policy validate --json — exercises readPolicySchemaJson for v0.2.json.
  //    This is the other loader site and would also be broken by a future drift
  //    in dist/ asset layout.
  const validateOut = runBin(['policy', 'validate', policyPath, '--json']);
  let parsed;
  try {
    parsed = JSON.parse(validateOut);
  } catch (e) {
    throw new Error(`policy validate --json did not return JSON: ${validateOut}`);
  }
  if (parsed?.data?.valid !== true) {
    throw new Error(`policy validate reported not valid: ${JSON.stringify(parsed)}`);
  }
  console.log(`pack-install smoke ok: policy validate -> { valid: true }`);

  // 4. MCP policy_new — third call-site of the embedded-asset loader.
  //    Spawns `switchbot mcp serve` (stdio), runs the MCP initialize handshake,
  //    then calls tools/call for policy_new. Exercises the same readPolicyExampleYaml
  //    as (2), but through the full MCP SDK bundling + StdioServerTransport path —
  //    which would independently break if a future change drops @modelcontextprotocol/sdk
  //    from the tarball or breaks stdio bootstrap.
  const mcpPolicyPath = path.join(workDir, 'policy.mcp.yaml');
  await runMcpPolicyNewSmoke({ workDir, mcpPolicyPath });
  const mcpStat = statSync(mcpPolicyPath);
  if (mcpStat.size < 500) {
    throw new Error(`mcp policy_new wrote ${mcpStat.size} bytes to ${mcpPolicyPath}; expected >= 500`);
  }
  console.log(`pack-install smoke ok: mcp policy_new -> ${mcpPolicyPath} (${mcpStat.size} bytes)`);
} finally {
  if (tarballPath) {
    rmSync(tarballPath, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}

/**
 * Drive the stdio MCP server end-to-end:
 *   1. spawn switchbot mcp serve
 *   2. send `initialize` (JSON-RPC)
 *   3. send `notifications/initialized`
 *   4. send `tools/call` for policy_new with an explicit target path + force=true
 *   5. read the response, assert success
 *   6. close stdin -> graceful shutdown
 *
 * JSON-RPC framing is one message per line over stdout (NDJSON). The server
 * may also emit operational logs on stderr ("MQTT disabled: ..." etc.);
 * those are not part of the protocol and are ignored here.
 */
async function runMcpPolicyNewSmoke({ workDir, mcpPolicyPath }) {
  const switchbotBin = process.platform === 'win32'
    ? path.join(workDir, 'node_modules', '.bin', 'switchbot.cmd')
    : path.join(workDir, 'node_modules', '.bin', 'switchbot');

  const child = spawn(switchbotBin, ['mcp', 'serve'], {
    cwd: workDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  const pending = new Map(); // id -> { resolve, reject }
  let stdoutBuf = '';
  let stderrBuf = '';
  let exited = false;
  let exitCode = null;

  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`MCP error: ${JSON.stringify(msg.error)}`));
        else entry.resolve(msg.result);
      }
    }
  });
  child.stderr.setEncoding('utf-8');
  child.stderr.on('data', (chunk) => { stderrBuf += chunk; });
  child.on('exit', (code) => { exited = true; exitCode = code; });

  const send = (obj) => {
    if (exited) throw new Error(`mcp server exited (code=${exitCode}) before send. stderr:\n${stderrBuf}`);
    child.stdin.write(JSON.stringify(obj) + '\n');
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    pending.set(id, { resolve, reject });
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}. stderr:\n${stderrBuf}`));
      }
    }, 15_000);
    timer.unref?.();
    send({ jsonrpc: '2.0', id, method, params });
  });
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

  try {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'pack-install-smoke', version: '0.0.0' },
    });
    notify('notifications/initialized', {});
    const result = await request('tools/call', {
      name: 'policy_new',
      arguments: { path: mcpPolicyPath, force: true },
    });
    if (!result || result.isError) {
      throw new Error(`policy_new returned error: ${JSON.stringify(result)}`);
    }
    const structured = result.structuredContent;
    if (!structured || typeof structured.bytesWritten !== 'number' || structured.bytesWritten <= 0) {
      throw new Error(`policy_new returned unexpected result: ${JSON.stringify(result)}`);
    }
    if (!existsSync(mcpPolicyPath)) {
      throw new Error(`policy_new reported success but ${mcpPolicyPath} does not exist`);
    }
  } finally {
    try { child.stdin.end(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      if (exited) return resolve();
      child.on('exit', resolve);
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(); }, 5_000).unref?.();
    });
  }
}
