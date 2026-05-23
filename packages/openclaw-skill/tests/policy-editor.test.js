import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEditorServer } from '../policy-editor/server.js';

describe('policy editor server', () => {
  let server;
  before(async () => {
    server = await startEditorServer({ port: 0, dryRun: true });
  });
  after(() => server.close());

  it('starts on a random port', () => {
    assert.ok(server.port > 0);
  });

  it('GET / returns HTML', async () => {
    const res = await fetch(`http://localhost:${server.port}/`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('<html'));
  });

  it('GET /policy returns text', async () => {
    const res = await fetch(`http://localhost:${server.port}/policy`);
    assert.equal(res.status, 200);
  });

  it('POST /policy returns saved', async () => {
    const res = await fetch(`http://localhost:${server.port}/policy`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'version: "0.2"',
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.equal(text, 'saved');
  });
});
