import { useEffect, useState } from 'react';
import { Database, FileText, Plus, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { useStore } from '../stores/useStore';
import { deleteCachedDigest } from '../utils/document-digest';

function statusColor(status: string): string {
  if (status === 'ready') return 'bg-emerald-400';
  if (status === 'error') return 'bg-red-400';
  if (status === 'cancelled' || status === 'idle') return 'bg-text-muted';
  return 'bg-amber-300 animate-pulse';
}

export default function DocumentTabs() {
  const {
    documentTabs,
    activeDocumentTabId,
    digestStatus,
    digestProgress,
    digestError,
    documentDigest,
    documentFingerprint,
    extractedPageCount,
    numPages,
    isStreaming,
    switchDocumentTab,
    closeDocumentTab,
    rebuildDocumentDigest,
    cancelDocumentDigest,
    setDocumentDigest,
    setDigestState,
    setCurrentPage,
  } = useStore();
  const [showIndex, setShowIndex] = useState(false);

  useEffect(() => setShowIndex(false), [activeDocumentTabId]);

  if (documentTabs.length === 0) return null;

  const statusText = digestError || digestProgress || digestStatus;

  return (
    <div className="relative z-30 flex h-10 flex-shrink-0 items-stretch border-b border-surface-3 bg-surface-1">
      <div className="flex min-w-0 flex-1 overflow-x-auto px-2 pt-1">
        {documentTabs.map((tab) => {
          const active = tab.id === activeDocumentTabId;
          const tabStatus = active ? digestStatus : tab.digestStatus;
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
        <span className={`h-1.5 w-1.5 rounded-full ${statusColor(digestStatus)}`} />
        <span className="hidden max-w-[180px] truncate xl:inline">
          {digestStatus === 'ready'
            ? `Index ready · ${documentDigest?.pages.length || numPages} pages`
            : digestStatus === 'extracting'
              ? `Extracting ${extractedPageCount}/${numPages || '…'}`
              : statusText}
        </span>
      </button>

      {showIndex && (
        <div className="absolute right-2 top-[calc(100%+6px)] w-[390px] rounded-xl border border-surface-3 bg-surface-1 p-4 shadow-2xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-text-primary">Document page index</div>
              <div className={`mt-1 text-xs ${digestStatus === 'error' ? 'text-red-300' : 'text-text-muted'}`}>
                {statusText}
              </div>
            </div>
            <div className="flex gap-1">
              {(digestStatus === 'generating' || digestStatus === 'consolidating') && (
                <button onClick={cancelDocumentDigest} className="rounded-md p-1.5 text-text-secondary hover:bg-surface-3" title="Cancel indexing">
                  <Square size={14} />
                </button>
              )}
              <button onClick={rebuildDocumentDigest} className="rounded-md p-1.5 text-text-secondary hover:bg-surface-3" title="Rebuild page index">
                <RefreshCw size={14} />
              </button>
              <button
                onClick={async () => {
                  if (documentFingerprint) await deleteCachedDigest(documentFingerprint);
                  setDocumentDigest(null);
                  setDigestState('idle', 'Cached page index deleted');
                }}
                className="rounded-md p-1.5 text-text-secondary hover:bg-red-500/10 hover:text-red-300"
                title="Delete cached page index"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>

          {documentDigest && (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-text-muted">
                <div className="rounded-lg bg-surface-2 px-2.5 py-2">Pages indexed<br /><span className="text-text-primary">{documentDigest.pages.length}</span></div>
                <div className="rounded-lg bg-surface-2 px-2.5 py-2">Index model<br /><span className="break-all text-text-primary">{documentDigest.model}</span></div>
              </div>
              <p className="mt-3 max-h-20 overflow-y-auto text-xs leading-relaxed text-text-secondary">
                {documentDigest.overview}
              </p>
              <div className="mt-3 max-h-52 space-y-1.5 overflow-y-auto">
                {documentDigest.sections.map((section) => (
                  <button
                    key={section.id}
                    onClick={() => {
                      setCurrentPage(section.startPage);
                      setShowIndex(false);
                    }}
                    className="w-full rounded-lg border border-surface-3 px-2.5 py-2 text-left hover:bg-surface-2"
                  >
                    <div className="truncate text-xs text-text-primary">{section.title}</div>
                    <div className="text-[10px] text-text-muted">Pages {section.startPage}{section.endPage !== section.startPage ? `–${section.endPage}` : ''}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
