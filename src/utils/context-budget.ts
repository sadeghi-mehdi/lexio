import type { ProviderConfig } from '../types.ts';

// Context window sizes in tokens for the models Lexio lists. Unknown models
// fall back to a conservative size per provider. Users can override the size
// per provider in Settings (ProviderConfig.contextTokens).
const KNOWN_CONTEXT_TOKENS: Array<[RegExp, number]> = [
  [/^claude-/, 200_000],
  [/^gpt-4\.1/, 1_047_576],
  [/^gpt-4o|^gpt-4-turbo|^o1|^o3|^o4/, 128_000],
  [/^gemini-1\.5-pro/, 2_097_152],
  [/^gemini-/, 1_048_576],
];

const PROVIDER_FALLBACK_TOKENS: Record<ProviderConfig['id'], number> = {
  claude: 200_000,
  openai: 128_000,
  gemini: 1_048_576,
  // Ollama's context is whatever num_ctx Lexio sends, so this is also the
  // value sent with every Ollama request.
  ollama: 8_192,
  openaiCompatible: 32_768,
};

// Tokens kept free for the answer. Claude requests use max_tokens 4096.
export const OUTPUT_RESERVE_TOKENS = 4_096;
// System prompt, instructions and the list of documents.
const PROMPT_RESERVE_TOKENS = 1_500;

export function contextWindowTokens(config: ProviderConfig): number {
  if (config.contextTokens && config.contextTokens > 0) return config.contextTokens;
  if (config.id === 'ollama' || config.id === 'openaiCompatible') return PROVIDER_FALLBACK_TOKENS[config.id];
  const model = config.model.toLowerCase();
  return KNOWN_CONTEXT_TOKENS.find(([pattern]) => pattern.test(model))?.[1] ?? PROVIDER_FALLBACK_TOKENS[config.id];
}

// Rough token count without a tokenizer. English prose averages about four
// characters per token; 3.5 leaves a margin. CJK characters are usually one
// token or more each, so they are counted separately.
export function estimateTokens(text: string): number {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length || 0;
  return Math.ceil(cjk * 1.2 + (text.length - cjk) / 3.5);
}

// Token budgets for one request: document context, conversation history and
// the answer must all fit the model's window. History gets at most a quarter
// of what remains, and the user's maximum context setting caps the documents.
export function requestBudget(config: ProviderConfig, maxContextChars: number): {
  windowTokens: number;
  documentTokens: number;
  historyTokens: number;
} {
  const windowTokens = contextWindowTokens(config);
  const available = Math.max(1_000, windowTokens - OUTPUT_RESERVE_TOKENS - PROMPT_RESERVE_TOKENS);
  const historyTokens = Math.floor(available * 0.25);
  const documentTokens = Math.min(available - historyTokens, Math.ceil(maxContextChars / 3.5));
  return { windowTokens, documentTokens, historyTokens };
}
