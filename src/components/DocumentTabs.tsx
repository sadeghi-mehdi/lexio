import { useEffect, useState } from 'react';
import { Database, Download, FileText, Plus, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores/useStore';
import { startEmbeddingDownload } from './DocumentIndexer';

function statusColor(status: string): string {
  if (status === 'ready') return 'bg-emerald-400';
  if (status === 'idle') return 'bg-text-muted';
  return 'bg-amber-300 animate-pulse';
}

const MEANING_STATUS: Record<string, string> = {
  unknown: 'checking…',
  unavailable: 'needs the desktop app',
  'not-installed': 'model not downloaded',
  downloading: 'downloading model',
  loading: 'loading model',
  indexing: 'preparing',
  ready: 'ready',
  error: 'error',
};

export default function DocumentTabs() {
  const {
    documentTabs,
    activeDocumentTabId,
    indexStatus,
    indexProgress,
    extractedPageCount,
    numPages,
    documentOutline,
    isStreaming,
    embeddingStatus,
    embeddingProgress,
    semanticSearch,
    switchDocumentTab,
    closeDocumentTab,
    setCurrentPage,
  } = useStore(useShallow((state) => ({
    documentTabs: state.documentTabs,
    activeDocumentTabId: state.activeDocumentTabId,
    indexStatus: state.indexStatus,
    indexProgress: state.indexProgress,
    extractedPageCount: state.extractedPageCount,
    numPages: state.numPages,
    documentOutline: state.documentOutline,
    isStreaming: state.isStreaming,
    embeddingStatus: state.embeddingStatus,
    embeddingProgress: state.embeddingProgress,
    semanticSearch: state.settings.semanticSearch,
    switchDocumentTab: state.switchDocumentTab,
    closeDocumentTab: state.closeDocumentTab,
    setCurrentPage: state.setCurrentPage,
  })));
  const [showIndex, setShowIndex] = useState(false);

  useEffect(() => setShowIndex(false), [activeDocumentTabId]);

  if (documentTabs.length === 0) return null;

  const meaning = semanticSearch
    ? `Meaning search ${embeddingProgress || MEANING_STATUS[embeddingStatus] || embeddingStatus}`
    : 'Meaning search off';
  const statusText = indexStatus === 'extracting'
    ? `Extracting text ${extractedPageCount}/${numPages || '…'}`
    : indexProgress || 'Text ready';

  return (
    <div className="relative z-30 flex h-10 flex-shrink-0 items-stretch border-b border-surface-3 bg-surface-1">
      <div className="flex min-w-0 flex-1 overflow-x-auto px-2 pt-1">
        {documentTabs.map((tab) => {
          const active = tab.id === activeDocumentTabId;
          const tabStatus = active ? indexStatus : tab.indexStatus;
          const tabIsStreaming = active ? isStreaming : tab.isStreaming;
          return (
            <div
              key={tab.id}
              className={`group mr-1 flex min-w-[150px] max-w-[240px] items-center rounded-t-lg border border-b-0 px-2 text-xs transition-colors ${
                active
                  ? 'border-surface-3 bg-surface-0 text-text-primary'
                  : 'border-transparent bg-surface-2/50 text-text-muted hover:bg-surface-2 hover:text-text-secondary'
              }`}
            >
              <button
                onClick={() => switchDocumentTab(tab.id)}
                className="flex min-w-0 flex-1 items-center gap-2 py-2 text-left"
                title={tab.pdfFile.name}
              >
                <FileText size={13} className="flex-shrink-0" />
                <span className="truncate">{tab.pdfFile.name}</span>
                {tabIsStreaming && (
                  <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-accent-light" title="AI response in progress" />
                )}
                <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${statusColor(tabStatus)}`} />
              </button>
              <button
                onClick={() => closeDocumentTab(tab.id)}
                className="ml-1 rounded p-0.5 opacity-60 hover:bg-red-500/10 hover:text-red-300 group-hover:opacity-100"
                title={`Close ${tab.pdfFile.name}`}
                aria-label={`Close ${tab.pdfFile.name}`}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          onClick={() => window.electronAPI?.openPdf()}
          className="mb-1 flex-shrink-0 rounded-md px-2 text-text-muted hover:bg-surface-2 hover:text-text-primary"
          title="Open another PDF"
          aria-label="Open another PDF"
        >
          <Plus size={15} />
        </button>
      </div>

      <button
        onClick={() => setShowIndex((value) => !value)}
        className="flex flex-shrink-0 items-center gap-2 border-l border-surface-3 px-3 text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        title={statusText}
      >
        <Database size={13} />
        <span className={`h-1.5 w-1.5 rounded-full ${statusColor(indexStatus)}`} />
        <span className="hidden max-w-[180px] truncate xl:inline">
          {indexStatus === 'extracting' ? statusText : `Text ready · ${numPages} pages`}
        </span>
      </button>

      {showIndex && (
        <div className="absolute right-2 top-[calc(100%+6px)] w-[390px] rounded-xl border border-surface-3 bg-surface-1 p-4 shadow-2xl">
          <div className="text-sm font-medium text-text-primary">Document index</div>
          <div className="mt-1 text-xs text-text-muted">{statusText}</div>
          <div className={`mt-1 text-xs ${embeddingStatus === 'error' ? 'text-red-300' : 'text-text-muted'}`}>{meaning}</div>
          {semanticSearch && embeddingStatus === 'not-installed' && (
            <button
              onClick={startEmbeddingDownload}
              className="mt-2 flex items-center gap-1.5 rounded-md border border-accent/30 px-2 py-1 text-xs text-accent-light hover:bg-accent/10"
            >
              <Download size={12} /> Download the 23 MB search model
            </button>
          )}
          {documentOutline.length > 0 ? (
            <div className="mt-3 max-h-64 space-y-0.5 overflow-y-auto">
              {documentOutline.map((entry, position) => (
                <button
                  key={`${entry.page}-${position}`}
                  onClick={() => {
                    setCurrentPage(entry.page);
                    setShowIndex(false);
                  }}
                  style={{ paddingLeft: `${0.625 + entry.depth * 0.75}rem` }}
                  className="flex w-full items-baseline justify-between gap-3 rounded-md py-1 pr-2 text-left hover:bg-surface-2"
                >
                  <span className="truncate text-xs text-text-primary">{entry.title}</span>
                  <span className="flex-shrink-0 text-[10px] text-text-muted">p.{entry.page}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 text-xs text-text-muted">This PDF has no outline.</div>
          )}
        </div>
      )}
    </div>
  );
}
