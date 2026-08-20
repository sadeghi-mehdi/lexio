import { useEffect, useCallback, useState } from 'react';
import { useStore } from './stores/useStore';
import Toolbar from './components/Toolbar';
import PDFViewer from './components/PDFViewer';
import AISidebar from './components/AISidebar';
import SettingsPanel from './components/SettingsPanel';
import WelcomeScreen from './components/WelcomeScreen';
import ThumbnailSidebar from './components/ThumbnailSidebar';
import { savePdfWithAnnotations } from './utils/pdf-save';
import { normalizeSettings } from './utils/settings-migration';
import DocumentDigestManager from './components/DocumentDigestManager';
import DocumentTabs from './components/DocumentTabs';

export default function App() {
  const {
    pdfFile,
    activeDocumentTabId,
    sidebarOpen,
    sidebarWidth,
    thumbnailSidebarOpen,
    settingsOpen,
    setPdfFile,
    updateCurrentPdfData,
    setSidebarWidth,
    hydrateSettings,
    undo,
    redo,
  } = useStore();
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

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
        undo();
      }
      // Ctrl+Shift+Z / Cmd+Shift+Z / Ctrl+Y = Redo
      if ((e.ctrlKey || e.metaKey) && ((e.key === 'z' && e.shiftKey) || e.key === 'y')) {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // Listen for electron IPC events
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.onPdfOpened((data) => {
      setPdfFile(data);
    });

    api.onToggleSidebar(() => {
      useStore.getState().toggleSidebar();
    });

    api.onZoomIn(() => useStore.getState().zoomIn());
    api.onZoomOut(() => useStore.getState().zoomOut());
    api.onZoomReset(() => useStore.getState().zoomReset());

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
    });

    // Save PDF with annotations (in place)
    api.onSavePdf(async () => {
      const state = useStore.getState();
      if (!state.pdfFile) return;

      try {
        const modifiedPdf = await savePdfWithAnnotations(
          state.pdfFile.data,
          state.highlights
        );
        const success = await api.savePdfInPlace(state.pdfFile.path, modifiedPdf);
        if (success) {
          // Update the stored PDF data
          useStore.getState().updateCurrentPdfData(modifiedPdf);
        }
      } catch (err) {
        console.error('Failed to save PDF:', err);
      }
    });

    // Save PDF as new file
    api.onSavePdfAs(async () => {
      const state = useStore.getState();
      if (!state.pdfFile) return;

      try {
        const modifiedPdf = await savePdfWithAnnotations(
          state.pdfFile.data,
          state.highlights
        );
        const savedPath = await api.savePdf(
          state.pdfFile.name.replace('.pdf', '-annotated.pdf'),
          modifiedPdf
        );
        if (savedPath) {
          console.log('PDF saved to:', savedPath);
        }
      } catch (err) {
        console.error('Failed to save PDF:', err);
      }
    });

    // Undo/Redo from menu
    api.onUndo(() => useStore.getState().undo());
    api.onRedo(() => useStore.getState().redo());
    api.onCopySelection(() => {
      const active = document.activeElement as HTMLElement | null;
      const nativeSelection = window.getSelection()?.toString() || '';
      if (active?.matches('input, textarea, [contenteditable="true"]') || nativeSelection) {
        document.execCommand('copy');
        return;
      }
      window.dispatchEvent(new Event('lexio:copy-selection'));
    });
    api.onFind(() => {
      if (useStore.getState().pdfFile) {
        window.dispatchEvent(new Event('lexio:find'));
      }
    });

    // Load saved settings
    api.loadSettings().then((settings) => {
      if (!settings) return;
      const normalized = normalizeSettings(settings);
      hydrateSettings(normalized);
      api.saveSettings(normalized);
    });
  }, [hydrateSettings, setPdfFile, updateCurrentPdfData]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const handleMouseMove = (event: MouseEvent) => {
      const viewportMaximum = Math.max(320, window.innerWidth - 360);
      setSidebarWidth(Math.min(viewportMaximum, window.innerWidth - event.clientX));
    };
    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
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
  }, [isResizingSidebar, setSidebarWidth]);

  // Handle file drop
  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.type === 'application/pdf') {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          setPdfFile({
            path: (file as File & { path?: string }).path || file.name,
            name: file.name,
            data: base64,
          });
        };
        reader.readAsDataURL(file);
      }
    },
    [setPdfFile]
  );

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
        {pdfFile && thumbnailSidebarOpen && (
          <ThumbnailSidebar key={`thumbnails-${activeDocumentTabId}`} />
        )}

        {/* PDF Viewer */}
        <div className="flex-1 overflow-hidden relative">
          {pdfFile ? <PDFViewer key={`viewer-${activeDocumentTabId}`} /> : <WelcomeScreen />}
        </div>

        {/* AI Sidebar (right) */}
        {sidebarOpen && (
          <div
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
              onDoubleClick={() => setSidebarWidth(700)}
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
      <DocumentDigestManager />
    </div>
  );
}
