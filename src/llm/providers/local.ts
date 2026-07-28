import https from 'node:https';
import http from 'node:http';
import type { LLMProvider, LLMProviderOptions, DecideResult, DecideOptions, ProviderCapabilities } from '../provider.js';
import { calculateCostUsd } from '../pricing.js';
import { decideViaStructuredOutput } from './structured-output-fallback.js';

const DEFAULT_LOCAL_BASE_URL = 'http://localhost:11434/v1';

/**
 * LocalProvider points at any OpenAI-compatible /v1/chat/completions endpoint
 * — Ollama, llama.cpp server, vLLM, LM Studio, etc. By default we assume the
 * endpoint does NOT support structured tool use and route `decide()` through
 * the JSON-instruction + repair fallback. Operators can flip this with
 * `toolUse: true` in YAML or via the `SWITCHBOT_LOCAL_LLM_TOOL_USE=1` env.
 */
export class LocalProvider implements LLMProvider {
  readonly name = 'local';
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(opts: LLMProviderOptions = {}) {
    this.apiKey = process.env.SWITCHBOT_LOCAL_LLM_API_KEY ?? process.env.LOCAL_LLM_API_KEY ?? '';
    this.model = opts.model ?? process.env.SWITCHBOT_LOCAL_LLM_MODEL ?? 'llama3.2';
    this.baseUrl = stripTrailingV1(opts.baseUrl ?? process.env.SWITCHBOT_LOCAL_LLM_URL ?? DEFAULT_LOCAL_BASE_URL);
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxTokens = opts.maxTokens ?? 1024;

    const envToolUse = parseBoolEnv(process.env.SWITCHBOT_LOCAL_LLM_TOOL_USE);
    const toolUse = opts.toolUse ?? envToolUse ?? false;
    this.capabilities = { toolUse };
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

    const url = new URL(`${this.baseUrl}/v1/chat/completions`);
    const isHttps = url.protocol === 'https:';
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
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
              reject(new Error(`Local LLM API error ${res.statusCode}: ${text.slice(0, 200)}`));
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
    if (!content) throw new Error('Local LLM returned empty content');
    return content.replace(/^```ya?ml\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  }

  async decide(prompt: string, opts: DecideOptions = {}): Promise<DecideResult> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    if (!this.capabilities.toolUse) {
      return decideViaStructuredOutput({
        prompt,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        model: this.model,
        timeoutMs,
        maxTokens: 256,
        computeCostUsd: calculateCostUsd,
      });
    }

    // Tool-use path: same wire format as OpenAI provider.
    const body = JSON.stringify({
      model: this.model,
      max_tokens: 256,
      tools: [{
        type: 'function',
        function: {
          name: 'decide',
          description: 'Return a boolean pass/fail decision with a brief reason.',
          parameters: {
            type: 'object',
            properties: {
              pass: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['pass', 'reason'],
          },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'decide' } },
      messages: [{ role: 'user', content: prompt }],
    });

    const url = new URL(`${this.baseUrl}/v1/chat/completions`);
    const isHttps = url.protocol === 'https:';
    const responseBody = await new Promise<string>((resolve, reject) => {
      const req = (isHttps ? https : http).request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
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
              reject(new Error(`Local LLM API error ${res.statusCode}: ${text.slice(0, 200)}`));
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
      choices: Array<{
        message: {
          tool_calls?: Array<{ function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const toolCall = json.choices?.[0]?.message?.tool_calls?.find(tc => tc.function.name === 'decide');
    if (!toolCall) throw new Error('Local LLM decide: no tool call in response');
    const args = JSON.parse(toolCall.function.arguments) as { pass: boolean; reason: string };
    if (typeof args.pass !== 'boolean') throw new Error('Local LLM decide: malformed function-call response');
    const tokensIn = json.usage?.prompt_tokens ?? 0;
    const tokensOut = json.usage?.completion_tokens ?? 0;
    const usage = json.usage
      ? { tokensIn, tokensOut, costUsd: calculateCostUsd(this.model, tokensIn, tokensOut) }
      : undefined;
    return { pass: args.pass, reason: String(args.reason ?? '').slice(0, 200), usage };
  }

  /** Exposed for doctor `local-llm-reachable` check. */
  getEndpoint(): string {
    return this.baseUrl;
  }
}

function stripTrailingV1(url: string): string {
  return url.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

function parseBoolEnv(v: string | undefined): boolean | undefined {
  if (!v) return undefined;
  const lower = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  return undefined;
}
