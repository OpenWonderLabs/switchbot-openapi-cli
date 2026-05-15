export interface DecideUsage {
  tokensIn: number;
  tokensOut: number;
  /** Computed by `calculateCostUsd(model, tokensIn, tokensOut)`; undefined if model is not in the pricing table. */
  costUsd?: number;
}

export interface DecideResult {
  pass: boolean;
  reason: string;
  /** Token + cost accounting for the underlying API call. Absent on cached
   * results and when the provider does not report usage. */
  usage?: DecideUsage;
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
