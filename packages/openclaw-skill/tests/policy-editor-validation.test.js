import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const policySource = 'version: "0.2"\naliases:\n  kitchen: device-1\n';
let server;
let policyPath;
let policyDirectory;
let previousPolicyPath;

before(async () => {
  policyDirectory = await mkdtemp(join(tmpdir(), 'switchbot-policy-editor-'));
  policyPath = join(policyDirectory, 'policy.yaml');
  await writeFile(policyPath, policySource);
  previousPolicyPath = process.env.SWITCHBOT_POLICY_PATH;
  process.env.SWITCHBOT_POLICY_PATH = policyPath;
  const module = await import('../policy-editor/server.js?validation=' + Date.now());
  server = await module.startEditorServer({ port: 0 });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (previousPolicyPath === undefined) delete process.env.SWITCHBOT_POLICY_PATH;
  else process.env.SWITCHBOT_POLICY_PATH = previousPolicyPath;
  await rm(policyDirectory, { recursive: true, force: true });
});

function postChunkedJson(pathname, body, splitAt) {
  return new Promise((resolve, reject) => {
    const requestBody = Buffer.from(JSON.stringify(body));
    const firstChunkReceived = new Promise((continueRequest) => {
      server.once('request', (incoming) => {
        if (incoming.url === pathname) incoming.once('data', continueRequest);
      });
    });
    const requestOptions = {
      hostname: '127.0.0.1',
      port: server.port,
      path: pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': requestBody.length },
    };
    const clientRequest = request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    clientRequest.on('error', reject);
    clientRequest.write(requestBody.subarray(0, splitAt));
    firstChunkReceived.then(() => clientRequest.end(requestBody.subarray(splitAt)), reject);
  });
}

describe('policy editor save validation', () => {
  it('preserves UTF-8 split across request chunks when reading editor state', async () => {
    const source = 'version: "0.2"\naliases:\n  café: device-1\n';
    const encoded = Buffer.from(JSON.stringify({ source }));
    const accent = Buffer.from('é');
    const accentOffset = encoded.indexOf(accent);
    assert.ok(accentOffset > 0);

    const response = await postChunkedJson('/policy/state', { source }, accentOffset + 1);

    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body).aliases, { café: 'device-1' });
  });

  it('rejects transient malformed raw YAML without terminating the editor', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/policy/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'aliases: {unterminated\n' }),
    });
    assert.equal(response.status, 400);
    const current = await fetch(`http://127.0.0.1:${server.port}/policy`);
    assert.equal(current.status, 200);
    assert.equal(await current.text(), policySource);
  });

  it('rejects an invalid document without overwriting the existing policy', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'aliases: {unterminated\n',
    });

    assert.equal(response.status, 400);
    assert.equal(await readFile(policyPath, 'utf8'), policySource);
  });
});
