import type { AIProviderInterface } from '../providers/ai-providers';
import type { ChatMessage, ProviderConfig } from '../types';

export async function requestProviderText(
  provider: AIProviderInterface,
  messages: ChatMessage[],
  systemPrompt: string,
  config: ProviderConfig,
  signal: AbortSignal,
  onToken?: (accumulated: string) => void
): Promise<string> {
  let accumulated = '';
  let callbackError: Error | null = null;
  await provider.chat(messages, systemPrompt, config, signal, {
    onToken: (token) => {
      accumulated += token;
      onToken?.(accumulated);
    },
    onDone: () => {},
    onError: (error) => {
      callbackError = error;
    },
  });
  if (callbackError) throw callbackError;
  return accumulated;
}
