import { useState, useRef, useEffect, useCallback } from 'react';
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
} from 'lucide-react';
import { useStore } from '../stores/useStore';
import { providers, type AIProviderInterface } from '../providers/ai-providers';
import type { ChatMessage, AIProvider, ProviderConfig } from '../types';
import {
  buildContextSystemPrompt,
  buildDocumentContext,
  chooseDocumentAwareStrategy,
  chunkDocument,
  groupTextsWithinBudget,
} from '../utils/document-context';
import { retrieveDigestContext } from '../utils/document-digest';
import { requestProviderText } from '../utils/provider-request';
import {
  abortChatRequest,
  clearChatRequest,
  registerChatRequest,
} from '../utils/chat-request-registry';
import AnnotationsPanel from './AnnotationsPanel';
import { copyText } from '../utils/clipboard';

const uid = () => Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

async function summarizeDocumentHierarchically({
  pageTexts,
  maxChars,
  provider,
  config,
  customInstructions,
  signal,
  onProgress,
}: {
  pageTexts: ReadonlyMap<number, string>;
  maxChars: number;
  provider: AIProviderInterface;
  config: ProviderConfig;
  customInstructions: string;
  signal: AbortSignal;
  onProgress: (status: string) => void;
}): Promise<string> {
  const chunks = chunkDocument(pageTexts, maxChars);
  let summaries: string[] = [];

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    onProgress(`Summarizing section ${index + 1} of ${chunks.length} (pages ${chunk.startPage}–${chunk.endPage})…`);
    const summary = await requestProviderText(
      provider,
      [{
        id: `summary-${index}`,
        role: 'user',
        content: 'Summarize this section faithfully. Preserve methods, findings, numerical results, limitations, recommendations, and page references. Do not add unsupported claims.',
        timestamp: Date.now(),
      }],
      buildContextSystemPrompt(
        chunk.text,
        `pages ${chunk.startPage}–${chunk.endPage}`,
        customInstructions
      ),
      config,
      signal
    );
    summaries.push(`--- Summary of pages ${chunk.startPage}–${chunk.endPage} ---\n${summary}`);
  }

  let reductionPass = 1;
  while (summaries.join('\n\n').length > Math.floor(maxChars * 0.8) && reductionPass <= 6) {
    const groups = groupTextsWithinBudget(summaries, maxChars);
    const reduced: string[] = [];
    for (let index = 0; index < groups.length; index++) {
      onProgress(`Consolidating summary ${index + 1} of ${groups.length}…`);
      const combined = groups[index].join('\n\n');
      const summary = await requestProviderText(
        provider,
        [{
          id: `reduction-${reductionPass}-${index}`,
          role: 'user',
          content: 'Consolidate these section summaries without losing major findings, quantitative results, limitations, recommendations, or page references.',
          timestamp: Date.now(),
        }],
        buildContextSystemPrompt(
          combined,
          'structured summaries covering the document',
          customInstructions
        ),
        config,
        signal
      );
      reduced.push(summary);
    }
    summaries = reduced;
    reductionPass++;
  }

  return summaries.join('\n\n').slice(0, maxChars);
}

export default function AISidebar() {
  const {
    conversations,
    activeConversation,
    isStreaming,
    selectedTextForAI,
    selectedPageForAI,
    selectedEndPageForAI,
    selectedRectsForAI,
    pdfFile,
    documentSessionId,
    pageTexts,
    extractedPageCount,
    documentTextReady,
    numPages,
    documentDigest,
    digestStatus,
    digestProgress,
    digestError,
    sidebarTab,
    settings,
    newConversation,
    addMessage,
    updateLastAssistantMessage,
    setActiveConversation,
    setIsStreaming,
    deleteConversation,
    clearSelectedTextForAI,
    setSidebarTab,
    setActiveProvider,
    rebuildDocumentDigest,
    cancelDocumentDigest,
  } = useStore();

  const [input, setInput] = useState('');
  const [showProviderMenu, setShowProviderMenu] = useState(false);
  const [contextStatus, setContextStatus] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeConv = conversations.find((c) => c.id === activeConversation);
  const activeProviderConfig = settings.providers[settings.activeProvider];
  const documentQuestionReady = documentTextReady;

  // Auto-scroll to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeConv?.messages]);

  // When text is selected for AI, focus the input (but don't populate it)
  useEffect(() => {
    if (selectedTextForAI) {
      inputRef.current?.focus();
    }
  }, [selectedTextForAI]);

  useEffect(() => {
    setContextStatus(null);
    setInput('');
  }, [documentSessionId]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if ((!text && !selectedTextForAI) || isStreaming) return;
    if (!selectedTextForAI && !documentTextReady) return;
    const requestTabId = useStore.getState().activeDocumentTabId;
    if (!requestTabId) return;
    const requestTabIsActive = () => useStore.getState().activeDocumentTabId === requestTabId;

    const selectionText = selectedTextForAI;
    const selectionPage = selectedPageForAI;
    const selectionEndPage = selectedEndPageForAI || selectionPage;
    const selectionRects = [...selectedRectsForAI];

    let convId = activeConversation;
    if (!convId) {
      convId = newConversation();
    }

    const fullContent = selectionText
      ? text || 'Please explain the selected passage.'
      : text;

    const userMsg: ChatMessage & { rects?: typeof selectedRectsForAI } = {
      id: uid(),
      role: 'user',
      content: fullContent,
      timestamp: Date.now(),
      selectedText: selectionText || undefined,
      pageNumber: selectionText ? selectionPage : undefined,
      pageEndNumber: selectionText ? selectionEndPage : undefined,
    };
    if (selectionRects.length > 0) {
      (userMsg as any).rects = selectionRects;
    }
    addMessage(convId, userMsg, requestTabId);
    setInput('');
    clearSelectedTextForAI();

    const assistantMsg: ChatMessage = {
      id: uid(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      providerId: settings.activeProvider,
      model: activeProviderConfig.model,
    };
    addMessage(convId, assistantMsg, requestTabId);
    setIsStreaming(true, requestTabId);

    const abort = new AbortController();
    registerChatRequest(requestTabId, abort);

    try {
      const state = useStore.getState();
      const conv = state.conversations.find((c) => c.id === convId);
      const allMessages = conv?.messages.filter((m) => m.role !== 'system') || [];
      const apiMessages = allMessages.slice(0, -1).filter((m) => m.content);
      const provider = providers[settings.activeProvider];

      if (!activeProviderConfig.enabled) {
        throw new Error(`${activeProviderConfig.name} is disabled. Enable it in Settings before sending a message.`);
      }

      if (!selectionText && state.pageTexts.size === 0) {
        throw new Error('No extractable PDF text is available yet. Wait for loading to finish or select a passage.');
      }

      if (!provider) {
        updateLastAssistantMessage(convId, '⚠️ Provider not found. Check your settings.', requestTabId);
        setIsStreaming(false, requestTabId);
        return;
      }

      const maxContextChars = Math.max(
        10000,
        Math.min(2000000, Math.round(settings.maxContextChars))
      );

      let contextText = '';
      let contextDescription = '';
      if (selectionText) {
        const context = buildDocumentContext({
          pageTexts: state.pageTexts,
          mode: 'selection',
          query: text || fullContent,
          maxChars: maxContextChars,
          selectedPage: selectionPage,
          selectedEndPage: selectionEndPage,
          selectedText: selectionText,
        });
        contextText = context.text;
        contextDescription = context.description;
      } else if (settings.contextMode === 'rawEntire') {
        const context = buildDocumentContext({
          pageTexts: state.pageTexts,
          mode: 'entire',
          query: text,
          maxChars: maxContextChars,
        });
        contextText = context.text;
        contextDescription = context.description;
        if (context.requiresHierarchicalSummary) {
          contextDescription = `fresh hierarchical summaries of the entire ${state.pageTexts.size}-page document`;
          contextText = await summarizeDocumentHierarchically({
            pageTexts: state.pageTexts,
            maxChars: maxContextChars,
            provider,
            config: activeProviderConfig,
            customInstructions: settings.customInstructions,
            signal: abort.signal,
            onProgress: (status) => {
              if (requestTabIsActive()) setContextStatus(status);
              updateLastAssistantMessage(convId!, status, requestTabId);
            },
          });
        }
      } else {
        const completeContext = buildDocumentContext({
          pageTexts: state.pageTexts,
          mode: 'entire',
          query: text,
          maxChars: maxContextChars,
        });
        const strategy = chooseDocumentAwareStrategy(
          text,
          completeContext.requiresHierarchicalSummary,
          Boolean(state.documentDigest)
        );
        if (strategy === 'entire-original') {
          contextText = completeContext.text;
          contextDescription = `the complete original text of the ${completeContext.pages.length}-page document`;
        } else if (strategy === 'hierarchical-summary') {
          contextDescription = `complete hierarchical summaries of the entire ${state.pageTexts.size}-page document`;
          contextText = await summarizeDocumentHierarchically({
            pageTexts: state.pageTexts,
            maxChars: maxContextChars,
            provider,
            config: activeProviderConfig,
            customInstructions: settings.customInstructions,
            signal: abort.signal,
            onProgress: (status) => {
              if (requestTabIsActive()) setContextStatus(status);
              updateLastAssistantMessage(convId!, status, requestTabId);
            },
          });
        } else if (strategy === 'indexed-retrieval' && state.documentDigest) {
          const digest = state.documentDigest;
          const retrieval = retrieveDigestContext({
            digest,
            pageTexts: state.pageTexts,
            query: text,
            maxChars: maxContextChars,
            maxRanges: settings.maxRetrievedRanges,
          });
          contextText = retrieval.text;
          contextDescription = retrieval.description;
        } else {
          const fallback = buildDocumentContext({
            pageTexts: state.pageTexts,
            mode: 'relevant',
            query: text,
            maxChars: maxContextChars,
          });
          contextText = fallback.text;
          contextDescription = `${fallback.description} selected directly from the original PDF while the page index is unavailable`;
        }
      }

      if (requestTabIsActive()) setContextStatus(`Using ${contextDescription}`);
      const systemPrompt = buildContextSystemPrompt(
        contextText,
        contextDescription,
        settings.customInstructions
      );

      await requestProviderText(
        provider,
        apiMessages,
        systemPrompt,
        activeProviderConfig,
        abort.signal,
        (accumulated) => updateLastAssistantMessage(convId!, accumulated, requestTabId)
      );
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        updateLastAssistantMessage(convId, `⚠️ Error: ${err.message}`, requestTabId);
      }
    } finally {
      setIsStreaming(false, requestTabId);
      if (requestTabIsActive()) setContextStatus(null);
      clearChatRequest(requestTabId, abort);
    }
  }, [
    input,
    isStreaming,
    activeConversation,
    pageTexts,
    documentDigest,
    documentTextReady,
    settings.activeProvider,
    settings.contextMode,
    settings.maxContextChars,
    settings.maxRetrievedRanges,
    settings.customInstructions,
    activeProviderConfig,
    selectedTextForAI,
    selectedPageForAI,
    selectedEndPageForAI,
    selectedRectsForAI,
    newConversation,
    addMessage,
    updateLastAssistantMessage,
    setIsStreaming,
    clearSelectedTextForAI,
  ]);

  const stopStreaming = () => {
    const tabId = useStore.getState().activeDocumentTabId;
    if (tabId) abortChatRequest(tabId);
    setIsStreaming(false, tabId);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
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
          {/* Provider selector + conversation list */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-surface-3 flex-shrink-0">
            {/* Provider dropdown */}
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

          {/* Conversation tabs */}
          {conversations.length > 0 && (
            <div className="flex gap-1 px-3 py-1.5 border-b border-surface-3 overflow-x-auto flex-shrink-0">
              {conversations.map((conv) => {
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
                    aria-label={`Close chat: ${conv.title}`}
                    title="Close chat"
                    onClick={() => {
                      if (isActive && isStreaming) {
                        const tabId = useStore.getState().activeDocumentTabId;
                        if (tabId) abortChatRequest(tabId);
                        setIsStreaming(false, tabId);
                      }
                      deleteConversation(conv.id);
                    }}
                    className={`mx-1 rounded p-0.5 hover:bg-red-500/10 hover:text-red-400 focus:opacity-100 ${
                      isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <X size={10} />
                  </button>
                </div>
              );})}
            </div>
          )}

          {contextStatus && (
            <div className="flex-shrink-0 border-b border-surface-3 bg-accent/5 px-3 py-1.5 text-[11px] text-accent-light">
              {contextStatus}
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
            {!activeConv || activeConv.messages.length === 0 ? (
              <EmptyChat />
            ) : (
              activeConv.messages.map((msg) => <ChatBubble key={msg.id} message={msg} />)
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Input */}
          <div className="flex-shrink-0 p-3 border-t border-surface-3">
            {pdfFile && settings.contextMode === 'rawEntire' && !documentTextReady && !selectedTextForAI && (
              <div className="mb-2 rounded-lg border border-accent/20 bg-accent/5 px-2.5 py-2 text-[11px] text-accent-light">
                Extracting PDF text… {extractedPageCount} / {numPages || '…'} pages.
              </div>
            )}
            {pdfFile && settings.contextMode === 'documentAware' && !selectedTextForAI && digestStatus !== 'ready' && (
              <div className={`mb-2 rounded-lg border px-2.5 py-2 text-[11px] ${
                digestStatus === 'error'
                  ? 'border-red-500/30 bg-red-500/5 text-red-300'
                  : 'border-accent/20 bg-accent/5 text-accent-light'
              }`}>
                <div>{digestError || digestProgress || 'Preparing reusable document digest…'}</div>
                {(digestStatus === 'generating' || digestStatus === 'consolidating') && (
                  <button onClick={cancelDocumentDigest} className="mt-1 underline hover:text-text-primary">
                    Cancel digest generation
                  </button>
                )}
                {(digestStatus === 'error' || digestStatus === 'cancelled') && (
                  <button onClick={rebuildDocumentDigest} className="mt-1 underline hover:text-text-primary">
                    Build digest again
                  </button>
                )}
              </div>
            )}
            {/* Selected text context card */}
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
                placeholder={selectedTextForAI ? "Ask about this passage…" : "Ask about the document…"}
                rows={Math.min(6, Math.max(1, input.split('\n').length))}
                className="block w-full bg-surface-2 text-text-primary text-sm leading-5 rounded-xl px-4 py-3 pr-12 resize-none outline-none border border-surface-3 focus:border-accent/40 transition-colors placeholder-text-muted"
              />
              <button
                onClick={isStreaming ? stopStreaming : sendMessage}
                disabled={
                  (!input.trim() && !selectedTextForAI && !isStreaming) ||
                  (!selectedTextForAI && !documentQuestionReady && !isStreaming)
                }
                className={`absolute inset-y-0 right-2 my-auto flex h-8 w-8 items-center justify-center rounded-lg p-0 transition-colors ${
                  isStreaming
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : (input.trim() || selectedTextForAI) && (selectedTextForAI || documentQuestionReady)
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

function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);

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
    <div className={`chat-message flex items-end gap-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
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
              {message.pageEndNumber && message.pageNumber && message.pageEndNumber !== message.pageNumber
                ? `Selected passage · pages ${message.pageNumber}–${message.pageEndNumber}`
                : `Selected passage${message.pageNumber ? ` · page ${message.pageNumber}` : ''}`}
            </div>
            <div className="line-clamp-3 whitespace-pre-wrap">“{message.selectedText}”</div>
          </div>
        )}
        {message.content ? (
          <div
            className="whitespace-pre-wrap break-words"
            dangerouslySetInnerHTML={{
              __html: formatMarkdown(message.content),
            }}
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
          </div>
        )}
      </div>
      {!isUser && message.content && (
        <MessageCopyButton copied={copied} isUser={false} onClick={copyMessage} />
      )}
    </div>
  );
}

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
      <p className="text-sm text-text-secondary font-medium mb-1">Ask about your document</p>
      <p className="text-xs text-text-muted leading-relaxed">
        Select text and click "Ask AI", or type a question below. Document-aware mode reuses the
        cached digest to find and send original source page ranges.
      </p>
    </div>
  );
}

// ─── Simple markdown formatting ───

function formatMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code class="bg-surface-3 px-1 py-0.5 rounded text-accent-light text-[0.85em]">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<strong class="text-base">$1</strong>')
    .replace(/^## (.+)$/gm, '<strong class="text-lg">$1</strong>')
    .replace(/^# (.+)$/gm, '<strong class="text-xl">$1</strong>')
    .replace(/^- (.+)$/gm, '• $1');
}
