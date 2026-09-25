import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X, Eye, EyeOff, Check, ExternalLink } from 'lucide-react';
import { useStore } from '../stores/useStore';
import { contextWindowTokens } from '../utils/context-budget';
import type { AIProvider } from '../types';
import { normalizeSettings } from '../utils/settings-migration';

const COLOR_SWATCHES: Record<string, string> = {
  yellow: '#ffeb3b',
  green: '#4caf50',
  blue: '#2196f3',
  pink: '#e91e63',
  orange: '#ff9800',
};

const PROVIDER_DOCS: Partial<Record<AIProvider, string>> = {
  ollama: 'https://ollama.com/download',
  claude: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
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
  } = useStore(useShallow((state) => ({
    settings: state.settings,
    updateProviderConfig: state.updateProviderConfig,
    setSettingsOpen: state.setSettingsOpen,
    updateSettings: state.updateSettings,
  })));
  const [credentialStatus, setCredentialStatus] = useState<{ persistent: boolean; weak: boolean } | null>(null);

  useEffect(() => {
    window.electronAPI?.credentialStatus().then(setCredentialStatus).catch(() => {});
  }, []);
  const [activeTab, setActiveTab] = useState<AIProvider>(settings.activeProvider);
  const [userName, setUserName] = useState('');
  useEffect(() => {
    window.electronAPI?.userName().then(setUserName).catch(() => {});
  }, []);
  const [showKey, setShowKey] = useState(false);

  const provider = settings.providers[activeTab];

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
                      : 'https://your-endpoint.example/v1'
                  }
                  className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
                />
                {activeTab === 'openaiCompatible' && (
                  <p className="text-[11px] text-text-muted mt-1">
                    Enter the API root ending in /v1. Lexio adds /chat/completions automatically.
                    Remote servers must use https://. Plain http:// only works for localhost.
                  </p>
                )}
              </SettingField>
            )}

            {/* API Key */}
            {activeTab !== 'ollama' && (
              <SettingField
                label="API Key"
                action={PROVIDER_DOCS[activeTab] && (
                  // Opened in the system browser by the main process.
                  <a
                    href={PROVIDER_DOCS[activeTab]}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[11px] text-accent-light hover:underline"
                  >
                    Get key <ExternalLink size={10} />
                  </a>
                )}
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
                {credentialStatus && !credentialStatus.persistent && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    No system keychain is available, so API keys are kept for this session only and are not saved to disk.
                  </p>
                )}
                {credentialStatus?.weak && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    No system keyring was found. API keys are saved with Electron's basic_text fallback, which does not really protect them. Install and unlock a keyring (for example GNOME Keyring or KWallet) for real encryption.
                  </p>
                )}
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

            <SettingField label="Context window (tokens)">
              <input
                type="number"
                min={0}
                step={1024}
                value={provider.contextTokens || ''}
                placeholder={`Automatic (${contextWindowTokens({ ...provider, contextTokens: 0 }).toLocaleString()})`}
                onChange={(e) => {
                  const value = Math.max(0, Math.round(Number(e.target.value) || 0));
                  updateProviderConfig(activeTab, { contextTokens: value });
                }}
                className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
              />
              <p className="text-[11px] text-text-muted mt-1">
                {activeTab === 'ollama'
                  ? 'Sent to Ollama as num_ctx. Larger values let more of the PDF fit but need more memory.'
                  : 'Leave empty to use the known size for this model. Lexio fits the PDF text, chat history and answer inside it.'}
              </p>
            </SettingField>

            <div className="border-t border-surface-3 pt-5 space-y-5">
              <div>
                <h3 className="text-sm font-semibold text-text-primary">Document context</h3>
                <p className="text-xs text-text-muted mt-1">
                  Ask AI uses only the selected passage. Typed questions send the whole PDF when it fits the model, and otherwise the most relevant passages of the original text.
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
                  <option value="documentAware">Document-aware — whole PDF when it fits, else relevant passages</option>
                  <option value="rawEntire">Raw full document — resend or resummarize every request</option>
                </select>
                {settings.contextMode === 'rawEntire' && (
                  <p className="mt-1 text-[11px] text-amber-300">
                    This mode processes the complete PDF again for every request and can be slow.
                  </p>
                )}
              </SettingField>

              <SettingField label="Scanned PDFs">
                <label className="flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.ocrEnabled}
                    onChange={(event) => updateSettings({ ocrEnabled: event.target.checked })}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-xs text-text-secondary">
                    Recognize text on scanned pages (OCR, English) on this computer, so they can be searched, selected, highlighted and asked about. A page can also be re-read with the chat's vision model from the document index panel.
                  </span>
                </label>
              </SettingField>

              <SettingField label="Meaning-based search">
                <label className="flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.semanticSearch}
                    onChange={(event) => updateSettings({ semanticSearch: event.target.checked })}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-xs text-text-secondary">
                    Also find passages that match the meaning of a question, not only its words, using a small English model (23 MB) that runs on this computer. It is downloaded once when you ask for it in the document index panel. PDF text never leaves your computer for this.
                  </span>
                </label>
              </SettingField>

              <SettingField label="PDFs one chat searches">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={settings.chatMaxDocuments}
                  onChange={(event) => {
                    const value = Math.round(Number(event.target.value));
                    if (Number.isFinite(value)) updateSettings({ chatMaxDocuments: Math.max(1, Math.min(50, value)) });
                  }}
                  className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors font-mono"
                />
                <p className="text-[11px] text-text-muted mt-1">
                  A chat searches up to this many open PDFs (1-50), the most recently viewed first. Pick others with the document chips above the chat input.
                </p>
              </SettingField>

              <SettingField label="Your highlights and notes">
                <label className="flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.includeNotes}
                    onChange={(event) => updateSettings({ includeNotes: event.target.checked })}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-xs text-text-secondary">
                    Send your highlights, underlines, strikethroughs and comments with questions, marked in the text so the AI can tell them apart from the authors' words.
                  </span>
                </label>
                <label className="mt-2 flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.highlightWeight}
                    onChange={(event) => updateSettings({ highlightWeight: event.target.checked })}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-xs text-text-secondary">
                    Give highlighted passages extra weight when choosing what to send. Strikethroughs get none.
                  </span>
                </label>
              </SettingField>

              <SettingField label="What your highlight colors mean">
                <div className="space-y-1.5">
                  {(Object.keys(settings.colorLabels) as Array<keyof typeof settings.colorLabels>).map((color) => (
                    <div key={color} className="flex items-center gap-2">
                      <span className={`h-3 w-3 flex-shrink-0 rounded-full highlight-swatch-${color}`} style={{ background: COLOR_SWATCHES[color] }} />
                      <span className="w-14 text-xs capitalize text-text-muted">{color}</span>
                      <input
                        type="text"
                        value={settings.colorLabels[color]}
                        maxLength={60}
                        onChange={(event) => updateSettings({ colorLabels: { ...settings.colorLabels, [color]: event.target.value } })}
                        className="flex-1 bg-surface-2 border border-surface-3 rounded-lg px-2.5 py-1 text-xs text-text-primary outline-none focus:border-accent/40"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-text-muted mt-1">
                  Sent with each marking, so you can ask things like "list everything I marked as disagree".
                </p>
              </SettingField>

              <SettingField label="Your name on annotations">
                <input
                  type="text"
                  value={settings.authorName}
                  maxLength={120}
                  placeholder={userName ? `Computer user name (${userName})` : 'Computer user name'}
                  onChange={(event) => updateSettings({ authorName: event.target.value })}
                  className="w-full bg-surface-2 border border-surface-3 rounded-lg px-3 py-2 text-sm text-text-primary outline-none focus:border-accent/40 transition-colors"
                />
                <p className="text-[11px] text-text-muted mt-1">
                  Written as the author of highlights and comments you save into PDFs, so other readers show who made them.
                </p>
              </SettingField>

              <SettingField label="Saving annotations">
                <label className="flex items-start gap-2 rounded-lg border border-surface-3 bg-surface-2 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={settings.flattenOnSave}
                    onChange={(event) => updateSettings({ flattenOnSave: event.target.checked })}
                    className="mt-0.5 accent-accent"
                  />
                  <span className="text-xs text-text-secondary">
                    Flatten: draw new highlights into the page instead of saving them as annotations. Use this for printing or for readers that ignore annotations. Flattened highlights can no longer be edited or removed, in Lexio or elsewhere.
                  </span>
                </label>
              </SettingField>

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
