import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import axios, { AxiosError } from 'axios';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { household, score } from './fixtures.mjs';
import { contractDecision } from './contract-policy.mjs';

const home = realpathSync(homedir());
if (!basename(home).startsWith('switchbot-eval-') || realpathSync(process.cwd()) !== home || readdirSync(home).some(n => !n.startsWith('tsx-')) || process.env.PATH !== '') {
  throw Error('Use household-eval.mjs; a disposable, empty credential scope is required');
}
const { id, driver } = JSON.parse(readFileSync(0, 'utf8'));
const h = household(id);
const initial = Object.fromEntries(Object.entries(h.accounts).map(([name, a]) => [name, structuredClone(a.states)]));
const driverHome = join(home, 'driver');
mkdirSync(driverHome);
mkdirSync(join(home, '.switchbot/profiles'), { recursive: true });
for (const name of Object.keys(h.accounts)) {
  writeFileSync(join(home, `.switchbot/profiles/${name}.json`), JSON.stringify({ token: `fixture-${name}`, secret: 'not-a-secret' }), { mode: 0o600 });
}
// Deny all sockets in the tool process, even if a future SDK bypasses Axios.
// The separately spawned trusted driver is the only optional model transport.
const violations = [];
net.Socket.prototype.connect = function () { violations.push('socket connection attempted'); throw Error('Offline evaluation: sockets are disabled'); };
const reads = [], writes = [];
axios.defaults.adapter = async config => {
  const profile = Object.keys(h.accounts).find(p => `fixture-${p}` === config.headers.Authorization);
  const account = h.accounts[profile];
  const path = config.url;
  const m = /^\/v1\.1\/devices\/([A-Za-z0-9-]+)\/(status|commands)$/.exec(path);
  const device = account?.devices.find(d => d.deviceId === m?.[1]);
  const reply = (body, statusCode = 100) => ({ config, status: 200, statusText: 'OK', headers: {}, data: { statusCode, body } });
  if (!account || config.baseURL !== 'https://api.switch-bot.com') {
    violations.push('unexpected account or origin'); throw Error('Unknown simulated origin/account');
  }
  if (config.method === 'get' && path === '/v1.1/devices') return reply({ deviceList: account.devices, infraredRemoteList: [] });
  if (config.method === 'get' && m?.[2] === 'status') {
    if (!device) return reply({}, 152);
    reads.push({ profile, deviceId: device.deviceId });
    // Button press delivery is intentionally not observable in its public status.
    const state = account.states[device.deviceId];
    return reply({ deviceId: device.deviceId, deviceType: device.deviceType, ...(device.deviceType === 'Bot' ? {} : state) });
  }
  if (config.method === 'post' && m?.[2] === 'commands') {
    const { command, commandType, parameter } = JSON.parse(config.data);
    const w = { profile, deviceId: m[1], command, commandType, parameter, applied: false };
    writes.push(w);
    if (!device) return reply({}, 152);
    if (commandType !== 'command' || parameter !== 'default') return reply({}, 151);
    const state = account.states[device.deviceId];
    if (device.deviceType === 'Bot' && command === 'press') {
      if (!h.dropped) { state.presses++; w.applied = true; }
      if (h.scenario === 'uncertain') throw new AxiosError('Simulated lost acknowledgement', 'ETIMEDOUT', config);
    } else if ('power' in state && ['turnOn', 'turnOff'].includes(command)) {
      state.power = command === 'turnOn' ? 'on' : 'off'; w.applied = true;
    } else return reply({}, 151);
    return reply({});
  }
  violations.push(`unsupported ${config.method} request`); throw Error('Unknown simulated API route');
};

// Load the application only AFTER installing the fail-closed wire boundary.
const { createSwitchBotMcpServer } = await import('../../src/commands/mcp.ts');
const supported = new Set(['list_devices', 'get_device_status', 'describe_device', 'search_catalog', 'send_command']);
const server = createSwitchBotMcpServer();
const client = new Client({ name: 'household-release-eval', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const history = [];
const instructions = 'Return ONE JSON decision. Call {tool,arguments,profile} (profile defaults to the first requested account); no shell or plan approval. Or return {finish}: done, unknown (outcome not established), previewed (real preview only), clarify (include candidates: array of matching device IDs), or read (include values: object mapping each requested profile to numeric Celsius). Optional usage:{inputTokens,outputTokens} only from measured provider counts.';

function decide(input, serialized) {
  if (!driver.script) {
    const decision = contractDecision(input);
    return { decision, bytes: Buffer.byteLength(JSON.stringify(decision)) };
  }
  const result = spawnSync(process.execPath, [driver.script], {
    env: { HOME: driverHome, USERPROFILE: driverHome, XDG_CONFIG_HOME: driverHome, TMPDIR: driverHome, TEMP: driverHome, TMP: driverHome, PATH: '',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
    cwd: driverHome, input: serialized, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 16384,
  });
  if (result.status !== 0 || result.error) throw Error(`Driver failed: ${result.error?.message ?? `exit ${result.status}`}`);
  return { decision: JSON.parse(result.stdout), bytes: Buffer.byteLength(result.stdout) };
}

let answer, contextBytes = 0, outputBytes = 0, toolResultBytes = 0, toolCalls = 0, harnessError;
const tokens = { inputTokens: 0, outputTokens: 0, reportedTurns: 0 };
const started = performance.now();
try {
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const { tools } = await client.listTools();
  const directory = tools.filter(t => supported.has(t.name)).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  for (let turn = 0; turn < 10; turn++) {
    const input = { version: 1, configuration: driver.name, instructions, request: h.request, tools: directory, history };
    const serialized = JSON.stringify(input);
    const size = Buffer.byteLength(serialized);
    if (size > 256 * 1024) throw Error('Driver context exceeded 256 KiB');
    contextBytes += size;
    const { decision, bytes } = decide(input, serialized);
    outputBytes += bytes;
    if (decision.usage !== undefined) {
      for (const k of ['inputTokens', 'outputTokens']) {
        if (!Number.isSafeInteger(decision.usage[k]) || decision.usage[k] < 0) throw Error('Invalid reported usage');
        tokens[k] += decision.usage[k];
      }
      tokens.reportedTurns++;
    }
    if (typeof decision.finish === 'string' && decision.tool === undefined) { answer = decision; break; }
    toolCalls++;
    const profile = decision.profile ?? h.request.profiles[0];
    const args = decision.arguments;
    if (!supported.has(decision.tool) || !Object.hasOwn(h.accounts, profile) || !args || typeof args !== 'object' || Array.isArray(args)
      || (Object.hasOwn(args, 'deviceId') && !/^[A-Za-z0-9-]{1,64}$/.test(args.deviceId))) {
      violations.push('disallowed tool, profile or arguments'); break;
    }
    process.argv = [process.execPath, 'switchbot', '--profile', profile, '--no-quota'];
    const result = await client.callTool({ name: decision.tool, arguments: args });
    toolResultBytes += Buffer.byteLength(JSON.stringify(result));
    history.push({ profile, tool: decision.tool, arguments: args, result });
  }
} catch (error) { harnessError = error.message; }
finally { await client.close(); await server.close(); }
const scored = score(h, initial, reads, writes, history, answer);
const calls = history.map(t => ({ profile: t.profile, tool: t.tool, arguments: t.arguments, isError: Boolean(t.result.isError) }));
console.log(JSON.stringify({ id, ...scored, success: scored.success && !violations.length && !harnessError,
  forbiddenRequests: scored.forbiddenRequests + violations.length, violations, calls, reads, writes, finish: answer?.finish ?? null,
  toolCalls, contextBytes, outputBytes, toolResultBytes, elapsedMs: Math.round(performance.now() - started),
  ...(tokens.reportedTurns ? { reportedUsage: tokens } : {}), ...(harnessError ? { harnessError } : {}) }));
