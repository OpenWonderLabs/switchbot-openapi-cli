import https from 'node:https';
import http from 'node:http';
import type { DecideResult, DecideUsage } from '../provider.js';

export interface StructuredCallOptions {
  prompt: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxTokens?: number;
  /** Optional override for the costUsd hook. */
  computeCostUsd?: (model: string, tokensIn: number, tokensOut: number) => number | undefined;
}

const SYSTEM_INSTRUCTION = [
  'You are a yes/no decision endpoint for a smart-home rule engine.',
  'Read the user prompt and reply with ONLY a JSON object in this exact shape:',
  '{"pass": <true|false>, "reason": "<brief explanation, ≤200 chars>"}',
  'No prose, no markdown fences, no extra fields. The JSON must be valid and parseable.',
].join(' ');

const FEW_SHOT_EXAMPLE = [
  'Example input: "Is the front door locked? Status: lockState=lock"',
  'Example output: {"pass": true, "reason": "lockState reports lock"}',
].join(' ');

const REPAIR_INSTRUCTION = [
  'Your previous response was not valid JSON.',
  'Reply with ONLY the JSON object: {"pass": <true|false>, "reason": "<short>"}.',
  'No prose, no markdown.',
].join(' ');

/**
 * Calls a chat-completions endpoint without tool use, asks the model to return
 * a JSON object describing the decision, and parses it. Performs one repair
 * round-trip if the first response is not parseable.
 */
export async function decideViaStructuredOutput(opts: StructuredCallOptions): Promise<DecideResult> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: `${SYSTEM_INSTRUCTION} ${FEW_SHOT_EXAMPLE}` },
    { role: 'user', content: opts.prompt },
  ];

  const first = await chatCompletion(opts, messages);
  const parsed = tryParseDecision(first.text);
  if (parsed) {
    return finalize(parsed, first.usage, opts);
  }

  // Repair round.
  messages.push({ role: 'assistant', content: first.text });
  messages.push({ role: 'user', content: REPAIR_INSTRUCTION });
  const second = await chatCompletion(opts, messages);
  const repaired = tryParseDecision(second.text);
  if (repaired) {
    const merged = mergeUsage(first.usage, second.usage);
    return finalize(repaired, merged, opts);
  }

  throw new Error(`Structured output fallback could not parse a JSON decision after repair retry. Last response: ${second.text.slice(0, 200)}`);
}

interface CompletionResult {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
}

async function chatCompletion(
  opts: StructuredCallOptions,
  messages: Array<{ role: string; content: string }>,
): Promise<CompletionResult> {
  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 256,
    temperature: 0,
    messages,
  });

  const url = new URL(`${opts.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`);
  const isHttps = url.protocol === 'https:';
  const responseBody = await new Promise<string>((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          ...(opts.apiKey ? { 'Authorization': `Bearer ${opts.apiKey}` } : {}),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: opts.timeoutMs,
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
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = json.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('Local LLM returned empty content');
  const usage = json.usage
    ? { input_tokens: json.usage.prompt_tokens ?? 0, output_tokens: json.usage.completion_tokens ?? 0 }
    : undefined;
  return { text, usage };
}

/**
 * Lenient parser: pulls JSON-shaped `{...}` blocks out of the response, strips
 * ```json fences if present, and validates the shape. Tries every `{` in the
 * text in case the first one is non-JSON prose like `{step 1}`.
 */
export function tryParseDecision(text: string): { pass: boolean; reason: string } | null {
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  const candidates: string[] = [stripped, ...extractAllJsonObjects(stripped)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof obj.pass !== 'boolean') continue;
      const reason = typeof obj.reason === 'string' ? obj.reason : '';
      return { pass: obj.pass, reason: reason.slice(0, 200) };
    } catch { /* try next */ }
  }
  return null;
}

function extractAllJsonObjects(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    const block = readBalancedBraces(text, start);
    if (!block) {
      i = start + 1;
      continue;
    }
    out.push(block);
    i = start + block.length;
  }
  return out;
}

function readBalancedBraces(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function mergeUsage(
  a?: { input_tokens: number; output_tokens: number },
  b?: { input_tokens: number; output_tokens: number },
): { input_tokens: number; output_tokens: number } | undefined {
  if (!a && !b) return undefined;
  return {
    input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
    output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  };
}

function finalize(
  decision: { pass: boolean; reason: string },
  rawUsage: { input_tokens: number; output_tokens: number } | undefined,
  opts: StructuredCallOptions,
): DecideResult {
  let usage: DecideUsage | undefined;
  if (rawUsage) {
    const tokensIn = rawUsage.input_tokens;
    const tokensOut = rawUsage.output_tokens;
    const costUsd = opts.computeCostUsd
      ? opts.computeCostUsd(opts.model, tokensIn, tokensOut)
      : undefined;
    usage = { tokensIn, tokensOut, costUsd };
  }
  return { pass: decision.pass, reason: decision.reason, usage };
}
