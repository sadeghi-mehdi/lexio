function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function splitSettingsApiKeys(raw: unknown): {
  settings: Record<string, unknown>;
  apiKeys: Record<string, string>;
} {
  const settings = cloneRecord(raw);
  const providers = isRecord(settings.providers) ? settings.providers : {};
  const apiKeys: Record<string, string> = {};

  for (const [providerId, value] of Object.entries(providers)) {
    if (!isRecord(value)) continue;
    if (typeof value.apiKey === 'string') apiKeys[providerId] = value.apiKey;
    delete value.apiKey;
  }
  settings.providers = providers;
  return { settings, apiKeys };
}

export function mergeSettingsApiKeys(
  raw: unknown,
  apiKeys: Readonly<Record<string, string>>
): Record<string, unknown> {
  const settings = cloneRecord(raw);
  const providers = isRecord(settings.providers) ? settings.providers : {};
  for (const [providerId, apiKey] of Object.entries(apiKeys)) {
    const provider = isRecord(providers[providerId]) ? providers[providerId] : {};
    if (typeof provider.apiKey !== 'string' || !provider.apiKey) provider.apiKey = apiKey;
    providers[providerId] = provider;
  }
  settings.providers = providers;
  return settings;
}
