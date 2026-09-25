import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  Send,
  Square,
  Plus,
  MessageSquare,
  BookMarked,
  Sparkles,
  ChevronDown,
  X,
  FileText,
  Copy,
  Check,
  StickyNote,
} from 'lucide-react';
import { useStore, WORKSPACE_CHAT, type DocumentTabSession } from '../stores/useStore';
import { providers } from '../providers/ai-providers';
import type { ChatMessage, AIProvider, ChatConversation, ConversationDocument } from '../types';
import { requestProviderText } from '../utils/provider-request';
import { abortChatRequest, clearChatRequest, registerChatRequest } from '../utils/chat-request-registry';
import { documentVectors, embedQuery } from '../utils/embedding-client';
import { renderCitations } from '../utils/citations';
import { loadLibrary, saveLibrary } from '../utils/library-store';
import {
  assignLabels,
  documentsInScope,
  prepareRequest,
  type OpenDocument,
} from '../utils/workspace-chat';
import { documentKey, tabDocumentIndex } from './DocumentIndexer';
import AnnotationsPanel from './AnnotationsPanel';
import { copyText } from '../utils/clipboard';
import { formatMarkdown } from '../utils/markdown';

const uid = () => Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

// All chats are saved together, under a fixed key in the library store.
const CHATS_KEY = 'c6582f8e9722f051ceb75ffcc93fd3ac0246d56ea0707980e740643d2e890305';
const CHATS_VERSION = 1;

// Open PDFs, most recently viewed first.
function openDocuments(): OpenDocument[] {
  const state = useStore.getState();
  const tabs = new Map(state.documentTabs.map((tab) => [tab.id, tab]));
  if (state.activeDocumentTabId && state.pdfFile) {
    // The active tab's fields live at the top level of the state.
    tabs.set(state.activeDocumentTabId, { ...(state as unknown as DocumentTabSession), id: state.activeDocumentTabId });
  }
  const order = [...state.recentTabIds, ...[...tabs.keys()].filter((id) => !state.recentTabIds.includes(id))];
  const seen = new Set<string>();
  return order.flatMap((tabId) => {
    const tab = tabs.get(tabId);
    if (!tab) return [];
    const key = documentKey(tab, tabId);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{
      tabId,
      key,
      name: tab.pdfFile.name,
      ready: tab.documentTextReady,
      tab,
      index: () => tabDocumentIndex(tab, tabId),
      vectors: documentVectors.get(key) || null,
    }];
  });
}

export default function AISidebar() {
  const {
    conversations,
    activeConversation,
    isStreaming,
    selectedTextForAI,
    selectedPageForAI,
    selectedEndPageForAI,
    hasPdf,
    documentTabs,
    activeDocumentTabId,
    recentTabIds,
    documentTextReady,
    sidebarTab,
    settings,
    newConversation,
    setActiveConversation,
    setIsStreaming,
    deleteConversation,
    clearSelectedTextForAI,
    setSidebarTab,
    setActiveProvider,
  } = useStore(useShallow((state) => ({
    conversations: state.conversations,
    activeConversation: state.activeConversation,
    isStreaming: state.isStreaming,
    selectedTextForAI: state.selectedTextForAI,
    selectedPageForAI: state.selectedPageForAI,
    selectedEndPageForAI: state.selectedEndPageForAI,
    hasPdf: Boolean(state.pdfFile),
    documentTabs: state.documentTabs,
    activeDocumentTabId: state.activeDocumentTabId,
    recentTabIds: state.recentTabIds,
    documentTextReady: state.documentTextReady,
    sidebarTab: state.sidebarTab,
    settings: state.settings,
    newConversation: state.newConversation,
    setActiveConversation: state.setActiveConversation,
    setIsStreaming: state.setIsStreaming,
    deleteConversation: state.deleteConversation,
    clearSelectedTextForAI: state.clearSelectedTextForAI,
    setSidebarTab: state.setSidebarTab,
    setActiveProvider: state.setActiveProvider,
  })));

  const [input, setInput] = useState('');
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [contextStatus, setContextStatus] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatsLoadedRef = useRef(false);

  const activeConv = conversations.find((c) => c.id === activeConversation);
  const activeProviderConfig = settings.providers[settings.activeProvider];

  // Open documents for the scope bar. Recomputed when tabs change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const open = useMemo(() => openDocuments(), [documentTabs, activeDocumentTabId, recentTabIds, documentTextReady]);
  const inScope = documentsInScope(activeConv, open, settings.chatMaxDocuments);
  const inScopeKeys = new Set(inScope.map((document) => document.key));
  const anyReady = inScope.some((document) => document.ready);

  // Load saved chats once, then save them (debounced) whenever they change.
  useEffect(() => {
    void loadLibrary<{ version: number; conversations: ChatConversation[] }>('chats', CHATS_KEY).then((saved) => {
      if (saved?.version === CHATS_VERSION && Array.isArray(saved.conversations) && useStore.getState().conversations.length === 0) {
        // An answer that was still streaming when the app closed is incomplete.
        useStore.getState().setConversations(saved.conversations.map((conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.status === 'streaming' ? { ...message, status: 'aborted' as const } : message
          ),
        })));
      }
      chatsLoadedRef.current = true;
    });
  }, []);
  useEffect(() => {
    if (!chatsLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveLibrary('chats', CHATS_KEY, { version: CHATS_VERSION, conversations });
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [conversations]);

  // Follow new output only while the reader is at the bottom.
  useEffect(() => {
    const messages = messagesRef.current;
    if (messages && stickToBottomRef.current) messages.scrollTop = messages.scrollHeight;
  }, [activeConv?.messages]);

  useEffect(() => {
    if (selectedTextForAI) inputRef.current?.focus();
  }, [selectedTextForAI]);

  const setScope = (conversationId: string | null, scope: ChatConversation['scope']) => {
    const id = conversationId || newConversation();
    useStore.getState().updateConversation(id, { scope });
  };

  const toggleDocument = (key: string) => {
    const keys = new Set(inScope.map((document) => document.key));
    if (keys.has(key)) {
      if (keys.size === 1) return;
      keys.delete(key);
    } else {
      keys.add(key);
    }
    setScope(activeConversation, { mode: 'custom', keys: [...keys] });
  };

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    const state = useStore.getState();
    if ((!text && !state.selectedTextForAI) || state.isStreaming) return;

    const convId = state.activeConversation || newConversation();
    let conversation = useStore.getState().conversations.find((c) => c.id === convId)!;
    const documents = openDocuments();
    const activeKey = state.activeDocumentTabId && state.pdfFile ? documentKey(state as never, state.activeDocumentTabId) : undefined;
    const selectionText = state.selectedTextForAI;
    const scoped = documentsInScope(conversation, documents, state.settings.chatMaxDocuments, selectionText ? activeKey : undefined);
    if (!selectionText && !scoped.some((document) => document.ready)) return;

    const labels = assignLabels(conversation.documents || [], scoped);
    useStore.getState().updateConversation(convId, { documents: labels });
    const label = (key: string | undefined) => labels.find((item) => item.key === key)?.label || '';

    const question = selectionText ? text || 'Please explain the selected passage.' : text;
    const selection = selectionText
      ? {
          text: selectionText,
          key: activeKey || '',
          label: label(activeKey),
          page: state.selectedPageForAI,
          endPage: state.selectedEndPageForAI || state.selectedPageForAI,
        }
      : null;

    const store = useStore.getState();
    store.addMessage(convId, {
      id: uid(),
      role: 'user',
      content: question,
      timestamp: Date.now(),
      selectedText: selectionText || undefined,
      pageNumber: selection ? selection.page : undefined,
      pageEndNumber: selection ? selection.endPage : undefined,
      documentKey: selection ? activeKey : undefined,
      documentName: selection ? state.pdfFile?.name : undefined,
    });
    stickToBottomRef.current = true;
    setInput('');
    store.clearSelectedTextForAI();

    const config = state.settings.providers[state.settings.activeProvider];
    store.addMessage(convId, {
      id: uid(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      providerId: state.settings.activeProvider,
      model: config.model,
      status: 'streaming',
    });
    store.setIsStreaming(true);

    const abort = new AbortController();
    registerChatRequest(WORKSPACE_CHAT, abort);
    let streamFrame = 0;
    try {
      const provider = providers[state.settings.activeProvider];
      if (!config.enabled) throw new Error(`${config.name} is disabled. Enable it in Settings before sending a message.`);
      if (!provider) throw new Error('Provider not found. Check your settings.');

      conversation = useStore.getState().conversations.find((c) => c.id === convId)!;
      // prepareRequest reads the conversation up to and including the new
      // question, so drop the empty answer placeholder.
      const request = await prepareRequest({
        question,
        selection,
        conversation: { ...conversation, messages: conversation.messages.slice(0, -1) },
        documents: scoped,
        labels,
        settings: state.settings,
        config,
        provider,
        queryVector: embedQuery,
        signal: abort.signal,
        onProgress: (status) => {
          setContextStatus(status);
          useStore.getState().updateLastAssistantMessage(convId, status);
        },
      });
      setContextStatus(`Using ${request.description}${request.notes.length ? ` and ${request.notes.length} of your markings` : ''}`);
      useStore.getState().patchLastAssistantMessage(convId, {
        content: '',
        sources: request.sources,
        notes: request.notes,
        contextDescription: request.description,
      });

      // Tokens can arrive hundreds of times per second. Keep only the latest
      // text and write it to the store at most once per animation frame.
      let pendingText: string | null = null;
      const flushPending = () => {
        streamFrame = 0;
        if (pendingText === null) return;
        useStore.getState().updateLastAssistantMessage(convId, pendingText);
        pendingText = null;
      };
      await requestProviderText(provider, request.history, request.systemPrompt, config, abort.signal, (accumulated) => {
        pendingText = accumulated;
        if (!streamFrame) streamFrame = window.requestAnimationFrame(flushPending);
      });
      window.cancelAnimationFrame(streamFrame);
      flushPending();
      useStore.getState().patchLastAssistantMessage(convId, { status: 'done' });
    } catch (err: any) {
      window.cancelAnimationFrame(streamFrame);
      if (err?.name === 'AbortError') {
        useStore.getState().patchLastAssistantMessage(convId, { status: 'aborted' });
      } else {
        useStore.getState().patchLastAssistantMessage(convId, { content: `⚠️ Error: ${err?.message || err}`, status: 'error' });
      }
    } finally {
      useStore.getState().setIsStreaming(false);
      setContextStatus(null);
      clearChatRequest(WORKSPACE_CHAT, abort);
    }
  }, [input, newConversation]);

  const stopStreaming = () => {
    abortChatRequest(WORKSPACE_CHAT);
    setIsStreaming(false);
  };

  // A click on a citation chip opens the cited PDF at the cited page.
  const openCitation = (event: React.MouseEvent) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>('.lexio-cite');
    if (!chip || !activeConv) return;
    const messageId = chip.closest<HTMLElement>('[data-message-id]')?.dataset.messageId;
    const message = activeConv.messages.find((item) => item.id === messageId);
    const document = activeConv.documents?.find((item) => item.label === chip.dataset.label);
    if (!document) return;
    let page = Number(chip.dataset.page) || 0;
    if (chip.dataset.note) {
      page = message?.notes?.find((note) => note.ref === chip.dataset.note && note.label === document.label)?.page || page;
    }
    const target = openDocuments().find((item) => item.key === document.key);
    if (!target) {
      setContextStatus(`${document.name} is not open. Open it again to jump to the cited page.`);
      window.setTimeout(() => setContextStatus(null), 4000);
      return;
    }
    if (page > 0) useStore.getState().jumpToPage(target.tabId, page);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const canSend = Boolean((input.trim() || selectedTextForAI) && (selectedTextForAI || anyReady));
  const labelFor = (key: string) => activeConv?.documents?.find((item) => item.key === key)?.label;
  const updateSettings = (patch: Partial<typeof settings>) => {
    useStore.getState().updateSettings(patch);
    window.electronAPI?.saveSettings(useStore.getState().settings);
  };

  return (
    <div className="h-full flex flex-col bg-surface-1">
      {/* Tabs */}
      <div className="flex border-b border-surface-3 flex-shrink-0">
        <TabButton
          active={sidebarTab === 'chat'}
          icon={<Sparkles size={14} />}
          label="AI Chat"
          onClick={() => setSidebarTab('chat')}
        />
        <TabButton
          active={sidebarTab === 'annotations'}
          icon={<BookMarked size={14} />}
          label="Annotations"
          onClick={() => setSidebarTab('annotations')}
        />
      </div>

      {sidebarTab === 'chat' ? (
        <>
          {/* Provider selector + new chat */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3 flex-shrink-0">
            <div className="relative flex items-center">
              <button
                onClick={() => setShowProviderMenu(!showProviderMenu)}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs bg-surface-2 text-text-secondary hover:bg-surface-3 transition-colors"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${activeProviderConfig.enabled ? 'bg-emerald-400' : 'bg-red-400'}`} />
                <span>{activeProviderConfig.name}</span>
                <span className="max-w-[150px] truncate text-text-muted">· {activeProviderConfig.model}</span>
                <ChevronDown size={12} />
              </button>

              {showProviderMenu && (
                <div className="absolute top-full left-0 mt-1 bg-surface-3 border border-surface-4 rounded-lg shadow-xl z-50 min-w-[180px] py-1 animate-fade-in">
                  {(Object.keys(settings.providers) as AIProvider[]).map((id) => {
                    const p = settings.providers[id];
                    return (
                      <button
                        key={id}
                        onClick={() => {
                          setActiveProvider(id);
                          setShowProviderMenu(false);
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-surface-4 transition-colors ${
                          id === settings.activeProvider ? 'text-accent-light' : 'text-text-secondary'
                        }`}
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${p.enabled ? 'bg-emerald-400' : 'bg-surface-4'}`} />
                        {p.name}
                        <span className="text-text-muted ml-auto">{p.model}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex-1" />

            <button
              onClick={() => {
                const id = newConversation();
                setActiveConversation(id);
              }}
              className="p-1 rounded-md text-text-secondary hover:bg-surface-3 hover:text-text-primary transition-colors"
              title="New chat"
            >
              <Plus size={15} />
            </button>
          </div>

          {/* Conversation tabs, newest first */}
          {conversations.length > 0 && (
            <div className="flex gap-1 px-3 py-1.5 border-b border-surface-3 overflow-x-auto flex-shrink-0">
              {[...conversations].reverse().map((conv) => {
                const isActive = conv.id === activeConversation;
                return (
                  <div
                    key={conv.id}
                    className={`group flex items-center rounded text-xs whitespace-nowrap transition-colors ${
                      isActive
                        ? 'bg-accent/20 text-accent-light'
                        : 'text-text-muted hover:bg-surface-3 hover:text-text-secondary'
                    }`}
                  >
                    <button
                      onClick={() => setActiveConversation(conv.id)}
                      className="flex min-w-0 items-center gap-1 py-1 pl-2"
                      title={conv.title}
                    >
                      <MessageSquare size={11} className="flex-shrink-0" />
                      <span className="max-w-[120px] truncate">{conv.title}</span>
                    </button>
                    <button
                      aria-label={`Delete chat: ${conv.title}`}
                      title="Delete chat"
                      onClick={() => {
                        if (isActive && isStreaming) stopStreaming();
                        deleteConversation(conv.id);
                      }}
                      className={`mx-1 rounded p-0.5 hover:bg-red-500/10 hover:text-red-400 focus:opacity-100 ${
                        isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      }`}
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {contextStatus && (
            <div className="flex-shrink-0 border-b border-surface-3 bg-accent/5 px-3 py-1.5 text-[11px] text-accent-light">
              {contextStatus}
            </div>
          )}

          {/* Messages */}
          <div
            ref={messagesRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
            onClick={openCitation}
            className="flex-1 overflow-y-auto px-3 py-3 space-y-3"
          >
            {!activeConv || activeConv.messages.length === 0 ? (
              <EmptyChat />
            ) : (
              activeConv.messages.map((msg) => (
                <ChatBubble key={msg.id} message={msg} documents={activeConv.documents || EMPTY_DOCUMENTS} />
              ))
            )}
          </div>

          {/* Input */}
          <div className="flex-shrink-0 p-3 border-t border-surface-3">
            {/* Documents this chat searches */}
            {hasPdf && (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                {open.map((document) => {
                  const selected = inScopeKeys.has(document.key);
                  const label = labelFor(document.key);
                  return (
                    <button
                      key={document.key}
                      onClick={() => toggleDocument(document.key)}
                      title={`${document.name}${document.ready ? '' : ' (text not ready yet)'}${selected ? ' · included' : ' · not included'}`}
                      className={`flex max-w-[170px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                        selected
                          ? 'border-accent/40 bg-accent/10 text-accent-light'
                          : 'border-surface-3 text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {label && <span className="font-semibold">{label}</span>}
                      <span className="truncate">{document.name.replace(/\.pdf$/i, '')}</span>
                      {!document.ready && <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-amber-300" />}
                    </button>
                  );
                })}
                <span className="flex-1" />
                {open.length > 1 && (
                  <>
                    <button
                      onClick={() => setScope(activeConversation, { mode: 'all', keys: [] })}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${activeConv?.scope?.mode !== 'custom' ? 'text-accent-light' : 'text-text-muted hover:text-text-secondary'}`}
                      title={`Search the ${Math.min(open.length, settings.chatMaxDocuments)} most recently viewed PDFs`}
                    >
                      All open
                    </button>
                    <button
                      onClick={() => {
                        const current = open.find((document) => document.tabId === activeDocumentTabId);
                        if (current) setScope(activeConversation, { mode: 'custom', keys: [current.key] });
                      }}
                      className="rounded px-1.5 py-0.5 text-[10px] text-text-muted hover:text-text-secondary"
                      title="Search only the PDF shown now"
                    >
                      This PDF
                    </button>
                  </>
                )}
                <button
                  onClick={() => updateSettings({ includeNotes: !settings.includeNotes })}
                  className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${settings.includeNotes ? 'text-accent-light' : 'text-text-muted hover:text-text-secondary'}`}
                  title={settings.includeNotes ? 'Your highlights and notes are sent with questions' : 'Your highlights and notes are not sent'}
                >
                  <StickyNote size={10} /> Notes {settings.includeNotes ? 'on' : 'off'}
                </button>
              </div>
            )}

            {selectedTextForAI && (
              <div className="mb-2 p-2 bg-accent/10 border border-accent/20 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 text-accent-light">
                    <FileText size={12} />
                    <span className="text-[10px] uppercase tracking-wider">
                      {selectedEndPageForAI && selectedEndPageForAI !== selectedPageForAI
                        ? `Pages ${selectedPageForAI}–${selectedEndPageForAI}`
                        : `Page ${selectedPageForAI}`}
                    </span>
                  </div>
                  <button
                    onClick={clearSelectedTextForAI}
                    className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                  >
                    <X size={12} />
                  </button>
                </div>
                <p className="text-xs text-text-secondary line-clamp-2">"{selectedTextForAI}"</p>
              </div>
            )}

            <div className="relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={selectedTextForAI
                  ? 'Ask about this passage…'
                  : inScope.length > 1 ? `Ask about ${inScope.length} PDFs… (name one with @D2)` : 'Ask about the document…'}
                rows={Math.min(6, Math.max(1, input.split('\n').length))}
                className="block w-full bg-surface-2 text-text-primary text-sm leading-5 rounded-xl px-4 py-3 pr-12 resize-none outline-none border border-surface-3 focus:border-accent/40 transition-colors placeholder-text-muted"
              />
              <button
                onClick={isStreaming ? stopStreaming : sendMessage}
                disabled={!isStreaming && !canSend}
                className={`absolute inset-y-0 right-2 my-auto flex h-8 w-8 items-center justify-center rounded-lg p-0 transition-colors ${
                  isStreaming
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : canSend
                      ? 'bg-accent/20 text-accent-light hover:bg-accent/30'
                      : 'text-text-muted cursor-not-allowed'
                }`}
              >
                {isStreaming ? <Square size={16} /> : <Send size={16} />}
              </button>
            </div>
          </div>
        </>
      ) : (
        <AnnotationsPanel />
      )}
    </div>
  );
}

const EMPTY_DOCUMENTS: ConversationDocument[] = [];

// ─── Sub-components ───

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium transition-colors ${
        active
          ? 'text-accent-light border-b-2 border-accent'
          : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// Memoized: while one answer streams, the other bubbles keep the same message
// object and skip re-rendering and re-formatting entirely.
const ChatBubble = memo(function ChatBubble({
  message,
  documents,
}: {
  message: ChatMessage;
  documents: readonly ConversationDocument[];
}) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const html = useMemo(
    () => renderCitations(formatMarkdown(message.content), message, documents),
    [message, documents]
  );
  const selectionLabel = documents.find((document) => document.key === message.documentKey)?.label;

  const copyMessage = async () => {
    try {
      await copyText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.error('Failed to copy chat message:', error);
    }
  };

  return (
    <div data-message-id={message.id} className={`chat-message flex items-end gap-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {isUser && message.content && (
        <MessageCopyButton copied={copied} isUser onClick={copyMessage} />
      )}
      <div
        className={`max-w-[90%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
          isUser
            ? 'bg-accent/20 text-text-primary rounded-br-md'
            : 'bg-surface-2 text-text-primary rounded-bl-md'
        }`}
      >
        {isUser && message.selectedText && (
          <div className="mb-2 rounded-lg border border-accent/20 bg-surface-1/50 px-2.5 py-2 text-xs text-text-secondary">
            <div className="mb-1 text-[10px] uppercase tracking-wider text-accent-light">
              {`Selected passage${selectionLabel ? ` · ${selectionLabel}` : ''}`}
              {message.pageEndNumber && message.pageNumber && message.pageEndNumber !== message.pageNumber
                ? ` · pages ${message.pageNumber}–${message.pageEndNumber}`
                : message.pageNumber ? ` · page ${message.pageNumber}` : ''}
            </div>
            <div className="line-clamp-3 whitespace-pre-wrap">“{message.selectedText}”</div>
          </div>
        )}
        {message.content ? (
          <div
            className="whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <div className="loading-dots flex gap-1.5 py-1">
            <span />
            <span />
            <span />
          </div>
        )}
        {!isUser && message.model && (
          <div className="mt-2 border-t border-surface-3/70 pt-1.5 text-[10px] text-text-muted">
            {message.providerId ? `${message.providerId} · ` : ''}{message.model}
            {message.status === 'aborted' ? ' · stopped' : ''}
            {message.contextDescription ? ` · used ${message.contextDescription}` : ''}
          </div>
        )}
      </div>
      {!isUser && message.content && (
        <MessageCopyButton copied={copied} isUser={false} onClick={copyMessage} />
      )}
    </div>
  );
});

function MessageCopyButton({
  copied,
  isUser,
  onClick,
}: {
  copied: boolean;
  isUser: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-3 hover:text-text-primary"
      title={copied ? 'Copied' : isUser ? 'Copy your message' : 'Copy AI response'}
      aria-label={copied ? 'Message copied' : isUser ? 'Copy your message' : 'Copy AI response'}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function EmptyChat() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-6 opacity-60">
      <div className="w-12 h-12 rounded-2xl bg-accent/10 flex items-center justify-center mb-4">
        <Sparkles size={22} className="text-accent-light" />
      </div>
      <p className="text-sm text-text-secondary font-medium mb-1">Ask about your documents</p>
      <p className="text-xs text-text-muted leading-relaxed">
        Select text and click "Ask AI", or type a question below. The chat searches the open PDFs
        marked below, uses your highlights and notes, and cites the pages it used.
      </p>
    </div>
  );
}
