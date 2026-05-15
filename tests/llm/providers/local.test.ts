import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { LocalProvider } from '../../../src/llm/providers/local.js';

interface StubServer {
  url: string;
  close: () => Promise<void>;
  requests: Array<{ path: string; body: unknown }>;
}

async function startStubServer(handler: (req: { body: unknown }, res: http.ServerResponse) => void): Promise<StubServer> {
  const requests: Array<{ path: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      let body: unknown = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      requests.push({ path: req.url ?? '', body });
      handler({ body }, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('Failed to bind stub server');
  const url = `http://127.0.0.1:${addr.port}`;
  return {
    url,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('LocalProvider', () => {
  let server: StubServer | null = null;

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    delete process.env.SWITCHBOT_LOCAL_LLM_TOOL_USE;
    delete process.env.SWITCHBOT_LOCAL_LLM_URL;
  });

  it('declares toolUse:false by default (matches local LLM reality)', () => {
    const p = new LocalProvider({ baseUrl: 'http://localhost:11434' });
    expect(p.capabilities.toolUse).toBe(false);
    expect(p.name).toBe('local');
  });

  it('respects explicit toolUse:true override from constructor', () => {
    const p = new LocalProvider({ baseUrl: 'http://localhost:11434', toolUse: true });
    expect(p.capabilities.toolUse).toBe(true);
  });

  it('respects SWITCHBOT_LOCAL_LLM_TOOL_USE=1 env', () => {
    process.env.SWITCHBOT_LOCAL_LLM_TOOL_USE = '1';
    const p = new LocalProvider({ baseUrl: 'http://localhost:11434' });
    expect(p.capabilities.toolUse).toBe(true);
  });

  it('decide() (no tool use) parses JSON from chat completion response', async () => {
    server = await startStubServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"pass": true, "reason": "all systems nominal"}' } }],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      }));
    });
    const p = new LocalProvider({ baseUrl: server.url, model: 'llama3.2' });
    const result = await p.decide('Is the door locked?');
    expect(result.pass).toBe(true);
    expect(result.reason).toBe('all systems nominal');
    expect(result.usage?.tokensIn).toBe(30);
    expect(result.usage?.tokensOut).toBe(10);
  });

  it('decide() retries with repair instruction when first response is not JSON', async () => {
    let callCount = 0;
    server = await startStubServer((_req, res) => {
      callCount++;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      const body = callCount === 1
        ? { choices: [{ message: { content: 'I think the answer is no' } }] }
        : { choices: [{ message: { content: '{"pass": false, "reason": "no match"}' } }] };
      res.end(JSON.stringify(body));
    });
    const p = new LocalProvider({ baseUrl: server.url, model: 'llama3.2' });
    const result = await p.decide('Is condition X true?');
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('no match');
    expect(server.requests.length).toBe(2);
  });

  it('decide() (no tool use) sends NO tools field in the request body', async () => {
    server = await startStubServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"pass": true, "reason": "ok"}' } }],
      }));
    });
    const p = new LocalProvider({ baseUrl: server.url });
    await p.decide('test');
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('decide() throws when both attempts fail to produce parseable JSON', async () => {
    server = await startStubServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: 'I really cannot give you JSON sorry' } }],
      }));
    });
    const p = new LocalProvider({ baseUrl: server.url });
    await expect(p.decide('test')).rejects.toThrow(/Structured output fallback could not parse/);
  });

  it('decide() (tool use enabled) sends tool_choice=decide and parses tool_calls', async () => {
    server = await startStubServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: 'decide', arguments: JSON.stringify({ pass: true, reason: 'tool path' }) } }] } }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
    });
    const p = new LocalProvider({ baseUrl: server.url, toolUse: true });
    const result = await p.decide('hello');
    expect(result.pass).toBe(true);
    expect(result.reason).toBe('tool path');
    const body = server.requests[0].body as Record<string, unknown>;
    expect(body.tools).toBeDefined();
    expect(body.tool_choice).toBeDefined();
  });

  it('strips trailing /v1 in baseUrl so we do not double-up the path', () => {
    const p = new LocalProvider({ baseUrl: 'http://localhost:11434/v1' });
    expect(p.getEndpoint()).toBe('http://localhost:11434');
  });
});
