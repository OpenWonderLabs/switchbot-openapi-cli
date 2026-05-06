import https from 'node:https';
import http from 'node:http';
import type { LLMProvider, LLMProviderOptions } from '../provider.js';

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(opts: LLMProviderOptions = {}) {
    const key = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY or LLM_API_KEY environment variable required for openai backend');
    this.apiKey = key;
    this.model = opts.model ?? 'gpt-4o-mini';
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxTokens = opts.maxTokens ?? 2048;
  }

  async generateYaml(systemPrompt: string, userIntent: string): Promise<string> {
    const body = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userIntent },
      ],
      max_tokens: this.maxTokens,
      temperature: 0,
    });

    const parsed = new URL(`${this.baseUrl}/v1/chat/completions`);
    const isHttps = parsed.protocol === 'https:';
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
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
              reject(new Error(`OpenAI API error ${res.statusCode}: ${text.slice(0, 200)}`));
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

    const json = JSON.parse(responseBody) as { choices: Array<{ message: { content: string } }> };
    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI returned empty content');
    return content.replace(/^```ya?ml\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }
}
