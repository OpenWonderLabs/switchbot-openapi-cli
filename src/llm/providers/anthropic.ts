import https from 'node:https';
import type { LLMProvider, LLMProviderOptions, DecideResult, DecideOptions } from '../provider.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(opts: LLMProviderOptions = {}) {
    const key = process.env.ANTHROPIC_API_KEY ?? process.env.LLM_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY or LLM_API_KEY environment variable required for anthropic backend');
    this.apiKey = key;
    this.model = opts.model ?? 'claude-haiku-4-5-20251001';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  async generateYaml(systemPrompt: string, userIntent: string): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userIntent }],
    });

    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          port: 443,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              reject(new Error(`Anthropic API error ${res.statusCode}: ${text.slice(0, 200)}`));
            } else {
              resolve(text);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('LLM request timeout')));
      req.write(body);
      req.end();
    });

    const json = JSON.parse(responseBody) as { content: Array<{ type: string; text: string }> };
    const content = json.content?.find(c => c.type === 'text')?.text;
    if (!content) throw new Error('Anthropic returned empty content');
    return content.replace(/^```ya?ml\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }

  async decide(prompt: string, opts: DecideOptions = {}): Promise<DecideResult> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const body = JSON.stringify({
      model: this.model,
      max_tokens: 256,
      tools: [{
        name: 'decide',
        description: 'Return a boolean pass/fail decision with a brief reason.',
        input_schema: {
          type: 'object',
          properties: {
            pass: { type: 'boolean', description: 'true if the condition passes, false otherwise.' },
            reason: { type: 'string', description: 'Brief reason (≤200 chars).' },
          },
          required: ['pass', 'reason'],
        },
      }],
      tool_choice: { type: 'tool', name: 'decide' },
      messages: [{ role: 'user', content: prompt }],
    });

    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.anthropic.com',
          port: 443,
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            if (res.statusCode !== undefined && res.statusCode >= 400) {
              reject(new Error(`Anthropic API error ${res.statusCode}: ${text.slice(0, 200)}`));
            } else {
              resolve(text);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('LLM request timeout')));
      req.write(body);
      req.end();
    });

    const json = JSON.parse(responseBody) as {
      content: Array<{ type: string; name?: string; input?: { pass: boolean; reason: string } }>;
    };
    const toolUse = json.content?.find(c => c.type === 'tool_use' && c.name === 'decide');
    if (!toolUse?.input || typeof toolUse.input.pass !== 'boolean') {
      throw new Error('Anthropic decide: malformed tool-use response');
    }
    return { pass: toolUse.input.pass, reason: String(toolUse.input.reason ?? '').slice(0, 200) };
  }
}

