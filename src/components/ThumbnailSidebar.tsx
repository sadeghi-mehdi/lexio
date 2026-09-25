import { useRef, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores/useStore';
import { openPdfDocument, type pdfjsLib } from '../utils/pdfjs';
import { loadRegisteredDocument } from '../utils/pdf-document-registry';

const THUMBNAIL_WIDTH = 120;
const THUMBNAIL_SCALE = 0.2;

export default function ThumbnailSidebar() {
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailsRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const thumbnailItemsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const renderedPagesRef = useRef<Set<number>>(new Set());
  const renderTasksRef = useRef<Map<number, any>>(new Map());
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);

  const { activeDocumentTabId, numPages, currentPage, setCurrentPage } = useStore(useShallow((state) => ({
    activeDocumentTabId: state.activeDocumentTabId,
    numPages: state.numPages,
    currentPage: state.currentPage,
    setCurrentPage: state.setCurrentPage,
  })));

  // Reuse the document the viewer parsed for this tab instead of loading a
  // second copy of the PDF (and a second pdf.js worker).
  useEffect(() => {
    const pdfFile = useStore.getState().pdfFile;
    if (!pdfFile || !activeDocumentTabId) return;
    let cancelled = false;
    loadRegisteredDocument(activeDocumentTabId, () => openPdfDocument(pdfFile.data))
      .then((doc) => { if (!cancelled) setPdfDocument(doc); })
      .catch((error) => { if (!cancelled) console.error('Failed to load PDF thumbnails:', error); });
    return () => {
      cancelled = true;
      for (const task of renderTasksRef.current.values()) {
        try { task.cancel(); } catch {}
      }
      renderTasksRef.current.clear();
      renderedPagesRef.current.clear();
    };
  }, [activeDocumentTabId]);

  // Render a thumbnail only when it scrolls into view. Rendering all of them
  // at load flooded the pdf.js worker and slowed down the main page view.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfDocument || numPages === 0) return;

    const renderThumbnail = async (pageNum: number) => {
      const canvas = thumbnailsRef.current.get(pageNum);
      if (!canvas || renderedPagesRef.current.has(pageNum)) return;
      renderedPagesRef.current.add(pageNum);
      try {
        const page = await pdfDocument.getPage(pageNum);
        const viewport = page.getViewport({ scale: THUMBNAIL_SCALE });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const renderTask = page.render({ canvasContext: ctx, viewport });
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
    };

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void renderThumbnail(Number((entry.target as HTMLElement).dataset.page));
      }
    }, { root: container, rootMargin: '300px 0px' });
    thumbnailItemsRef.current.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, [pdfDocument, numPages]);

  // Scroll to current page thumbnail
  useEffect(() => {
    const thumbnail = thumbnailItemsRef.current.get(currentPage);
    if (containerRef.current && thumbnail) {
      thumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentPage]);

  return (
    <div
      ref={containerRef}
      className="w-36 flex-shrink-0 bg-surface-1 border-r border-surface-3 overflow-y-auto"
    >
      <div className="p-2 space-y-2">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
          <div
            key={pageNum}
            data-page={pageNum}
            ref={(el) => {
              if (el) thumbnailItemsRef.current.set(pageNum, el);
              else thumbnailItemsRef.current.delete(pageNum);
            }}
            onClick={() => setCurrentPage(pageNum)}
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
