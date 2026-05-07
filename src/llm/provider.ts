export interface DecideResult {
  pass: boolean;
  reason: string;
}

export interface DecideOptions {
  timeoutMs?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateYaml(systemPrompt: string, userIntent: string): Promise<string>;
  decide(prompt: string, opts?: DecideOptions): Promise<DecideResult>;
}

export interface LLMProviderOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
}
