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
  userName: () => Promise<string>;
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

// 'note' is a sticky note, text box or drawing read from the PDF file. It
// has no marked text; pdf.js draws it.
export type AnnotationType = 'highlight' | 'underline' | 'strikeout' | 'note';

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
  // Who wrote the comment. Missing means the user of this computer.
  author?: string;
  // Set for annotations read from the PDF file. pdfRef is the object id of
  // the original ("722R"), so saving can update or remove exactly that one.
  source?: 'lexio' | 'file';
  pdfRef?: string;
  pdfSubtype?: string;
  // Original color (0-1 RGB). Saving keeps it unless the color was changed.
  pdfColor?: [number, number, number];
  replies?: Array<{ author: string; text: string; date?: number }>;
  modifiedAt?: number;
  // Drawings and shapes from other apps: listed, not editable.
  readOnly?: boolean;
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

// A page that was sent to the model, for checking citations.
export interface ContextSource {
  label: string;
  key: string;
  page: number;
}

// A marking (highlight, note) that was sent to the model as N1, N2, ...
export interface NoteReference {
  ref: string;
  label: string;
  key: string;
  page: number;
  highlightId: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  selectedText?: string;
  pageNumber?: number;
  pageEndNumber?: number;
  // Document of the selected passage (file hash or tab id) and its name.
  documentKey?: string;
  documentName?: string;
  providerId?: AIProvider;
  model?: string;
  // Assistant messages: whether the answer finished, and what was sent.
  status?: 'streaming' | 'done' | 'error' | 'aborted';
  sources?: ContextSource[];
  notes?: NoteReference[];
  contextDescription?: string;
  // Deep mode: what the model searched and read, in order.
  toolLog?: string[];
}

// A document a conversation has used, with the label it keeps in that
// conversation (D1, D2, ...), even after its tab is closed.
export interface ConversationDocument {
  key: string;
  name: string;
  label: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt?: number;
  documents?: ConversationDocument[];
  // 'all': the most recently viewed open PDFs (up to the Settings limit).
  // 'custom': only the listed document keys that are open.
  scope?: { mode: 'all' | 'custom'; keys: string[] };
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
  // Most open PDFs one chat searches at once (1-50).
  chatMaxDocuments: number;
  // Send the user's highlights and notes with questions.
  includeNotes: boolean;
  // Give passages the user marked extra weight in retrieval.
  highlightWeight: boolean;
  // What each highlight color means to the user; sent with each marking.
  colorLabels: Record<HighlightColor, string>;
  // Author written into annotations. Empty means the computer's user name.
  authorName: string;
  // Save highlights as drawings in the page instead of annotations (for
  // printing or sharing with readers that ignore annotations).
  flattenOnSave: boolean;
  // Deep mode: the model searches and reads the documents itself with tools.
  deepMode: boolean;
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
  chatMaxDocuments: 10,
  includeNotes: true,
  highlightWeight: true,
  colorLabels: {
    yellow: 'important',
    green: 'use in my work',
    blue: 'method or definition',
    pink: 'disagree or question',
    orange: 'follow up',
  },
  authorName: '',
  flattenOnSave: false,
  deepMode: false,
};
