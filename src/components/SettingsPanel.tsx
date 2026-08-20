import { useState } from 'react';
import { X, Eye, EyeOff, Check, ExternalLink } from 'lucide-react';
import { useStore } from '../stores/useStore';
import type { AIProvider } from '../types';
import { normalizeSettings } from '../utils/settings-migration';

const PROVIDER_DOCS: Record<AIProvider, string> = {
  ollama: 'https://ollama.com/download',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  openaiCompatible: 'https://openai.rc.asu.edu/',
  gemini: 'https://aistudio.google.com/app/apikey',
};

const PROVIDER_ICONS: Record<AIProvider, string> = {
  ollama: '🦙',
  claude: '🟠',
  openai: '🟢',
  openaiCompatible: '🔌',
  gemini: '🔵',
};

export default function SettingsPanel() {
  const {
    settings,
    updateProviderConfig,
    setSettingsOpen,
    updateSettings,
  } = useStore();
  const [activeTab, setActiveTab] = useState<AIProvider>(settings.activeProvider);
  const [showKey, setShowKey] = useState(false);
  const [customDigestProvider, setCustomDigestProvider] = useState<AIProvider | null>(null);

  const provider = settings.providers[activeTab];
  const effectiveDigestProviderId = settings.digestProvider === 'active'
    ? settings.activeProvider
    : settings.digestProvider;
  const digestModelOverride = settings.digestModels[activeTab] || '';
  const digestUsesCustomModel = customDigestProvider === activeTab || (
    Boolean(digestModelOverride) && !provider.models.includes(digestModelOverride)
  );

  const handleSave = () => {
    const normalized = normalizeSettings(settings);
    useStore.getState().hydrateSettings(normalized);
    if (window.electronAPI) {
      window.electronAPI.saveSettings(normalized);
    }
    setSettingsOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      <div className="bg-surface-1 border border-surface-3 rounded-2xl shadow-2xl w-[900px] max-w-[94vw] max-h-[86vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-3">
          <h2 className="text-base font-semibold text-text-primary">Settings</h2>
          <button
            onClick={() => setSettingsOpen(false)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left nav */}
          <div className="w-48 border-r border-surface-3 py-2 flex-shrink-0">
            <div className="px-3 py-1.5">
              <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
                AI Providers
              </span>
            </div>
            {(Object.keys(settings.providers) as AIProvider[]).map((id) => {
              const p = settings.providers[id];
              return (
                <button
                  key={id}
                  onClick={() => {
                    setActiveTab(id);
                    setShowKey(false);
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                    activeTab === id
                      ? 'bg-accent/10 text-accent-light border-r-2 border-accent'
                      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'
                  }`}
                >
                  <span>{PROVIDER_ICONS[id]}</span>
                  <span className="truncate">{p.name}</span>
                  {p.enabled && (
                    <Check size={12} className="ml-auto text-emerald-400 flex-shrink-0" />
                  )}
                </button>
              );
            })}

          </div>

          {/* Right content */}
          <div className="flex-1 p-6 overflow-y-auto space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">{provider.name}</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  {activeTab === 'ollama'
                    ? 'Local inference — no API key required'
                    : activeTab === 'openaiCompatible'
                      ? 'Custom OpenAI-compatible endpoint'
                      : 'Cloud API — requires an API key'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">Enabled</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={provider.enabled}
                  aria-label={`Enable ${provider.name}`}
                  onClick={() => updateProviderConfig(activeTab, { enabled: !provider.enabled })}
                  className={`w-9 h-5 rounded-full transition-colors cursor-pointer flex items-center ${
                    provider.enabled ? 'bg-accent' : 'bg-surface-4'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${
                      provider.enabled ? 'translate-x-[18px]' : 'translate-x-[2px]'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Base URL */}
            {(activeTab === 'ollama' || activeTab === 'openaiCompatible') && (
              <SettingField label={activeTab === 'ollama' ? 'Server URL' : 'API base URL'}>
                <input
                  type="url"
                  value={provider.baseUrl || ''}
                  onChange={(e) =>
                    updateProviderConfig(activeTab, { baseUrl: e.target.value })
                  }
                  placeholder={
                    activeTab === 'ollama'
                      ? 'http://localhost:11434'
                      : 'https://openai.rc.asu.edu/v1'
                  }
                  className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
                />
                {activeTab === 'openaiCompatible' && (
                  <p className="text-[11px] text-text-muted mt-1">
                    Enter the API root ending in /v1. Lexio adds /chat/completions automatically.
                  </p>
                )}
              </SettingField>
            )}

            {/* API Key */}
            {activeTab !== 'ollama' && (
              <SettingField
                label="API Key"
                action={
                  <a
                    href={PROVIDER_DOCS[activeTab]}
                    target="_blank"
                    rel="noopener"
                    className="flex items-center gap-1 text-[11px] text-accent-light hover:underline"
                  >
                    Get key <ExternalLink size={10} />
                  </a>
                }
              >
                <div className="relative">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={provider.apiKey || ''}
                    onChange={(e) =>
                      updateProviderConfig(activeTab, {
                        apiKey: e.target.value,
                        enabled: e.target.value.length > 0,
                      })
                    }
                    placeholder={`Enter your ${provider.name} API key`}
                    className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 pr-10 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
                  />
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary"
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </SettingField>
            )}

            {/* Model selector */}
            <SettingField label="Model">
              <div className="flex gap-2">
                {provider.models.length > 0 && (
                  <select
                    value={provider.models.includes(provider.model) ? provider.model : ''}
                    onChange={(e) =>
                      updateProviderConfig(activeTab, { model: e.target.value })
                    }
                    className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors appearance-none cursor-pointer"
                  >
                    {!provider.models.includes(provider.model) && (
                      <option value="">Custom model</option>
                    )}
                    {provider.models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )}
                <input
                  type="text"
                  value={provider.model}
                  onChange={(e) =>
                    updateProviderConfig(activeTab, { model: e.target.value })
                  }
                  placeholder="Custom model name"
                  className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
                />
              </div>
              <p className="text-[11px] text-text-muted mt-1">
                {provider.models.length > 0
                  ? 'Select a preset or type a custom model name'
                  : 'Enter the exact model ID supported by this endpoint'}
              </p>
            </SettingField>

            <div className="border-t border-surface-3 pt-5 space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Document context</h3>
                <p className="text-xs text-text-muted mt-1">
                  Ask AI uses only the selected passage. Typed questions use original PDF text selected with the page index, or raw mode below.
                </p>
              </div>

              <SettingField label="Context mode">
                <select
                  value={settings.contextMode}
                  onChange={(event) =>
                    updateSettings({ contextMode: event.target.value as typeof settings.contextMode })
                  }
                  className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors"
                >
                  <option value="documentAware">Document-aware — page index + original source pages</option>
                  <option value="rawEntire">Raw full document — resend or resummarize every request</option>
                </select>
                {settings.contextMode === 'rawEntire' && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    This mode processes the complete PDF again for every request and can be slow.
                  </p>
                )}
              </SettingField>

              <SettingField label="Reusable page index">
                <label className="flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.digestEnabled}
                    onChange={(event) => updateSettings({ digestEnabled: event.target.checked })}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-xs text-text-secondary">
                    Build once and cache headings, section titles, descriptions, and up to 20 keywords per page. Answers use original PDF text, not the index.
                  </span>
                </label>
              </SettingField>

              {settings.digestEnabled && (
                <>
                  <SettingField label={`Page indexing with ${provider.name}`}>
                    <label className="flex items-center justify-between gap-4 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2.5">
                      <span className="text-xs text-text-secondary">
                        Use {provider.name} to build the reusable page index
                      </span>
                      <input
                        type="radio"
                        name="page-index-provider"
                        checked={effectiveDigestProviderId === activeTab}
                        onChange={() => updateSettings({ digestProvider: activeTab })}
                        className="accent-accent"
                        aria-label={`Use ${provider.name} for page indexing`}
                      />
                    </label>
                    <p className="mt-1 text-[11px] text-text-muted">
                      {effectiveDigestProviderId === activeTab
                        ? `${provider.name} is the current page-index provider.`
                        : `${settings.providers[effectiveDigestProviderId].name} is currently used. Select this option to switch.`}
                    </p>
                  </SettingField>

                  <SettingField label={`${provider.name} page-index model`}>
                    <div className="flex gap-2">
                      <select
                        value={digestUsesCustomModel
                          ? '__custom__'
                          : digestModelOverride || '__main__'}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === '__custom__') {
                            setCustomDigestProvider(activeTab);
                            return;
                          }
                          setCustomDigestProvider(null);
                          updateSettings({
                            digestModels: {
                              ...settings.digestModels,
                              [activeTab]: value === '__main__' ? '' : value,
                            },
                          });
                        }}
                        className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40"
                      >
                        <option value="__main__">Use main model — {provider.model}</option>
                        {provider.models.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                        <option value="__custom__">Custom model…</option>
                      </select>
                      {digestUsesCustomModel && (
                        <input
                          type="text"
                          autoFocus={customDigestProvider === activeTab}
                          value={digestModelOverride}
                          onChange={(event) => updateSettings({
                            digestModels: {
                              ...settings.digestModels,
                              [activeTab]: event.target.value,
                            },
                          })}
                          placeholder="Exact custom model ID"
                          className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 font-mono"
                        />
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-text-muted">
                      This list uses {provider.name}'s presets. Choose Custom model to enter another exact model ID. Changes apply when the page index is rebuilt.
                    </p>
                  </SettingField>

                  <SettingField label="Page-index chunk characters">
                    <input
                      type="number"
                      min={10000}
                      max={200000}
                      step={5000}
                      value={settings.digestChunkChars}
                      onChange={(event) => updateSettings({ digestChunkChars: Number(event.target.value) })}
                      className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 font-mono"
                    />
                  </SettingField>

                  <SettingField label="Maximum retrieved page ranges">
                    <input
                      type="number"
                      min={1}
                      max={10}
                      value={settings.maxRetrievedRanges}
                      onChange={(event) => updateSettings({ maxRetrievedRanges: Number(event.target.value) })}
                      className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 font-mono"
                    />
                  </SettingField>

                </>
              )}

              <SettingField label="Maximum PDF context characters per request">
                <input
                  type="number"
                  min={10000}
                  max={2000000}
                  step={10000}
                  value={settings.maxContextChars}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (Number.isFinite(value)) updateSettings({ maxContextChars: value });
                  }}
                  onBlur={() =>
                    updateSettings({
                      maxContextChars: Math.max(
                        10000,
                        Math.min(2000000, Math.round(settings.maxContextChars))
                      ),
                    })
                  }
                  className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
                />
                <p className="text-[11px] text-text-muted mt-1">
                  Approximately {Math.round(settings.maxContextChars / 4).toLocaleString()} tokens of PDF text. The actual token count varies by model.
                </p>
              </SettingField>

              <SettingField label="Custom instructions">
                <textarea
                  rows={6}
                  maxLength={20000}
                  value={settings.customInstructions}
                  onChange={(event) =>
                    updateSettings({ customInstructions: event.target.value })
                  }
                  placeholder="Example: Use formal technical language, cite page numbers, and distinguish document findings from your interpretation."
                  className="w-full resize-y bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors"
                />
                <div className="mt-1 flex items-center justify-between gap-3 text-[11px] text-text-muted">
                  <span>Added to every model request, including document summaries.</span>
                  <span className="font-mono">{settings.customInstructions.length.toLocaleString()} / 20,000</span>
                </div>
              </SettingField>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-surface-3">
          <button
            onClick={() => setSettingsOpen(false)}
            className="px-4 py-2 rounded-lg text-sm text-text-secondary hover:bg-surface-3 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm bg-accent text-white hover:bg-accent-dim transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingField({
  label,
  action,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs font-medium text-text-secondary">{label}</label>
        {action}
      </div>
      {children}
    </div>
  );
}
