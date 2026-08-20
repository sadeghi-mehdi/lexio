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
  DocumentDigest,
  DigestStatus,
} from '../types.ts';
import { DEFAULT_SETTINGS } from '../types.ts';
import { abortChatRequest } from '../utils/chat-request-registry.ts';

export type ToolType = 'select' | AnnotationType | 'comment';

// Undo/Redo action types
type UndoAction =
  | { type: 'add_highlight'; highlight: Highlight }
  | { type: 'remove_highlight'; highlight: Highlight }
  | { type: 'update_comment'; id: string; oldComment: string | undefined; newComment: string };

export interface DocumentTabSession {
  id: string;
  identity: string;
  pdfFile: PdfFileData;
  pdfText: string;
  pageTexts: Map<number, string>;
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
  documentFingerprint: string;
  documentDigest: DocumentDigest | null;
  digestStatus: DigestStatus;
  digestProgress: string;
  digestError: string;
  digestRebuildToken: number;
  digestCancelToken: number;
}

interface AppState {
  documentTabs: DocumentTabSession[];
  activeDocumentTabId: string | null;

  // PDF
  pdfFile: PdfFileData | null;
  documentSessionId: number;
  pdfText: string;
  pageTexts: Map<number, string>;
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
  documentFingerprint: string;
  documentDigest: DocumentDigest | null;
  digestStatus: DigestStatus;
  digestProgress: string;
  digestError: string;
  digestRebuildToken: number;
  digestCancelToken: number;

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
  updateCurrentPdfData: (data: string) => void;
  setPdfText: (text: string) => void;
  setPageText: (page: number, text: string) => void;
  setExtractionProgress: (pageCount: number, complete?: boolean) => void;
  setDocumentFingerprint: (fingerprint: string) => void;
  setDocumentDigest: (digest: DocumentDigest | null) => void;
  setDigestState: (status: DigestStatus, progress?: string, error?: string) => void;
  rebuildDocumentDigest: () => void;
  cancelDocumentDigest: () => void;
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
  return `${file.path.toLowerCase()}::${file.data.length}`;
}

function captureActiveSession(state: AppState): DocumentTabSession | null {
  if (!state.pdfFile || !state.activeDocumentTabId) return null;
  const indexWasRunning = ['extracting', 'loading', 'generating', 'consolidating'].includes(state.digestStatus);
  return {
    id: state.activeDocumentTabId,
    identity: documentIdentity(state.pdfFile),
    pdfFile: state.pdfFile,
    pdfText: state.pdfText,
    pageTexts: state.pageTexts,
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
    documentFingerprint: state.documentFingerprint,
    documentDigest: state.documentDigest,
    digestStatus: indexWasRunning ? 'idle' : state.digestStatus,
    digestProgress: indexWasRunning ? 'Paused — activate this tab to continue' : state.digestProgress,
    digestError: state.digestError,
    digestRebuildToken: state.digestRebuildToken,
    digestCancelToken: state.digestCancelToken,
  };
}

function newDocumentSession(file: PdfFileData): DocumentTabSession {
  return {
    id: uid(),
    identity: documentIdentity(file),
    pdfFile: file,
    pdfText: '',
    pageTexts: new Map(),
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
    documentFingerprint: '',
    documentDigest: null,
    digestStatus: 'extracting',
    digestProgress: 'Extracting PDF text…',
    digestError: '',
    digestRebuildToken: 0,
    digestCancelToken: 0,
  };
}

function activateSession(session: DocumentTabSession, nextSessionId: number): Partial<AppState> {
  return {
    activeDocumentTabId: session.id,
    pdfFile: session.pdfFile,
    documentSessionId: nextSessionId,
    pdfText: session.pdfText,
    pageTexts: session.pageTexts,
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
    documentFingerprint: session.documentFingerprint,
    documentDigest: session.documentDigest,
    digestStatus: session.digestStatus,
    digestProgress: session.digestProgress,
    digestError: session.digestError,
    digestRebuildToken: session.digestRebuildToken,
    digestCancelToken: session.digestCancelToken,
  };
}

export const useStore = create<AppState>((set, get) => ({
  // ─── Initial State ───

  documentTabs: [],
  activeDocumentTabId: null,

  pdfFile: null,
  documentSessionId: 0,
  pdfText: '',
  pageTexts: new Map(),
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
  documentFingerprint: '',
  documentDigest: null,
  digestStatus: 'idle',
  digestProgress: '',
  digestError: '',
  digestRebuildToken: 0,
  digestCancelToken: 0,

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
    if (!file) get().documentTabs.forEach((tab) => abortChatRequest(tab.id));
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
        pdfText: '',
        pageTexts: new Map(),
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
        documentFingerprint: '',
        documentDigest: null,
        digestStatus: 'idle',
        digestProgress: '',
        digestError: '',
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
        pdfText: '',
        pageTexts: new Map(),
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
        documentFingerprint: '',
        documentDigest: null,
        digestStatus: 'idle',
        digestProgress: '',
        digestError: '',
      };
    });
  },
  updateCurrentPdfData: (data) => set((state) => ({
    pdfFile: state.pdfFile ? { ...state.pdfFile, data } : null,
  })),
  setPdfText: (text) => set({ pdfText: text }),
  setPageText: (page, text) =>
    set((s) => {
      const newMap = new Map(s.pageTexts);
      newMap.set(page, text);
      return { pageTexts: newMap };
    }),
  setExtractionProgress: (extractedPageCount, documentTextReady = false) => set({
    extractedPageCount,
    documentTextReady,
    digestStatus: documentTextReady ? 'idle' : 'extracting',
    digestProgress: documentTextReady
      ? 'PDF text extraction complete'
      : `Extracting PDF text — page ${extractedPageCount}`,
  }),
  setDocumentFingerprint: (documentFingerprint) => set({ documentFingerprint }),
  setDocumentDigest: (documentDigest) => set({ documentDigest }),
  setDigestState: (digestStatus, digestProgress = '', digestError = '') => set({
    digestStatus,
    digestProgress,
    digestError,
  }),
  rebuildDocumentDigest: () => set((state) => ({
    documentDigest: null,
    digestError: '',
    digestStatus: state.documentTextReady ? 'loading' : 'extracting',
    digestProgress: 'Rebuilding document digest…',
    digestRebuildToken: state.digestRebuildToken + 1,
  })),
  cancelDocumentDigest: () => set((state) => ({
    digestStatus: 'cancelled',
    digestProgress: 'Document digest generation cancelled',
    digestCancelToken: state.digestCancelToken + 1,
  })),
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
