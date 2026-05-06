export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateYaml(systemPrompt: string, userIntent: string): Promise<string>;
}

export interface LLMProviderOptions {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxTokens?: number;
}
