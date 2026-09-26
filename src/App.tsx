import { useEffect, useCallback, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from './stores/useStore';
import Toolbar from './components/Toolbar';
import PDFViewer from './components/PDFViewer';
import AISidebar from './components/AISidebar';
import SettingsPanel from './components/SettingsPanel';
import WelcomeScreen from './components/WelcomeScreen';
import ThumbnailSidebar from './components/ThumbnailSidebar';
import { annotatedPdfBytes, readPdfFile, savePdfCopy } from './utils/pdf-save';
import { normalizeSettings } from './utils/settings-migration';
import DocumentIndexer from './components/DocumentIndexer';
import DocumentTabs from './components/DocumentTabs';

export default function App() {
  // Subscribe only to the fields this component renders. A bare useStore()
  // would re-render the whole app on every streamed token.
  const {
    hasPdf,
    activeDocumentTabId,
    sidebarOpen,
    sidebarWidth,
    thumbnailSidebarOpen,
    settingsOpen,
  } = useStore(useShallow((state) => ({
    hasPdf: Boolean(state.pdfFile),
    activeDocumentTabId: state.activeDocumentTabId,
    sidebarOpen: state.sidebarOpen,
    sidebarWidth: state.sidebarWidth,
    thumbnailSidebarOpen: state.thumbnailSidebarOpen,
    settingsOpen: state.settingsOpen,
  })));
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);

  // Global keyboard shortcuts for undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (useStore.getState().pdfFile) {
          e.preventDefault();
          window.dispatchEvent(new Event('lexio:find'));
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
        const state = useStore.getState();
        if (state.documentTabs.length > 1 && state.activeDocumentTabId) {
          e.preventDefault();
          const currentIndex = state.documentTabs.findIndex((tab) => tab.id === state.activeDocumentTabId);
          const direction = e.shiftKey ? -1 : 1;
          const nextIndex = (currentIndex + direction + state.documentTabs.length) % state.documentTabs.length;
          state.switchDocumentTab(state.documentTabs[nextIndex].id);
        }
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
        const state = useStore.getState();
        if (state.activeDocumentTabId) {
          e.preventDefault();
          state.closeDocumentTab(state.activeDocumentTabId);
        }
        return;
      }
      // Check if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Ctrl+Z / Cmd+Z = Undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useStore.getState().undo();
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y = Redo
      if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        useStore.getState().redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for electron IPC events
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const unsubscribers = [
      api.onPdfOpened((data) => useStore.getState().setPdfFile(data)),
      api.onToggleSidebar(() => useStore.getState().toggleSidebar()),
      api.onZoomIn(() => useStore.getState().zoomIn()),
      api.onZoomOut(() => useStore.getState().zoomOut()),
      api.onZoomReset(() => useStore.getState().zoomReset()),

      api.onExportAnnotations(async () => {
        const state = useStore.getState();
        const exportData = {
          file: state.pdfFile?.name,
          exportedAt: new Date().toISOString(),
          highlights: state.highlights.map((h) => ({
            page: h.page,
            type: h.type,
            text: h.text,
            color: h.color,
            comment: h.comment,
          })),
          annotations: state.annotations,
        };
        await api.saveFile(
          `${state.pdfFile?.name || 'document'}-annotations.json`,
          JSON.stringify(exportData, null, 2)
        );
      }),

      // Save PDF with annotations in place. The store keeps the bytes the file
      // was opened with, so repeated saves redraw from the original instead of
      // stacking highlights on top of an already-annotated copy.
      api.onSavePdf(async () => {
        const state = useStore.getState();
        if (!state.pdfFile) return;
        try {
          if (!state.pdfFile.canSaveInPlace) {
            await savePdfCopy(state.pdfFile, state.highlights, state.settings);
            return;
          }
          const modifiedPdf = await annotatedPdfBytes(state.pdfFile, state.highlights, state.settings);
          if (modifiedPdf && !(await api.savePdfInPlace(state.pdfFile.id, modifiedPdf))) {
            console.error('Failed to save PDF in place.');
          }
        } catch (err) {
          console.error('Failed to save PDF:', err);
        }
      }),

      api.onSavePdfAs(async () => {
        const state = useStore.getState();
        if (!state.pdfFile) return;
        try {
          await savePdfCopy(state.pdfFile, state.highlights, state.settings);
        } catch (err) {
          console.error('Failed to save PDF:', err);
        }
      }),

      // Undo/Redo from menu
      api.onUndo(() => useStore.getState().undo()),
      api.onRedo(() => useStore.getState().redo()),
      api.onCopySelection(() => {
        const active = document.activeElement as HTMLElement | null;
        const nativeSelection = window.getSelection()?.toString() || '';
        if (active?.matches('input, textarea, [contenteditable="true"]') || nativeSelection) {
          document.execCommand('copy');
          return;
        }
        window.dispatchEvent(new Event('lexio:copy-selection'));
      }),
      api.onFind(() => {
        if (useStore.getState().pdfFile) {
          window.dispatchEvent(new Event('lexio:find'));
        }
      }),
    ];

    // Load saved settings
    let disposed = false;
    api.loadSettings().then((settings) => {
      if (!settings || disposed) return;
      const normalized = normalizeSettings(settings);
      useStore.getState().hydrateSettings(normalized);
      api.saveSettings(normalized);
    });

    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  // While dragging, the width is written straight to the DOM so no React
  // component re-renders per mouse move. The store and settings are updated
  // once on mouseup.
  useEffect(() => {
    if (!isResizingSidebar) return;
    let width = useStore.getState().sidebarWidth;

    const handleMouseMove = (event: MouseEvent) => {
      const viewportMaximum = Math.max(320, window.innerWidth - 360);
      width = Math.max(320, Math.min(1200, viewportMaximum, window.innerWidth - event.clientX));
      if (sidebarRef.current) sidebarRef.current.style.width = `${width}px`;
    };
    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      useStore.getState().setSidebarWidth(width);
      window.electronAPI?.saveSettings(useStore.getState().settings);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizingSidebar]);

  // Handle file drop. In Electron the preload resolves the real path so the
  // file can be saved in place; otherwise it opens as a read-only copy.
  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !(file.type === 'application/pdf' || /\.pdf$/i.test(file.name))) return;
    try {
      const opened = (await window.electronAPI?.openDroppedPdf(file)) || (await readPdfFile(file));
      useStore.getState().setPdfFile(opened);
    } catch (error) {
      console.error('Failed to open dropped PDF:', error);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  return (
    <div
      className="h-screen w-screen flex flex-col bg-surface-0 overflow-hidden"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Unified toolbar with integrated title bar */}
      <Toolbar />
      <DocumentTabs />

      <div className={`flex flex-1 overflow-hidden ${isResizingSidebar ? 'select-none' : ''}`}>
        {/* Thumbnail Sidebar (left) */}
        {hasPdf && thumbnailSidebarOpen && (
          <ThumbnailSidebar key={`thumbnails-${activeDocumentTabId}`} />
        )}

        {/* PDF Viewer */}
        <div className="flex-1 overflow-hidden relative">
          {hasPdf ? <PDFViewer key={`viewer-${activeDocumentTabId}`} /> : <WelcomeScreen />}
        </div>

        {/* AI Sidebar (right) */}
        {sidebarOpen && (
          <div
            ref={sidebarRef}
            className="relative flex-shrink-0 border-l border-surface-3 overflow-visible"
            style={{ width: sidebarWidth }}
          >
            <div
              role="separator"
              aria-label="Resize AI sidebar"
              aria-orientation="vertical"
              aria-valuemin={320}
              aria-valuemax={1200}
              aria-valuenow={sidebarWidth}
              onMouseDown={(event) => {
                event.preventDefault();
                setIsResizingSidebar(true);
              }}
              onDoubleClick={() => useStore.getState().setSidebarWidth(700)}
              className="absolute -left-1 top-0 bottom-0 z-30 w-2 cursor-col-resize group"
              title="Drag to resize; double-click to reset"
            >
              <div className={`mx-auto h-full w-px transition-colors ${
                isResizingSidebar ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/70'
              }`} />
            </div>
            <div className="h-full overflow-hidden">
              <AISidebar />
            </div>
          </div>
        )}
      </div>

      {/* Settings Modal */}
      {settingsOpen && <SettingsPanel />}
      <DocumentIndexer />
    </div>
  );
}
