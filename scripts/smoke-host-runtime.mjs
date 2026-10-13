#!/usr/bin/env node
/**
 * Exercises a real locally-installed agent host against an isolated copy of a
 * candidate. This never sends a model prompt or SwitchBot cloud request.
 *
 * Required mode is a release gate: absent host, candidate CLI, extension
 * loading, or MCP catalog evidence returns a non-zero status. Optional mode
 * records a blocked result, never a pass, when a prerequisite is unavailable.
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const hostCommandRunner = path.join(scriptDir, 'host-command.mjs');
const values = process.argv.slice(2);
const required = values.includes('--require-host');
const host = argument('--host') ?? 'all';
const candidate = path.resolve(argument('--candidate') ?? repoRoot);
const evidencePath = argument('--evidence');
const requestedHosts = host === 'all' ? ['codex', 'claude', 'gemini', 'openclaw'] : [host];
const validHosts = new Set(['codex', 'claude', 'gemini', 'openclaw']);

function argument(name) {
  const index = values.indexOf(name);
  return index === -1 ? null : values[index + 1] ?? null;
}

function commandPath(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

function packageVersion(relativePath) {
  return JSON.parse(readFileSync(path.join(candidate, relativePath, 'package.json'), 'utf8')).version;
}

function resultOf(command, args, options = {}) {
  const { timeout = 30000, ...spawnOptions } = options;
  const result = spawnSync(process.execPath, [
    hostCommandRunner, String(timeout), command, JSON.stringify(args),
  ], {
    cwd: candidate,
    encoding: 'utf8',
    shell: false,
    timeout: timeout + 5000,
    ...spawnOptions,
  });
  if (result.status !== 0) {
    return { command: [command, ...args], status: result.status, stdout: '', stderr: result.stderr ?? '', error: result.error?.message ?? 'Bounded host command helper failed.' };
  }
  try {
    return { command: [command, ...args], ...JSON.parse(result.stdout) };
  } catch {
    return { command: [command, ...args], status: null, stdout: '', stderr: result.stderr ?? '', error: 'Bounded host command helper returned invalid JSON.' };
  }
}

function candidateProvenance() {
  const revision = resultOf('git', ['rev-parse', 'HEAD']);
  const status = resultOf('git', ['status', '--porcelain']);
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim() !== '' : null,
  };
}

function requireSuccess(step, command, args, options) {
  const result = resultOf(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${step} failed: ${result.stderr || result.stdout || result.error || `exit ${result.status}`}`);
  }
  return result;
}

function isolatedEnvironment(workDir, cliEntrypoint) {
  const home = path.join(workDir, 'home');
  const binDir = path.join(workDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(workDir, 'tmp'), { recursive: true });
  for (const directory of [
    path.join(home, '.config'), path.join(home, '.cache'), path.join(home, '.local', 'share'),
    path.join(home, '.codex'), path.join(home, '.claude'),
    path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local'),
  ]) mkdirSync(directory, { recursive: true });
  const separator = path.delimiter;
  const pathValue = [binDir, process.env.PATH].filter(Boolean).join(separator);
  const env = {
    PATH: pathValue,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(workDir, 'tmp'),
    TMP: path.join(workDir, 'tmp'),
    TMPDIR: path.join(workDir, 'tmp'),
    LANG: process.env.LANG ?? 'C.UTF-8',
    SWITCHBOT_TOKEN: 'local-smoke-only-token',
    SWITCHBOT_SECRET: 'local-smoke-only-secret',
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
  };
  if (process.platform === 'win32') {
    writeFileSync(path.join(binDir, 'switchbot.cmd'), `@\"${process.execPath}\" \"${cliEntrypoint}\" %*\r\n`);
  } else {
    const shim = path.join(binDir, 'switchbot');
    writeFileSync(shim, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(cliEntrypoint) + ' "$@"\n');
    requireSuccess('make candidate CLI executable', 'chmod', ['755', shim], { env });
  }
  return env;
}

function startMcp(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: candidate, env, stdio: ["pipe", "pipe", "pipe"] });
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    let buffer = "";
    let catalog;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("MCP startup timed out: " + stderr)), 15000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    const send = (message) => {
      if (!child.stdin.writable) return finish(new Error("MCP stdin closed before the request completed."));
      child.stdin.write(JSON.stringify(message) + "\n");
    };
    const consume = (line) => {
      if (line.length === 0) return finish(new Error("MCP wrote an empty non-RPC stdout line."));
      let message;
      try { message = JSON.parse(line); } catch { return finish(new Error("MCP wrote malformed stdout: " + line)); }
      if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
        return finish(new Error("MCP wrote non-RPC stdout: " + line));
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error("MCP initialize failed: " + JSON.stringify(message.error)));
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      } else if (message.id === 2) {
        if (message.error) return finish(new Error("MCP tool listing failed: " + JSON.stringify(message.error)));
        catalog = message.result;
        send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "device_history", arguments: { mode: "raw" } } });
      } else if (message.id === 3) {
        if (message.error) return finish(new Error("MCP readonly tool call failed: " + JSON.stringify(message.error)));
        if (!message.result || typeof message.result !== "object" || Array.isArray(message.result) || message.result.isError === true) {
          return finish(new Error("MCP readonly tool call returned an error: " + JSON.stringify(message.result)));
        }
        let devices = message.result.structuredContent?.devices;
        if (!Array.isArray(devices)) {
          const text = message.result.content?.find((entry) => entry?.type === "text")?.text;
          try { devices = JSON.parse(text)?.devices; } catch { devices = undefined; }
        }
        if (!Array.isArray(devices)) {
          return finish(new Error("MCP readonly tool call did not return the raw device_history devices shape."));
        }
        return finish(null, {
          catalog,
          readonly: { tool: "device_history", mode: "raw", resultShape: "devices", deviceCount: devices.length },
        });
      }
      return undefined;
    };
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (!settled) finish(new Error("MCP exited before completing the readonly probe (code " + code + ", signal " + (signal ?? "none") + "): " + stderr));
    });
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        consume(line);
        if (settled) return;
      }
    });
    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (!settled && buffer.length > 0) consume(buffer);
    });
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "switchbot-host-smoke", version: "1.0.0" } },
    });
  });
}

function readCodexMcpStatus(hostPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(hostPath, ["app-server", "--listen", "stdio://"], {
      cwd: candidate, env, stdio: ["pipe", "pipe", "pipe"],
    });
    const decoder = new StringDecoder("utf8");
    let stderr = "";
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("Codex app-server MCP status timed out: " + stderr)), 15000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    const send = (message) => {
      if (!child.stdin.writable) return finish(new Error("Codex app-server stdin closed before status completed."));
      child.stdin.write(JSON.stringify(message) + "\n");
    };
    const consume = (line) => {
      if (line.length === 0) return finish(new Error("Codex app-server wrote an empty stdout line."));
      let message;
      try { message = JSON.parse(line); } catch { return finish(new Error("Codex app-server wrote malformed stdout: " + line)); }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return finish(new Error("Codex app-server wrote non-protocol stdout: " + line));
      }
      if (message.id === 1) {
        if (message.error) return finish(new Error("Codex app-server initialize failed: " + JSON.stringify(message.error)));
        send({ method: "initialized", params: {} });
        send({ method: "mcpServerStatus/list", id: 2, params: { detail: "toolsAndAuthOnly", limit: 100 } });
      } else if (message.id === 2) {
        if (message.error) return finish(new Error("Codex MCP status failed: " + JSON.stringify(message.error)));
        return finish(null, message.result);
      }
      return undefined;
    };
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.stdin.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (!settled) finish(new Error("Codex app-server exited before status completed (code " + code + ", signal " + (signal ?? "none") + "): " + stderr));
    });
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        consume(line);
        if (settled) return;
      }
    });
    child.stdout.on("end", () => {
      buffer += decoder.end();
      if (!settled && buffer.length > 0) consume(buffer);
    });
    send({
      method: "initialize", id: 1,
      params: { clientInfo: { name: "switchbot-host-smoke", version: "1.0.0" }, capabilities: { experimentalApi: true } },
    });
  });
}

async function verifyMcpCatalog(env, command = "switchbot", args = ["mcp", "serve"]) {
  const { catalog, readonly } = await startMcp(command, args, env);
  if (!Array.isArray(catalog?.tools) || catalog.tools.length === 0) {
    throw new Error("MCP startup returned no tools.");
  }
  const toolNames = catalog.tools.map((tool) => tool.name);
  if (!toolNames.includes("device_diary")) {
    throw new Error("MCP tool catalog does not contain device_diary from the release candidate.");
  }
  return { toolNames, readonly };
}

function verifyLayer(progress, name, fields = {}) {
  progress.layers.push(name);
  Object.assign(progress, fields);
}

function contains(value, text) {
  return String(value).toLowerCase().includes(text.toLowerCase());
}

async function verifyCodex(hostPath, env, workDir, progress) {
  const fixture = path.join(candidate, "codex-marketplace");
  cpSync(path.join(candidate, ".agents"), path.join(fixture, ".agents"), { recursive: true });
  cpSync(path.join(candidate, "packages", "codex-plugin"), path.join(fixture, "packages", "codex-plugin"), { recursive: true });
  let marketplaceInstalled = false;
  let pluginInstalled = false;
  try {
    requireSuccess("Codex marketplace add", hostPath, ["plugin", "marketplace", "add", fixture], { env });
    marketplaceInstalled = true;
    verifyLayer(progress, "marketplace-installed");
    requireSuccess("Codex plugin add", hostPath, ["plugin", "add", "switchbot@switchbot"], { env });
    pluginInstalled = true;
    verifyLayer(progress, "plugin-installed");
    const listed = requireSuccess("Codex plugin list", hostPath, ["plugin", "list"], { env });
    if (!contains(listed.stdout + listed.stderr, "switchbot@switchbot")) throw new Error("Codex did not list the installed SwitchBot plugin.");
    verifyLayer(progress, "plugin-listed");
    const appServerStatus = await readCodexMcpStatus(hostPath, env);
    if (!contains(JSON.stringify(appServerStatus), "switchbot")) throw new Error("Codex app-server did not load the SwitchBot MCP server.");
    verifyLayer(progress, "app-server-mcp-status");
    const { toolNames, readonly } = await verifyMcpCatalog(env);
    verifyLayer(progress, "mcp-tool-catalog", { toolCount: toolNames.length, tools: toolNames });
    verifyLayer(progress, "device-history-raw", { readonly });
    return { toolCount: toolNames.length, tools: toolNames, readonly };
  } finally {
    if (pluginInstalled) {
      requireSuccess("Codex plugin remove", hostPath, ["plugin", "remove", "switchbot@switchbot"], { env });
      verifyLayer(progress, "plugin-uninstalled");
    }
    if (marketplaceInstalled) requireSuccess("Codex marketplace remove", hostPath, ["plugin", "marketplace", "remove", "switchbot"], { env });
  }
}

async function verifyClaude(hostPath, env, _workDir, progress) {
  const pluginRoot = path.join(candidate, "packages", "claude-code-plugin");
  let marketplaceInstalled = false;
  let pluginInstalled = false;
  try {
    requireSuccess("Claude marketplace add", hostPath, ["plugin", "marketplace", "add", pluginRoot], { env });
    marketplaceInstalled = true;
    verifyLayer(progress, "marketplace-installed");
    requireSuccess("Claude plugin install", hostPath, ["plugin", "install", "switchbot@switchbot", "--scope", "user", "--yes"], { env });
    pluginInstalled = true;
    verifyLayer(progress, "plugin-installed");
    const details = requireSuccess("Claude plugin details", hostPath, ["plugin", "details", "switchbot@switchbot"], { env });
    if (!contains(details.stdout + details.stderr, "skill")) throw new Error("Claude plugin details did not report a skill.");
    verifyLayer(progress, "plugin-skill-discovered");
    requireSuccess("Claude plugin update", hostPath, ["plugin", "update", "switchbot@switchbot", "--scope", "user", "--yes"], { env });
    verifyLayer(progress, "plugin-updated");
    const { toolNames, readonly } = await verifyMcpCatalog(env);
    verifyLayer(progress, "mcp-tool-catalog", { toolCount: toolNames.length, tools: toolNames });
    verifyLayer(progress, "device-history-raw", { readonly });
    return { toolCount: toolNames.length, tools: toolNames, readonly };
  } finally {
    if (pluginInstalled) {
      requireSuccess("Claude plugin uninstall", hostPath, ["plugin", "uninstall", "switchbot@switchbot", "--scope", "user", "--yes"], { env });
      verifyLayer(progress, "plugin-uninstalled");
    }
    if (marketplaceInstalled) requireSuccess("Claude marketplace remove", hostPath, ["plugin", "marketplace", "remove", "switchbot"], { env });
  }
}

async function verifyGemini(hostPath, env, _workDir, progress) {
  const extensionRoot = realpathSync(path.join(candidate, "packages", "gemini-extension"));
  const trustPath = path.join(env.XDG_CONFIG_HOME, "gemini-trusted-folders.json");
  writeFileSync(trustPath, JSON.stringify({ [extensionRoot]: "TRUST_FOLDER" }) + "\n");
  const geminiOptions = {
    cwd: extensionRoot,
    env: { ...env, GEMINI_CLI_TRUSTED_FOLDERS_PATH: trustPath },
  };
  let installed = false;
  try {
    requireSuccess("Gemini extension validate", hostPath, ["extensions", "validate", extensionRoot], geminiOptions);
    verifyLayer(progress, "extension-validated");
    requireSuccess("Gemini extension install", hostPath, ["extensions", "install", extensionRoot, "--consent", "--skip-settings"], geminiOptions);
    installed = true;
    verifyLayer(progress, "extension-installed");
    const listed = requireSuccess("Gemini extension list", hostPath, ["extensions", "list", "--output-format", "json"], geminiOptions);
    if (!contains(listed.stdout + listed.stderr, "switchbot")) throw new Error("Gemini did not list the installed SwitchBot extension.");
    verifyLayer(progress, "extension-listed");
    requireSuccess("Gemini extension update", hostPath, ["extensions", "update", "switchbot"], geminiOptions);
    verifyLayer(progress, "extension-updated");
    const { toolNames, readonly } = await verifyMcpCatalog(env);
    verifyLayer(progress, "mcp-tool-catalog", { toolCount: toolNames.length, tools: toolNames });
    verifyLayer(progress, "device-history-raw", { readonly });
    return { toolCount: toolNames.length, tools: toolNames, readonly };
  } finally {
    if (installed) {
      requireSuccess("Gemini extension uninstall", hostPath, ["extensions", "uninstall", "switchbot"], geminiOptions);
      verifyLayer(progress, "extension-uninstalled");
    }
  }
}

async function verifyOpenClaw(hostPath, env, _workDir, progress) {
  const packageRoot = path.join(candidate, 'packages', 'openclaw-skill');
  const bundleName = JSON.parse(readFileSync(path.join(packageRoot, '.claude-plugin', 'plugin.json'), 'utf8')).name;
  requireSuccess('OpenClaw bundle install', hostPath, [
    'plugins', 'install', packageRoot, '--link', '--force', '--accept-capabilities',
  ], { env });
  verifyLayer(progress, 'bundle-installed');
  try {
    const listed = requireSuccess('OpenClaw plugin list', hostPath, ['plugins', 'list', '--json'], { env });
    if (!contains(listed.stdout + listed.stderr, bundleName)) throw new Error('OpenClaw did not discover the SwitchBot bundle.');
    verifyLayer(progress, 'bundle-discovered');
    const inspected = requireSuccess('OpenClaw bundle inspect', hostPath, ['plugins', 'inspect', bundleName, '--json'], { env });
    let inspection;
    try { inspection = JSON.parse(inspected.stdout); } catch { throw new Error('OpenClaw bundle inspection did not return JSON.'); }
    verifyLayer(progress, 'bundle-inspected', { inspection });
    if (inspection.plugin?.format !== 'bundle' || inspection.plugin?.bundleFormat !== 'claude' || inspection.plugin?.status !== 'loaded') {
      throw new Error(`OpenClaw did not load the expected Claude bundle: ${inspection.plugin?.error ?? inspection.plugin?.status ?? 'unknown plugin status'}.`);
    }
    if (!Array.isArray(inspection.mcpServers) || !inspection.mcpServers.some((server) => server.name === bundleName && server.hasStdioTransport === true)) {
      throw new Error('OpenClaw did not expose the expected SwitchBot stdio MCP server.');
    }
    verifyLayer(progress, 'bundle-loaded');
    requireSuccess('OpenClaw bundle reinstall', hostPath, [
      'plugins', 'install', packageRoot, '--link', '--force', '--accept-capabilities',
    ], { env });
    verifyLayer(progress, 'bundle-reinstalled');
    const { toolNames, readonly } = await verifyMcpCatalog(env, process.execPath, [path.join(packageRoot, "bin", "start.js")]);
    verifyLayer(progress, "bootstrap-mcp-started");
    verifyLayer(progress, "mcp-tool-catalog", { toolCount: toolNames.length, tools: toolNames });
    verifyLayer(progress, "device-history-raw", { readonly });
    return { toolCount: toolNames.length, tools: toolNames, readonly, inspection, nativePlugin: false };
  } finally {
    requireSuccess('OpenClaw bundle uninstall', hostPath, ['plugins', 'uninstall', bundleName, '--force'], { env });
    verifyLayer(progress, 'bundle-uninstalled');
  }
}

function blockedReason(error) {
  const detail = error.message.toLowerCase();
  if (/credential|authentication|auth|token|secret|setup required/.test(detail)) return 'host_bootstrap_failed';
  if (/unknown command|unsupported|not available|not recognized/.test(detail)) return 'host_unsupported';
  return 'host_runtime_failed';
}

function persistEvidence(record) {
  if (evidencePath) writeFileSync(path.resolve(evidencePath), `${JSON.stringify(record, null, 2)}\n`);
}

function writeEvidence(record) {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  persistEvidence(record);
  process.stdout.write(text);
}

async function main() {
  if (requestedHosts.some((name) => !validHosts.has(name))) throw new Error(`Unknown host: ${host}. Use codex, claude, gemini, openclaw, or all.`);
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-host-runtime-'));
  const record = {
    timestamp: new Date().toISOString(),
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    candidate: { path: candidate, cliVersion: null, packages: {}, provenance: candidateProvenance() },
    credentialFixture: 'dummy-local-only',
    cloudAuthentication: 'not exercised; local readonly operation only',
    required, hosts: [], status: 'passed',
  };
  persistEvidence(record);
  try {
    const cliEntrypoint = path.resolve(argument('--candidate-cli') ?? path.join(candidate, 'dist', 'index.js'));
    if (!existsSync(cliEntrypoint)) throw new Error(`Candidate CLI artifact is missing: ${cliEntrypoint}. Build the exact release candidate before host verification.`);
    const env = isolatedEnvironment(workDir, cliEntrypoint);
    const cliVersion = requireSuccess('candidate CLI version', process.execPath, [cliEntrypoint, '--version'], { env });
    record.candidate.cliVersion = cliVersion.stdout.trim();
    const packageCliVersion = packageVersion(".");
    if (record.candidate.cliVersion !== packageCliVersion) {
      throw new Error(`Candidate CLI artifact version ${record.candidate.cliVersion} does not match package version ${packageCliVersion}.`);
    }
    record.candidate.packages = {
      codex: packageVersion('packages/codex-plugin'),
      claude: packageVersion('packages/claude-code-plugin'),
      gemini: JSON.parse(readFileSync(path.join(candidate, 'packages/gemini-extension/gemini-extension.json'), 'utf8')).version,
      openclaw: packageVersion('packages/openclaw-skill'),
    };
    for (const name of requestedHosts) {
      const binary = name === 'claude' ? 'claude' : name;
      const hostPath = commandPath(binary);
      if (!hostPath) {
        record.hosts.push({ name, status: 'blocked', reason: 'host_missing' });
        record.status = 'blocked';
        persistEvidence(record);
        continue;
      }
      const version = resultOf(hostPath, ['--version'], { env }).stdout.trim();
      const running = { name, binary: hostPath, version, status: 'running' };
      record.hosts.push(running);
      persistEvidence(record);
      const verify = { codex: verifyCodex, claude: verifyClaude, gemini: verifyGemini, openclaw: verifyOpenClaw }[name];
      const progress = { layers: [] };
      try {
        const outcome = await verify(hostPath, env, workDir, progress);
        Object.assign(running, progress, { status: 'passed', ...outcome });
      } catch (error) {
        Object.assign(running, progress, { status: 'blocked', reason: blockedReason(error), detail: error.message });
        record.status = 'blocked';
      }
      persistEvidence(record);
    }
  } catch (error) {
    record.status = 'blocked';
    record.prerequisite = error.message;
  } finally {
    writeEvidence(record);
    rmSync(workDir, { recursive: true, force: true });
  }
  if (record.status !== 'passed' && required) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`host runtime smoke failed: ${error.message}`);
  process.exitCode = 1;
});
