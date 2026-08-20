import { useRef, useEffect, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { useStore } from '../stores/useStore';

const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_SCALE = 0.2;

export default function ThumbnailSidebar() {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const thumbnailItemsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const renderTasksRef = useRef<Map<number, any>>(new Map());
  const loadGenerationRef = useRef(0);

  const { pdfFile, numPages, currentPage, setCurrentPage } = useStore();

  // Load PDF document
  useEffect(() => {
    if (!pdfFile) return;
    const generation = ++loadGenerationRef.current;
    let loadedDocument: pdfjsLib.PDFDocumentProxy | null = null;

    const loadPdf = async () => {
      const data = Uint8Array.from(atob(pdfFile.data), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({ data }).promise;
      loadedDocument = doc;
      if (generation !== loadGenerationRef.current) {
        await doc.destroy();
        return;
      }
      pdfDocRef.current = doc;
      renderedPagesRef.current.clear();

      // Trigger re-render of visible thumbnails
      renderVisibleThumbnails();
    };

    void loadPdf().catch((error) => {
      if (generation === loadGenerationRef.current) {
        console.error('Failed to load PDF thumbnails:', error);
      }
    });

    return () => {
      loadGenerationRef.current++;
      for (const task of renderTasksRef.current.values()) {
        try { task.cancel(); } catch {}
      }
      renderTasksRef.current.clear();
      if (pdfDocRef.current === loadedDocument) pdfDocRef.current = null;
      void loadedDocument?.destroy();
    };
  }, [pdfFile]);

  // Render a single thumbnail
  const renderThumbnail = useCallback(async (pageNum: number) => {
    const doc = pdfDocRef.current;
    const canvas = thumbnailsRef.current.get(pageNum);
    if (!doc || !canvas || renderedPagesRef.current.has(pageNum)) return;

    renderedPagesRef.current.add(pageNum);

    try {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: THUMBNAIL_SCALE });

      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const renderTask = page.render({
        canvasContext: ctx,
        viewport,
      });
      renderTasksRef.current.set(pageNum, renderTask);
      await renderTask.promise;
    } catch (error: any) {
      renderedPagesRef.current.delete(pageNum);
      if (error?.name !== 'RenderingCancelledException') {
        console.error(`Failed to render thumbnail ${pageNum}:`, error);
      }
    } finally {
      renderTasksRef.current.delete(pageNum);
    }
  }, []);

  // Render visible thumbnails using IntersectionObserver
  const renderVisibleThumbnails = useCallback(() => {
    if (!pdfDocRef.current) return;

    thumbnailsRef.current.forEach((_, pageNum) => {
      renderThumbnail(pageNum);
    });
  }, [renderThumbnail]);

  // Re-render when numPages changes
  useEffect(() => {
    if (numPages > 0 && pdfDocRef.current) {
      // Small delay to ensure canvases are mounted
      setTimeout(renderVisibleThumbnails, 100);
    }
  }, [numPages, renderVisibleThumbnails]);

  // Scroll to current page thumbnail
  useEffect(() => {
    const thumbnail = thumbnailItemsRef.current.get(currentPage);
    if (containerRef.current && thumbnail) {
      thumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentPage]);

  const handleThumbnailClick = (pageNum: number) => {
    setCurrentPage(pageNum);
  };

  return (
    <div
      ref={containerRef}
      className="w-36 flex-shrink-0 bg-surface-1 border-r border-surface-3 overflow-y-auto"
    >
      <div className="p-2 space-y-2">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
          <div
            key={pageNum}
            ref={(el) => {
              if (el) thumbnailItemsRef.current.set(pageNum, el);
              else thumbnailItemsRef.current.delete(pageNum);
            }}
            onClick={() => handleThumbnailClick(pageNum)}
            className={`cursor-pointer rounded-lg overflow-hidden transition-all ${
              pageNum === currentPage
                ? 'ring-2 ring-accent shadow-lg'
                : 'hover:ring-1 hover:ring-surface-4 opacity-70 hover:opacity-100'
            }`}
          >
            <div className="bg-white relative">
              <canvas
                ref={(el) => {
                  if (el) thumbnailsRef.current.set(pageNum, el);
                  else thumbnailsRef.current.delete(pageNum);
                }}
                className="w-full h-auto"
                style={{ maxWidth: THUMBNAIL_WIDTH }}
              />
            </div>
            <div className="text-center text-xs text-text-secondary py-1 bg-surface-2">
              {pageNum}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
