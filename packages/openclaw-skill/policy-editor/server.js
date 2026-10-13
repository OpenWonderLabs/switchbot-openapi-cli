// policy-editor/server.js
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml';
import { switchbotInvocation } from '../setup/cli-invocation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultPolicyPath = process.env.SWITCHBOT_POLICY_PATH
  ?? path.join(process.env.HOME ?? process.env.USERPROFILE, '.config/openclaw/switchbot/policy.yaml');
const INITIAL_POLICY = "version: \"0.2\"\n";

function validateYaml(source) {
  const document = parseDocument(source);
  if (document.errors.length > 0) return document.errors[0].message;
  return null;
}

function rootMap(document) {
  if (!(document.contents instanceof YAMLMap)) {
    if (document.contents === null) document.contents = document.createNode({});
    else throw new Error('policy root must be a mapping');
  }
  return document.contents;
}

function mapValue(document, parent, key) {
  const existing = parent.get(key, true);
  if (existing instanceof YAMLMap) return existing;
  const next = document.createNode({});
  parent.set(key, next);
  return next;
}

function sequenceValue(document, parent, key) {
  const existing = parent.get(key, true);
  if (existing instanceof YAMLSeq) return existing;
  const next = document.createNode([]);
  parent.set(key, next);
  return next;
}

function editPolicySource(source, edit) {
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error(document.errors[0].message);
  const root = rootMap(document);
  if (edit.kind === 'alias') {
    if (typeof edit.alias !== 'string' || edit.alias.trim() === '' || typeof edit.deviceId !== 'string' || edit.deviceId.trim() === '') {
      throw new Error('alias and device ID are required');
    }
    mapValue(document, root, 'aliases').set(edit.alias.trim(), edit.deviceId.trim());
  } else if (edit.kind === 'delete-alias') {
    if (typeof edit.alias !== 'string' || edit.alias.trim() === '') throw new Error('alias is required');
    const aliases = root.get('aliases', true);
    if (aliases instanceof YAMLMap) aliases.delete(edit.alias);
  } else if (edit.kind === 'confirm-lock') {
    const confirmations = mapValue(document, root, 'confirmations');
    const commands = sequenceValue(document, confirmations, 'always_confirm');
    const next = commands.items.filter((item) => item?.value !== 'lock' && item?.value !== 'unlock');
    if (edit.enabled === true) next.push(document.createNode('lock'), document.createNode('unlock'));
    commands.items = next;
  } else if (edit.kind === 'quiet-hours') {
    if (typeof edit.start !== 'string' || typeof edit.end !== 'string') throw new Error('quiet hours are required');
    const quietHours = mapValue(document, root, 'quiet_hours');
    quietHours.set('start', edit.start);
    quietHours.set('end', edit.end);
  } else {
    throw new Error('unknown policy edit');
  }
  return String(document);
}

function policyState(source) {
  const document = parseDocument(source, { keepSourceTokens: true });
  if (document.errors.length > 0) throw new Error(document.errors[0].message);
  const root = rootMap(document);
  const aliases = root.get('aliases', true);
  const aliasEntries = aliases instanceof YAMLMap
    ? aliases.items.flatMap((pair) => typeof pair.key?.value === 'string' && typeof pair.value?.value === 'string'
      ? [[pair.key.value, pair.value.value]]
      : [])
    : [];
  const confirmations = root.get('confirmations', true);
  const alwaysConfirm = confirmations instanceof YAMLMap ? confirmations.get('always_confirm', true) : null;
  const commands = alwaysConfirm instanceof YAMLSeq
    ? alwaysConfirm.items.flatMap((item) => typeof item?.value === 'string' ? [item.value] : [])
    : [];
  const quietHours = root.get('quiet_hours', true);
  return {
    aliases: Object.fromEntries(aliasEntries),
    confirmLock: commands.includes('lock') || commands.includes('unlock'),
    quietStart: quietHours instanceof YAMLMap && typeof quietHours.get('start') === 'string' ? quietHours.get('start') : '22:00',
    quietEnd: quietHours instanceof YAMLMap && typeof quietHours.get('end') === 'string' ? quietHours.get('end') : '07:00',
  };
}

function validateSchema(candidatePath) {
  try {
    const invocation = switchbotInvocation(['policy', 'validate', candidatePath, '--json']);
    execFileSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 10_000,
      windowsHide: true,
    });
    return null;
  } catch (error) {
    const stdout = error instanceof Error && 'stdout' in error ? String(error.stdout).trim() : '';
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : '';
    try {
      const payload = JSON.parse(stdout);
      const data = payload?.data ?? payload;
      if (Array.isArray(data?.errors) && data.errors.length > 0) {
        return data.errors.map((item) => `${item.instancePath || item.path || 'policy'}: ${item.message || 'invalid value'}`).join('; ');
      }
    } catch {
      // A non-JSON diagnostic remains useful below.
    }
    return stderr || stdout || 'policy failed SwitchBot CLI schema validation';
  }
}

function validatedCandidate(policyPath, source) {
  const yamlError = validateYaml(source);
  if (yamlError) return { error: yamlError };

  const directory = path.dirname(policyPath);
  mkdirSync(directory, { recursive: true });
  const temporaryDirectory = mkdtempSync(path.join(directory, '.switchbot-policy-'));
  const candidatePath = path.join(temporaryDirectory, 'policy.yaml');
  writeFileSync(candidatePath, source, 'utf8');
  const schemaError = validateSchema(candidatePath);
  if (schemaError) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    return { error: schemaError };
  }
  return { candidatePath, temporaryDirectory };
}

export function startEditorServer({ port = 18799, dryRun = false, policyPath = defaultPolicyPath } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const html = readFileSync(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'GET' && req.url === '/policy') {
      const content = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : INITIAL_POLICY;
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
    } else if (req.method === 'POST' && (req.url === '/policy' || req.url === '/policy/edit' || req.url === '/policy/state')) {
      const chunks = [];
      let bodyBytes = 0;
      const maxBytes = 512 * 1024;
      req.on('data', (chunk) => {
        bodyBytes += chunk.length;
        if (bodyBytes > maxBytes) {
          res.writeHead(413); res.end('payload too large');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (res.headersSent) return;
        const body = Buffer.concat(chunks, bodyBytes).toString('utf8');
        if (req.url === '/policy/edit' || req.url === '/policy/state') {
          try {
            const request = JSON.parse(body);
            if (typeof request?.source !== 'string') throw new Error('source is required');
            if (req.url === '/policy/state') {
              const state = policyState(request.source);
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify(state));
            } else {
              if (!request.edit || typeof request.edit !== 'object') throw new Error('edit is required');
              const transformed = editPolicySource(request.source, request.edit);
              res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end(transformed);
            }
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`invalid policy edit: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        }
        const yamlError = validateYaml(body);
        if (yamlError) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`invalid policy YAML: ${yamlError}`);
          return;
        }
        if (!dryRun) {
          const candidate = validatedCandidate(policyPath, body);
          if ('error' in candidate) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`invalid policy: ${candidate.error}`);
            return;
          }
          try {
            renameSync(candidate.candidatePath, policyPath);
          } finally {
            rmSync(candidate.temporaryDirectory, { recursive: true, force: true });
          }
        }
        res.writeHead(200); res.end('saved');
      });
    } else if (req.method === 'GET' && /^\/(editor\.js|style\.css)$/.test(req.url)) {
      const file = path.join(__dirname, req.url);
      const mime = req.url.endsWith('.js') ? 'application/javascript' : 'text/css';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(readFileSync(file));
    } else {
      res.writeHead(404); res.end();
    }
  });

  return new Promise((resolve) => {
    server.listen(dryRun ? 0 : port, '127.0.0.1', () => {
      const address = server.address();
      server.port = address.port;
      resolve(server);
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startEditorServer();
  const url = `http://localhost:${server.port}`;
  console.log(`Policy editor running at ${url}`);
  try {
    const open = (await import('open')).default;
    await open(url);
  } catch {
    console.log(`Open your browser: ${url}`);
  }
}
