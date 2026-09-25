import { create } from 'zustand';
import type {
  PdfFileData,
  Highlight,
  Annotation,
  ChatMessage,
  ChatConversation,
  AppSettings,
  AIProvider,
  HighlightColor,
  AnnotationType,
  RelativeRect,
  IndexStatus,
} from '../types.ts';
import { DEFAULT_SETTINGS } from '../types.ts';
import { abortChatRequest } from '../utils/chat-request-registry.ts';
import { releaseRegisteredDocument } from '../utils/pdf-document-registry.ts';
import type { OutlineEntry } from '../utils/text-index.ts';

export type ToolType = 'select' | AnnotationType | 'comment';

export type EmbeddingStatus =
  | 'unknown'
  | 'unavailable'
  | 'not-installed'
  | 'downloading'
  | 'loading'
  | 'indexing'
  | 'ready'
  | 'error';

// Undo/Redo action types
type UndoAction =
  | { type: 'add_highlight'; highlight: Highlight }
  | { type: 'remove_highlight'; highlight: Highlight }
  | { type: 'update_comment'; id: string; oldComment: string | undefined; newComment: string };

export interface DocumentTabSession {
  id: string;
  identity: string;
  pdfFile: PdfFileData;
  pageTexts: Map<number, string>;
  pageHeadings: Map<number, string[]>;
  documentOutline: OutlineEntry[];
  extractedPageCount: number;
  documentTextReady: boolean;
  numPages: number;
  currentPage: number;
  zoom: number;
  highlights: Highlight[];
  annotations: Annotation[];
  activeHighlightColor: HighlightColor;
  activeTool: ToolType;
  undoStack: UndoAction[];
  redoStack: UndoAction[];
  conversations: ChatConversation[];
  activeConversation: string | null;
  isStreaming: boolean;
  selectedTextForAI: string;
  selectedPageForAI: number;
  selectedEndPageForAI: number;
  selectedRectsForAI: RelativeRect[];
  indexStatus: IndexStatus;
  indexProgress: string;
}

interface AppState {
  documentTabs: DocumentTabSession[];
  activeDocumentTabId: string | null;

  // PDF
  pdfFile: PdfFileData | null;
  documentSessionId: number;
  pageTexts: Map<number, string>;
  pageHeadings: Map<number, string[]>;
  documentOutline: OutlineEntry[];
  extractedPageCount: number;
  documentTextReady: boolean;
  numPages: number;
  currentPage: number;
  zoom: number;

  // Annotations
  highlights: Highlight[];
  annotations: Annotation[];
  activeHighlightColor: HighlightColor;
  activeTool: ToolType;

  // Undo/Redo
  undoStack: UndoAction[];
  redoStack: UndoAction[];

  // AI
  conversations: ChatConversation[];
  activeConversation: string | null;
  isStreaming: boolean;
  selectedTextForAI: string;
  selectedPageForAI: number;
  selectedEndPageForAI: number;
  selectedRectsForAI: RelativeRect[];
  indexStatus: IndexStatus;
  indexProgress: string;

  // Meaning-based search (embedding model and document vectors)
  embeddingStatus: EmbeddingStatus;
  embeddingProgress: string;

  // UI
  sidebarOpen: boolean;
  sidebarWidth: number;
  sidebarTab: 'chat' | 'annotations' | 'settings';
  settingsOpen: boolean;
  thumbnailSidebarOpen: boolean;

  // Settings
  settings: AppSettings;

  // PDF Actions
  setPdfFile: (file: PdfFileData | null) => void;
  switchDocumentTab: (id: string) => void;
  closeDocumentTab: (id: string) => void;
  // Text extraction runs for every open tab in the background, so these take
  // the target tab. Without one they update the active tab.
  mergePageTexts: (
    entries: ReadonlyArray<readonly [number, string]>,
    tabId?: string | null,
    headings?: ReadonlyArray<readonly [number, string[]]>
  ) => void;
  setExtractionProgress: (pageCount: number, complete?: boolean, tabId?: string | null) => void;
  setDocumentOutline: (outline: OutlineEntry[], tabId?: string | null) => void;
  setEmbeddingState: (status: EmbeddingStatus, progress?: string) => void;
  setNumPages: (n: number) => void;
  setCurrentPage: (p: number) => void;
  setZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;

  // Annotation Actions
  addHighlight: (h: Highlight) => void;
  removeHighlight: (id: string) => void;
  updateHighlightComment: (id: string, comment: string) => void;
  addAnnotation: (a: Annotation) => void;
  removeAnnotation: (id: string) => void;
  setActiveHighlightColor: (c: HighlightColor) => void;
  setActiveTool: (t: ToolType) => void;

  // Undo/Redo Actions
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // AI Actions
  setSelectedTextForAI: (text: string, page: number, rects?: RelativeRect[], endPage?: number) => void;
  clearSelectedTextForAI: () => void;
  newConversation: () => string;
  addMessage: (convId: string, msg: ChatMessage, documentTabId?: string | null) => void;
  updateLastAssistantMessage: (convId: string, content: string, documentTabId?: string | null) => void;
  setActiveConversation: (id: string | null) => void;
  setIsStreaming: (v: boolean, documentTabId?: string | null) => void;
  deleteConversation: (id: string) => void;

  // UI Actions
  toggleSidebar: () => void;
  setSidebarOpen: (v: boolean) => void;
  setSidebarWidth: (w: number) => void;
  setSidebarTab: (t: 'chat' | 'annotations' | 'settings') => void;
  setSettingsOpen: (v: boolean) => void;
  toggleThumbnailSidebar: () => void;
  setThumbnailSidebarOpen: (v: boolean) => void;

  // Settings Actions
  hydrateSettings: (settings: AppSettings) => void;
  updateSettings: (s: Partial<AppSettings>) => void;
  setActiveProvider: (p: AIProvider) => void;
  updateProviderConfig: (id: AIProvider, config: Partial<AppSettings['providers'][AIProvider]>) => void;
}

const uid = () => Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

function documentIdentity(file: PdfFileData): string {
  return `${file.id}::${file.data.length}`;
}

function captureActiveSession(state: AppState): DocumentTabSession | null {
  if (!state.pdfFile || !state.activeDocumentTabId) return null;
  return {
    id: state.activeDocumentTabId,
    identity: documentIdentity(state.pdfFile),
    pdfFile: state.pdfFile,
    pageTexts: state.pageTexts,
    pageHeadings: state.pageHeadings,
    documentOutline: state.documentOutline,
    extractedPageCount: state.extractedPageCount,
    documentTextReady: state.documentTextReady,
    numPages: state.numPages,
    currentPage: state.currentPage,
    zoom: state.zoom,
    highlights: state.highlights,
    annotations: state.annotations,
    activeHighlightColor: state.activeHighlightColor,
    activeTool: state.activeTool,
    undoStack: state.undoStack,
    redoStack: state.redoStack,
    conversations: state.conversations,
    activeConversation: state.activeConversation,
    isStreaming: state.isStreaming,
    selectedTextForAI: state.selectedTextForAI,
    selectedPageForAI: state.selectedPageForAI,
    selectedEndPageForAI: state.selectedEndPageForAI,
    selectedRectsForAI: state.selectedRectsForAI,
    indexStatus: state.indexStatus,
    indexProgress: state.indexProgress,
  };
}

function newDocumentSession(file: PdfFileData): DocumentTabSession {
  return {
    id: uid(),
    identity: documentIdentity(file),
    pdfFile: file,
    pageTexts: new Map(),
    pageHeadings: new Map(),
    documentOutline: [],
    extractedPageCount: 0,
    documentTextReady: false,
    numPages: 0,
    currentPage: 1,
    zoom: 1,
    highlights: [],
    annotations: [],
    activeHighlightColor: 'yellow',
    activeTool: 'select',
    undoStack: [],
    redoStack: [],
    conversations: [],
    activeConversation: null,
    isStreaming: false,
    selectedTextForAI: '',
    selectedPageForAI: 0,
    selectedEndPageForAI: 0,
    selectedRectsForAI: [],
    indexStatus: 'extracting',
    indexProgress: 'Extracting PDF text…',
  };
}

function activateSession(session: DocumentTabSession, nextSessionId: number): Partial<AppState> {
  return {
    activeDocumentTabId: session.id,
    pdfFile: session.pdfFile,
    documentSessionId: nextSessionId,
    pageTexts: session.pageTexts,
    pageHeadings: session.pageHeadings,
    documentOutline: session.documentOutline,
    extractedPageCount: session.extractedPageCount,
    documentTextReady: session.documentTextReady,
    numPages: session.numPages,
    currentPage: session.currentPage,
    zoom: session.zoom,
    highlights: session.highlights,
    annotations: session.annotations,
    activeHighlightColor: session.activeHighlightColor,
    activeTool: session.activeTool,
    undoStack: session.undoStack,
    redoStack: session.redoStack,
    conversations: session.conversations,
    activeConversation: session.activeConversation,
    isStreaming: session.isStreaming,
    selectedTextForAI: session.selectedTextForAI,
    selectedPageForAI: session.selectedPageForAI,
    selectedEndPageForAI: session.selectedEndPageForAI,
    selectedRectsForAI: session.selectedRectsForAI,
    indexStatus: session.indexStatus,
    indexProgress: session.indexProgress,
  };
}

type TabFields = Omit<DocumentTabSession, 'id' | 'identity' | 'pdfFile'>;

// Applies a change to one document tab. The active tab's fields live at the
// top level of the state, other tabs' fields in documentTabs.
function patchTab(
  state: AppState,
  tabId: string | null | undefined,
  change: (tab: TabFields) => Partial<TabFields>
): Partial<AppState> {
  if (!tabId || tabId === state.activeDocumentTabId) {
    return change(state as unknown as TabFields) as Partial<AppState>;
  }
  const index = state.documentTabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return {};
  const documentTabs = [...state.documentTabs];
  documentTabs[index] = { ...documentTabs[index], ...change(documentTabs[index]) };
  return { documentTabs };
}

export const useStore = create<AppState>((set, get) => ({
  // ─── Initial State ───

  documentTabs: [],
  activeDocumentTabId: null,

  pdfFile: null,
  documentSessionId: 0,
  pageTexts: new Map(),
  pageHeadings: new Map(),
  documentOutline: [],
  extractedPageCount: 0,
  documentTextReady: false,
  numPages: 0,
  currentPage: 1,
  zoom: 1.0,

  highlights: [],
  annotations: [],
  activeHighlightColor: 'yellow',
  activeTool: 'select',
  undoStack: [],
  redoStack: [],

  conversations: [],
  activeConversation: null,
  isStreaming: false,
  selectedTextForAI: '',
  selectedPageForAI: 0,
  selectedEndPageForAI: 0,
  selectedRectsForAI: [],
  indexStatus: 'idle',
  indexProgress: '',

  embeddingStatus: 'unknown',
  embeddingProgress: '',

  sidebarOpen: true,
  sidebarWidth: 700,
  sidebarTab: 'chat',
  settingsOpen: false,
  thumbnailSidebarOpen: true,

  settings: {
    ...DEFAULT_SETTINGS,
    providers: Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS.providers).map(([id, provider]) => [
        id,
        { ...provider, models: [...provider.models] },
      ])
    ) as AppSettings['providers'],
  },

  // ─── PDF ───

  setPdfFile: (file) => {
    if (!file) {
      get().documentTabs.forEach((tab) => {
        abortChatRequest(tab.id);
        releaseRegisteredDocument(tab.id);
      });
    }
    set((state) => {
    const captured = captureActiveSession(state);
    let documentTabs = captured
      ? state.documentTabs.map((tab) => tab.id === captured.id ? captured : tab)
      : state.documentTabs;
    if (!file) {
      return {
        documentTabs: [],
        activeDocumentTabId: null,
        pdfFile: null,
        documentSessionId: state.documentSessionId + 1,
        pageTexts: new Map(),
        pageHeadings: new Map(),
        documentOutline: [],
        extractedPageCount: 0,
        documentTextReady: false,
        numPages: 0,
        currentPage: 1,
        zoom: 1,
        highlights: [],
        annotations: [],
        undoStack: [],
        redoStack: [],
        conversations: [],
        activeConversation: null,
        isStreaming: false,
        selectedTextForAI: '',
        selectedPageForAI: 0,
        selectedEndPageForAI: 0,
        selectedRectsForAI: [],
        indexStatus: 'idle',
        indexProgress: '',
      };
    }
    const identity = documentIdentity(file);
    const existing = documentTabs.find((tab) => tab.identity === identity);
    if (existing) {
      return {
        documentTabs,
        ...activateSession(existing, state.documentSessionId + 1),
      };
    }
    const session = newDocumentSession(file);
    documentTabs = [...documentTabs, session];
    return {
      documentTabs,
      ...activateSession(session, state.documentSessionId + 1),
    };
    });
  },
  switchDocumentTab: (id) => set((state) => {
    if (id === state.activeDocumentTabId) return state;
    const captured = captureActiveSession(state);
    const documentTabs = captured
      ? state.documentTabs.map((tab) => tab.id === captured.id ? captured : tab)
      : state.documentTabs;
    const target = documentTabs.find((tab) => tab.id === id);
    if (!target) return state;
    return {
      documentTabs,
      ...activateSession(target, state.documentSessionId + 1),
    };
  }),
  closeDocumentTab: (id) => {
    abortChatRequest(id);
    releaseRegisteredDocument(id);
    set((state) => {
      const captured = captureActiveSession(state);
      const synchronizedTabs = captured
        ? state.documentTabs.map((tab) => tab.id === captured.id ? captured : tab)
        : state.documentTabs;
      const closingIndex = synchronizedTabs.findIndex((tab) => tab.id === id);
      if (closingIndex < 0) return state;
      const documentTabs = synchronizedTabs.filter((tab) => tab.id !== id);
      if (id !== state.activeDocumentTabId) return { documentTabs };
      const nextTab = documentTabs[Math.min(closingIndex, documentTabs.length - 1)];
      if (nextTab) {
        return {
          documentTabs,
          ...activateSession(nextTab, state.documentSessionId + 1),
        };
      }
      return {
        documentTabs: [],
        activeDocumentTabId: null,
        pdfFile: null,
        documentSessionId: state.documentSessionId + 1,
        pageTexts: new Map(),
        pageHeadings: new Map(),
        documentOutline: [],
        extractedPageCount: 0,
        documentTextReady: false,
        numPages: 0,
        currentPage: 1,
        highlights: [],
        annotations: [],
        undoStack: [],
        redoStack: [],
        conversations: [],
        activeConversation: null,
        isStreaming: false,
        selectedTextForAI: '',
        selectedPageForAI: 0,
        selectedEndPageForAI: 0,
        selectedRectsForAI: [],
        indexStatus: 'idle',
        indexProgress: '',
      };
    });
  },
  // Extraction commits pages in batches. Copying the Map once per batch
  // instead of once per page keeps extraction linear in the page count.
  mergePageTexts: (entries, tabId, headings = []) =>
    set((s) => patchTab(s, tabId, (tab) => {
      if (entries.length === 0 && headings.length === 0) return {};
      const pageTexts = new Map(tab.pageTexts);
      for (const [page, text] of entries) pageTexts.set(page, text);
      const pageHeadings = headings.length ? new Map(tab.pageHeadings) : tab.pageHeadings;
      for (const [page, lines] of headings) pageHeadings.set(page, lines);
      return { pageTexts, pageHeadings };
    })),
  setExtractionProgress: (extractedPageCount, documentTextReady = false, tabId) =>
    set((s) => patchTab(s, tabId, () => ({
      extractedPageCount,
      documentTextReady,
      indexStatus: documentTextReady ? 'ready' : 'extracting',
      indexProgress: documentTextReady
        ? 'PDF text extraction complete'
        : `Extracting PDF text — page ${extractedPageCount}`,
    }))),
  setDocumentOutline: (documentOutline, tabId) =>
    set((s) => patchTab(s, tabId, () => ({ documentOutline }))),
  setEmbeddingState: (embeddingStatus, embeddingProgress = '') => set({ embeddingStatus, embeddingProgress }),
  setNumPages: (n) => set({ numPages: n }),
  setCurrentPage: (p) => set({ currentPage: p }),
  setZoom: (z) => set({ zoom: Math.max(0.25, Math.min(5, z)) }),
  zoomIn: () => set((s) => ({ zoom: Math.min(5, s.zoom + 0.15) })),
  zoomOut: () => set((s) => ({ zoom: Math.max(0.25, s.zoom - 0.15) })),
  zoomReset: () => set({ zoom: 1.0 }),

  // ─── Annotations ───

  addHighlight: (h) => set((s) => ({
    highlights: [...s.highlights, h],
    undoStack: [...s.undoStack, { type: 'add_highlight', highlight: h }],
    redoStack: [], // Clear redo stack on new action
  })),
  removeHighlight: (id) => set((s) => {
    const highlight = s.highlights.find((h) => h.id === id);
    if (!highlight) return s;
    return {
      highlights: s.highlights.filter((h) => h.id !== id),
      undoStack: [...s.undoStack, { type: 'remove_highlight', highlight }],
      redoStack: [], // Clear redo stack on new action
    };
  }),
  updateHighlightComment: (id, comment) => set((s) => {
    const highlight = s.highlights.find((h) => h.id === id);
    if (!highlight) return s;
    return {
      highlights: s.highlights.map((h) => (h.id === id ? { ...h, comment } : h)),
      undoStack: [...s.undoStack, { type: 'update_comment', id, oldComment: highlight.comment, newComment: comment }],
      redoStack: [], // Clear redo stack on new action
    };
  }),
  addAnnotation: (a) => set((s) => ({ annotations: [...s.annotations, a] })),
  removeAnnotation: (id) => set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) })),
  setActiveHighlightColor: (c) => set({ activeHighlightColor: c }),
  setActiveTool: (t) => set({ activeTool: t }),

  // ─── Undo/Redo ───

  undo: () => set((s) => {
    if (s.undoStack.length === 0) return s;

    const action = s.undoStack[s.undoStack.length - 1];
    const newUndoStack = s.undoStack.slice(0, -1);

    switch (action.type) {
      case 'add_highlight':
        // Undo adding = remove the highlight
        return {
          highlights: s.highlights.filter((h) => h.id !== action.highlight.id),
          undoStack: newUndoStack,
          redoStack: [...s.redoStack, action],
        };
      case 'remove_highlight':
        // Undo removing = add the highlight back
        return {
          highlights: [...s.highlights, action.highlight],
          undoStack: newUndoStack,
          redoStack: [...s.redoStack, action],
        };
      case 'update_comment':
        // Undo comment update = restore old comment
        return {
          highlights: s.highlights.map((h) =>
            h.id === action.id ? { ...h, comment: action.oldComment } : h
          ),
          undoStack: newUndoStack,
          redoStack: [...s.redoStack, action],
        };
      default:
        return s;
    }
  }),

  redo: () => set((s) => {
    if (s.redoStack.length === 0) return s;

    const action = s.redoStack[s.redoStack.length - 1];
    const newRedoStack = s.redoStack.slice(0, -1);

    switch (action.type) {
      case 'add_highlight':
        // Redo adding = add the highlight
        return {
          highlights: [...s.highlights, action.highlight],
          undoStack: [...s.undoStack, action],
          redoStack: newRedoStack,
        };
      case 'remove_highlight':
        // Redo removing = remove the highlight
        return {
          highlights: s.highlights.filter((h) => h.id !== action.highlight.id),
          undoStack: [...s.undoStack, action],
          redoStack: newRedoStack,
        };
      case 'update_comment':
        // Redo comment update = apply new comment
        return {
          highlights: s.highlights.map((h) =>
            h.id === action.id ? { ...h, comment: action.newComment } : h
          ),
          undoStack: [...s.undoStack, action],
          redoStack: newRedoStack,
        };
      default:
        return s;
    }
  }),

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  // ─── AI ───

  setSelectedTextForAI: (text, page, rects = [], endPage = page) => set({
    selectedTextForAI: text,
    selectedPageForAI: page,
    selectedEndPageForAI: endPage,
    selectedRectsForAI: rects,
  }),
  clearSelectedTextForAI: () => set({
    selectedTextForAI: '',
    selectedPageForAI: 0,
    selectedEndPageForAI: 0,
    selectedRectsForAI: [],
  }),
  newConversation: () => {
    const id = uid();
    const conv: ChatConversation = {
      id,
      title: 'New Chat',
      messages: [],
      createdAt: Date.now(),
    };
    set((s) => ({
      conversations: [...s.conversations, conv],
      activeConversation: id,
    }));
    return id;
  },
  addMessage: (convId, msg, documentTabId) =>
    set((s) => {
      const targetTabId = documentTabId || s.activeDocumentTabId;
      const addTo = (conversations: ChatConversation[]) => conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: [...c.messages, msg],
              title:
                c.messages.length === 0 && msg.role === 'user'
                  ? msg.content.slice(0, 60) + (msg.content.length > 60 ? '…' : '')
                  : c.title,
            }
          : c
      );
      if (!targetTabId || targetTabId === s.activeDocumentTabId) {
        return { conversations: addTo(s.conversations) };
      }
      return {
        documentTabs: s.documentTabs.map((tab) =>
          tab.id === targetTabId ? { ...tab, conversations: addTo(tab.conversations) } : tab
        ),
      };
    }),
  updateLastAssistantMessage: (convId, content, documentTabId) =>
    set((s) => {
      const targetTabId = documentTabId || s.activeDocumentTabId;
      const update = (conversations: ChatConversation[]) => conversations.map((c) => {
        if (c.id !== convId) return c;
        const msgs = [...c.messages];
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i].role === 'assistant') {
            msgs[i] = { ...msgs[i], content };
            break;
          }
        }
        return { ...c, messages: msgs };
      });
      if (!targetTabId || targetTabId === s.activeDocumentTabId) {
        return { conversations: update(s.conversations) };
      }
      return {
        documentTabs: s.documentTabs.map((tab) =>
          tab.id === targetTabId ? { ...tab, conversations: update(tab.conversations) } : tab
        ),
      };
    }),
  setActiveConversation: (id) => set({ activeConversation: id }),
  setIsStreaming: (v, documentTabId) => set((s) => {
    const targetTabId = documentTabId || s.activeDocumentTabId;
    if (!targetTabId || targetTabId === s.activeDocumentTabId) return { isStreaming: v };
    return {
      documentTabs: s.documentTabs.map((tab) =>
        tab.id === targetTabId ? { ...tab, isStreaming: v } : tab
      ),
    };
  }),
  deleteConversation: (id) =>
    set((s) => {
      const removedIndex = s.conversations.findIndex((conversation) => conversation.id === id);
      const conversations = s.conversations.filter((conversation) => conversation.id !== id);
      if (s.activeConversation !== id) return { conversations };
      const nextIndex = Math.min(Math.max(0, removedIndex), Math.max(0, conversations.length - 1));
      return {
        conversations,
        activeConversation: conversations[nextIndex]?.id || null,
      };
    }),

  // ─── UI ───

  toggleSidebar: () => set((s) => {
    const sidebarOpen = !s.sidebarOpen;
    return { sidebarOpen, settings: { ...s.settings, sidebarOpen } };
  }),
  setSidebarOpen: (v) => set((s) => ({
    sidebarOpen: v,
    settings: { ...s.settings, sidebarOpen: v },
  })),
  setSidebarWidth: (w) => set((s) => {
    const sidebarWidth = Math.max(320, Math.min(1200, Math.round(w)));
    return { sidebarWidth, settings: { ...s.settings, sidebarWidth } };
  }),
  setSidebarTab: (t) => set({ sidebarTab: t }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  toggleThumbnailSidebar: () => set((s) => ({ thumbnailSidebarOpen: !s.thumbnailSidebarOpen })),
  setThumbnailSidebarOpen: (v) => set({ thumbnailSidebarOpen: v }),

  // ─── Settings ───

  hydrateSettings: (settings) => set({
    settings,
    sidebarOpen: settings.sidebarOpen,
    sidebarWidth: settings.sidebarWidth,
  }),
  updateSettings: (s) => set((state) => ({ settings: { ...state.settings, ...s } })),
  setActiveProvider: (p) =>
    set((s) => ({ settings: { ...s.settings, activeProvider: p } })),
  updateProviderConfig: (id, config) =>
    set((s) => ({
      settings: {
        ...s.settings,
        providers: {
          ...s.settings.providers,
          [id]: { ...s.settings.providers[id], ...config },
        },
      },
    })),
}));
