// ─── Electron Bridge ───

type Unsubscribe = () => void;

export type LibraryKind = 'text' | 'notes' | 'chats' | 'cards' | 'embeddings' | 'ocr';

interface ElectronAPI {
  openPdf: () => Promise<void>;
  openDroppedPdf: (file: File) => Promise<PdfFileData | null>;
  saveFile: (name: string, content: string) => Promise<string | null>;
  savePdf: (name: string, data: Uint8Array) => Promise<string | null>;
  savePdfInPlace: (fileId: string, data: Uint8Array) => Promise<boolean>;
  loadSettings: () => Promise<unknown>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  credentialStatus: () => Promise<{ persistent: boolean; weak: boolean }>;
  loadLibrary: (kind: LibraryKind, key: string) => Promise<unknown>;
  saveLibrary: (kind: LibraryKind, key: string, data: unknown) => Promise<void>;
  deleteLibrary: (kind: LibraryKind, key: string) => Promise<void>;
  embeddingStatus: () => Promise<{ installed: boolean; downloading: boolean }>;
  downloadEmbeddingModel: () => Promise<void>;
  loadEmbeddingModel: () => Promise<{ model: Uint8Array; tokenizer: string } | null>;
  onEmbeddingProgress: (cb: (progress: { file: string; received: number; total: number }) => void) => Unsubscribe;
  onPdfOpened: (cb: (data: PdfFileData) => void) => Unsubscribe;
  onToggleSidebar: (cb: () => void) => Unsubscribe;
  onZoomIn: (cb: () => void) => Unsubscribe;
  onZoomOut: (cb: () => void) => Unsubscribe;
  onZoomReset: (cb: () => void) => Unsubscribe;
  onExportAnnotations: (cb: () => void) => Unsubscribe;
  onSavePdf: (cb: () => void) => Unsubscribe;
  onSavePdfAs: (cb: () => void) => Unsubscribe;
  onUndo: (cb: () => void) => Unsubscribe;
  onRedo: (cb: () => void) => Unsubscribe;
  onCopySelection: (cb: () => void) => Unsubscribe;
  onFind: (cb: () => void) => Unsubscribe;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// ─── PDF ───

export interface PdfFileData {
  // Opaque id issued by the main process (or name and size in browser mode).
  // The renderer never sees a writable file path.
  id: string;
  name: string;
  data: Uint8Array<ArrayBuffer>;
  // SHA-256 of the file bytes, computed once when the file is opened.
  fingerprint?: string;
  // True only for files the main process granted for in-place saving.
  canSaveInPlace?: boolean;
}

// ─── Annotations ───

export type HighlightColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';

export type AnnotationType = 'highlight' | 'underline' | 'strikeout';

// Rect stored as percentages (0-1) relative to page dimensions for zoom independence
export interface RelativeRect {
  x: number;      // 0-1, percentage from left
  y: number;      // 0-1, percentage from top
  width: number;  // 0-1, percentage of page width
  height: number; // 0-1, percentage of page height
}

export interface Highlight {
  id: string;
  page: number;
  rects: RelativeRect[];
  text: string;
  color: HighlightColor;
  type: AnnotationType;
  comment?: string;
  createdAt: number;
}

export interface Annotation {
  id: string;
  page: number;
  x: number;
  y: number;
  text: string;
  createdAt: number;
}

// ─── AI ───

export type AIProvider = 'ollama' | 'claude' | 'openai' | 'openaiCompatible' | 'gemini';

export type ContextMode = 'documentAware' | 'rawEntire';

export interface ProviderConfig {
  id: AIProvider;
  name: string;
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  models: string[];
  // Context window in tokens. 0 or missing means automatic (known model size,
  // or a provider default). For Ollama it is also sent as num_ctx.
  contextTokens?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  selectedText?: string;
  pageNumber?: number;
  pageEndNumber?: number;
  providerId?: AIProvider;
  model?: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
}

export interface PageRange {
  startPage: number;
  endPage: number;
}

// Text extraction state of a document tab.
export type IndexStatus = 'idle' | 'extracting' | 'ready';

// ─── Settings ───

export interface AppSettings {
  providers: Record<AIProvider, ProviderConfig>;
  activeProvider: AIProvider;
  sidebarOpen: boolean;
  sidebarWidth: number;
  theme: 'dark';
  contextMode: ContextMode;
  maxContextChars: number;
  customInstructions: string;
  // Meaning-based search with a local embedding model, downloaded on first use.
  semanticSearch: boolean;
}

export const DEFAULT_PROVIDERS: Record<AIProvider, ProviderConfig> = {
  ollama: {
    id: 'ollama',
    name: 'Ollama (Local)',
    enabled: true,
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2',
    models: ['llama3.2', 'llama3.1', 'mistral', 'codellama', 'phi3', 'gemma2', 'qwen2.5'],
  },
  claude: {
    id: 'claude',
    name: 'Anthropic Claude',
    enabled: false,
    apiKey: '',
    model: 'claude-sonnet-4-20250514',
    models: ['claude-sonnet-4-20250514', 'claude-haiku-4-20250414'],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    enabled: false,
    apiKey: '',
    model: 'gpt-4o',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini'],
  },
  openaiCompatible: {
    id: 'openaiCompatible',
    name: 'Generic OpenAI-Compatible',
    enabled: false,
    apiKey: '',
    baseUrl: '',
    model: 'qwen3-235b-a22b-thinking-2507',
    models: [],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    enabled: false,
    apiKey: '',
    model: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro'],
  },
};

export const DEFAULT_SETTINGS: AppSettings = {
  providers: DEFAULT_PROVIDERS,
  activeProvider: 'ollama',
  sidebarOpen: true,
  sidebarWidth: 700,
  theme: 'dark',
  contextMode: 'documentAware',
  maxContextChars: 100000,
  customInstructions: '',
  semanticSearch: true,
};
