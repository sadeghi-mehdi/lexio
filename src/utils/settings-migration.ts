import {
  DEFAULT_PROVIDERS,
  DEFAULT_SETTINGS,
  type AIProvider,
  type AppSettings,
  type ContextMode,
  type ProviderConfig,
} from '../types.ts';

const PROVIDER_IDS = Object.keys(DEFAULT_PROVIDERS) as AIProvider[];
const CONTEXT_MODES: ContextMode[] = ['documentAware', 'rawEntire'];
const GENERIC_OPENAI_ONLY_MODELS = new Set(['gemma4-e2b-it']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneProvider(provider: ProviderConfig): ProviderConfig {
  return { ...provider, models: [...provider.models] };
}

function mergeProvider(id: AIProvider, raw: unknown): ProviderConfig {
  const fallback = cloneProvider(DEFAULT_PROVIDERS[id]);
  if (!isRecord(raw)) return fallback;

  const requestedModel = typeof raw.model === 'string' ? raw.model : fallback.model;
  const rawModels = Array.isArray(raw.models)
    ? raw.models.filter((model): model is string => typeof model === 'string')
    : fallback.models;
  const modelIsGenericOnly = GENERIC_OPENAI_ONLY_MODELS.has(requestedModel.toLowerCase());
  const models = id === 'openaiCompatible'
    ? rawModels
    : rawModels.filter((model) => !GENERIC_OPENAI_ONLY_MODELS.has(model.toLowerCase()));

  return {
    ...fallback,
    ...raw,
    id,
    name: typeof raw.name === 'string' ? raw.name : fallback.name,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fallback.enabled,
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : fallback.apiKey,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : fallback.baseUrl,
    model: id !== 'openaiCompatible' && modelIsGenericOnly ? fallback.model : requestedModel,
    models,
  };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function normalizeSettings(raw: unknown): AppSettings {
  const source = isRecord(raw) ? raw : {};
  const rawProviders = isRecord(source.providers) ? source.providers : {};
  const rawOpenAI = isRecord(rawProviders.openai) ? rawProviders.openai : null;
  const hasGenericProvider = isRecord(rawProviders.openaiCompatible);
  const legacyOpenAIName = typeof rawOpenAI?.name === 'string' ? rawOpenAI.name : '';
  const legacyOpenAIBaseUrl = typeof rawOpenAI?.baseUrl === 'string' ? rawOpenAI.baseUrl : '';
  const legacyAsuConfiguration =
    !hasGenericProvider &&
    (legacyOpenAIName === 'ASU Research Computing' || legacyOpenAIBaseUrl.includes('openai.rc.asu.edu'));

  const providers = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, mergeProvider(id, rawProviders[id])])
  ) as Record<AIProvider, ProviderConfig>;

  if (legacyAsuConfiguration && rawOpenAI) {
    providers.openai = cloneProvider(DEFAULT_PROVIDERS.openai);
    providers.openaiCompatible = {
      ...cloneProvider(DEFAULT_PROVIDERS.openaiCompatible),
      enabled: typeof rawOpenAI.enabled === 'boolean' ? rawOpenAI.enabled : false,
      apiKey: typeof rawOpenAI.apiKey === 'string' ? rawOpenAI.apiKey : '',
      model:
        typeof rawOpenAI.model === 'string'
          ? rawOpenAI.model
          : DEFAULT_PROVIDERS.openaiCompatible.model,
    };
  }

  const rawActiveProvider = typeof source.activeProvider === 'string' ? source.activeProvider : '';
  let activeProvider: AIProvider = PROVIDER_IDS.includes(rawActiveProvider as AIProvider)
    ? (rawActiveProvider as AIProvider)
    : DEFAULT_SETTINGS.activeProvider;
  if (legacyAsuConfiguration && activeProvider === 'openai') {
    activeProvider = 'openaiCompatible';
  }

  const rawDigestProvider = source.digestProvider === 'active' || PROVIDER_IDS.includes(source.digestProvider as AIProvider)
    ? (source.digestProvider as 'active' | AIProvider)
    : DEFAULT_SETTINGS.digestProvider;
  const effectiveLegacyDigestProvider = rawDigestProvider === 'active'
    ? activeProvider
    : rawDigestProvider;
  const rawDigestModels = isRecord(source.digestModels) ? source.digestModels : {};
  const digestModels = Object.fromEntries(PROVIDER_IDS.map((id) => {
    let model = typeof rawDigestModels[id] === 'string'
      ? (rawDigestModels[id] as string).slice(0, 200)
      : '';
    if (
      !model &&
      id === effectiveLegacyDigestProvider &&
      typeof source.digestModel === 'string'
    ) {
      model = source.digestModel.slice(0, 200);
    }
    if (id !== 'openaiCompatible' && GENERIC_OPENAI_ONLY_MODELS.has(model.toLowerCase())) {
      model = '';
    }
    return [id, model];
  })) as Record<AIProvider, string>;

  const legacyContextMode = typeof source.contextMode === 'string' ? source.contextMode : '';
  const rawContextMode = legacyContextMode === 'entire'
    ? 'rawEntire'
    : legacyContextMode === 'auto' || legacyContextMode === 'relevant'
      ? 'documentAware'
      : legacyContextMode;

  return {
    providers,
    activeProvider,
    sidebarOpen:
      typeof source.sidebarOpen === 'boolean' ? source.sidebarOpen : DEFAULT_SETTINGS.sidebarOpen,
    sidebarWidth: clampInteger(
      source.sidebarWidth,
      DEFAULT_SETTINGS.sidebarWidth,
      320,
      1200
    ),
    theme: 'dark',
    contextMode: CONTEXT_MODES.includes(rawContextMode as ContextMode)
      ? (rawContextMode as ContextMode)
      : DEFAULT_SETTINGS.contextMode,
    maxContextChars: clampInteger(
      source.maxContextChars,
      DEFAULT_SETTINGS.maxContextChars,
      10000,
      2000000
    ),
    customInstructions:
      typeof source.customInstructions === 'string'
        ? source.customInstructions.slice(0, 20000)
        : DEFAULT_SETTINGS.customInstructions,
    digestEnabled:
      typeof source.digestEnabled === 'boolean'
        ? source.digestEnabled
        : DEFAULT_SETTINGS.digestEnabled,
    digestProvider: rawDigestProvider,
    digestModels,
    digestChunkChars: clampInteger(
      source.digestChunkChars,
      DEFAULT_SETTINGS.digestChunkChars,
      10000,
      200000
    ),
    maxRetrievedRanges: clampInteger(
      source.maxRetrievedRanges,
      DEFAULT_SETTINGS.maxRetrievedRanges,
      1,
      10
    ),
  };
}
