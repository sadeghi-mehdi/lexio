// ─── Electron Bridge ───

interface ElectronAPI {
  openPdf: () => Promise<void>;
  readFile: (path: string) => Promise<string>;
  saveFile: (name: string, content: string) => Promise<string | null>;
  savePdf: (name: string, base64Data: string) => Promise<string | null>;
  savePdfInPlace: (path: string, base64Data: string) => Promise<boolean>;
  loadSettings: () => Promise<unknown>;
  saveSettings: (settings: AppSettings) => Promise<void>;
  loadDigest: (fingerprint: string) => Promise<unknown>;
  saveDigest: (fingerprint: string, digest: DocumentDigest) => Promise<void>;
  deleteDigest: (fingerprint: string) => Promise<void>;
  onPdfOpened: (cb: (data: PdfFileData) => void) => void;
  onToggleSidebar: (cb: () => void) => void;
  onZoomIn: (cb: () => void) => void;
  onZoomOut: (cb: () => void) => void;
  onZoomReset: (cb: () => void) => void;
  onExportAnnotations: (cb: () => void) => void;
  onSavePdf: (cb: () => void) => void;
  onSavePdfAs: (cb: () => void) => void;
  onUndo: (cb: () => void) => void;
  onRedo: (cb: () => void) => void;
  onCopySelection: (cb: () => void) => void;
  onFind: (cb: () => void) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

// ─── PDF ───

export interface PdfFileData {
  path: string;
  name: string;
  data: string; // base64
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

export interface DigestSection extends PageRange {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  entities: string[];
  sectionType: 'chapter' | 'appendix' | 'references' | 'body' | 'other';
}

export interface DigestTopic {
  name: string;
  description: string;
  pageRanges: PageRange[];
}

export interface DigestPageEntry {
  pageNumber: number;
  headings: string[];
  sectionTitle: string;
  keywords: string[];
  description: string;
}

export interface DocumentDigest {
  version: number;
  documentFingerprint: string;
  documentName: string;
  pageCount: number;
  generatedAt: number;
  providerId: AIProvider;
  model: string;
  overview: string;
  majorTopics: DigestTopic[];
  sections: DigestSection[];
  pages: DigestPageEntry[];
}

export type DigestStatus =
  | 'idle'
  | 'extracting'
  | 'loading'
  | 'generating'
  | 'consolidating'
  | 'ready'
  | 'error'
  | 'cancelled';

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
  digestEnabled: boolean;
  digestProvider: 'active' | AIProvider;
  digestModels: Record<AIProvider, string>;
  digestChunkChars: number;
  maxRetrievedRanges: number;
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
    baseUrl: 'https://openai.rc.asu.edu/v1',
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
  digestEnabled: true,
  digestProvider: 'active',
  digestModels: {
    ollama: '',
    claude: '',
    openai: '',
    openaiCompatible: '',
    gemini: '',
  },
  digestChunkChars: 60000,
  maxRetrievedRanges: 4,
};
