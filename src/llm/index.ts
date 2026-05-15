import { OpenAIProvider } from './providers/openai.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { LocalProvider } from './providers/local.js';
import type { LLMProvider, LLMProviderOptions } from './provider.js';

export type LLMBackend = 'openai' | 'anthropic' | 'local' | 'auto';

export { scoreIntentComplexity } from './complexity.js';
export type { LLMProvider, LLMProviderOptions };

export const LLM_AUTO_THRESHOLD = 4;

export function createLLMProvider(backend: Exclude<LLMBackend, 'auto'>, opts: LLMProviderOptions = {}): LLMProvider {
  if (backend === 'openai') return new OpenAIProvider(opts);
  if (backend === 'anthropic') return new AnthropicProvider(opts);
  if (backend === 'local') return new LocalProvider(opts);
  throw new Error(`Unknown LLM backend: ${backend}`);
}
