import { useRef, useEffect, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { TextLayer } from 'pdfjs-dist';
import { useStore } from '../stores/useStore';
import SelectionActionBar from './SelectionActionBar';
import CommentModal from './CommentModal';
import type { RelativeRect, AnnotationType } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: 'rgba(255, 235, 59, 0.4)',
  green: 'rgba(76, 175, 80, 0.4)',
  blue: 'rgba(33, 150, 243, 0.4)',
  pink: 'rgba(233, 30, 99, 0.4)',
  orange: 'rgba(255, 152, 0, 0.4)',
};

// ─── Word-level bounding box ───
// Coordinates are in PAGE-LOCAL pixels (0,0 = top-left of the page).
// Computed from PDF textContent items + viewport transform — NO DOM dependency.
// This mirrors xournalpp's approach of using Poppler layout data directly.
interface WordBox {
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  midY: number;
  height: number;
}

/** Build word boxes from PDF textContent items using viewport math.
 *  Positions are in page-local CSS pixels — matches pageDiv coordinate system. */
function buildWordCache(
  textContent: { items: any[] },
  viewport: pdfjsLib.PageViewport
): WordBox[] {
  const words: WordBox[] = [];

  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;

    // item.transform = [a, b, c, d, tx, ty] in PDF page coordinates
    const tx = item.transform[4];
    const ty = item.transform[5];

    // Convert text origin from PDF coords (bottom-left) to viewport coords (top-left)
    const [vx, vy] = viewport.convertToViewportPoint(tx, ty);

    // Width in viewport pixels
    const itemWidth = item.width * viewport.scale;

    // Height: use font matrix (handles missing item.height)
    const fontScale = Math.hypot(item.transform[2], item.transform[3]);
    const rawHeight = Math.max(item.height || 0, fontScale);
    const itemHeight = rawHeight * viewport.scale;

    if (itemWidth < 0.5 || itemHeight < 0.5) continue;

    // vy = baseline y in viewport coords.
    // Text extends ~80% above baseline (ascent) and ~20% below (descent).
    const boxTop = vy - itemHeight * 0.8;
    const boxBottom = vy + itemHeight * 0.2;

    // Split into per-word boxes
    const wordMatches = [...item.str.matchAll(/\S+/g)];
    if (wordMatches.length === 0) continue;

    const totalLen = item.str.length;
    for (let i = 0; i < wordMatches.length; i++) {
      const word = wordMatches[i][0];
      const charStart = wordMatches[i].index!;
      const wLeft = vx + (charStart / totalLen) * itemWidth;
      const wRight = i < wordMatches.length - 1
        ? vx + (wordMatches[i + 1].index! / totalLen) * itemWidth
        : vx + itemWidth;

      words.push({
        text: word,
        left: wLeft, top: boxTop,
        right: wRight, bottom: boxBottom,
        midY: (boxTop + boxBottom) / 2,
        height: boxBottom - boxTop,
      });
    }
  }

  return words;
}

/** Find the nearest word box to page-local point (mx, my). Returns index or -1. */
function findNearestWord(mx: number, my: number, words: WordBox[], maxDist = 80): number {
  let bestDist = maxDist * maxDist;
  let bestIdx = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const cx = Math.max(w.left, Math.min(mx, w.right));
    const cy = Math.max(w.top, Math.min(my, w.bottom));
    const d = (cx - mx) ** 2 + (cy - my) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/** Merge consecutive selected word boxes on the same line into line rects. */
function mergeIntoLineRects(boxes: WordBox[]): { left: number; top: number; width: number; height: number }[] {
  if (boxes.length === 0) return [];
  const lines: { left: number; top: number; right: number; bottom: number }[] = [];
  let cur = { left: boxes[0].left, top: boxes[0].top, right: boxes[0].right, bottom: boxes[0].bottom };
  const curMidY = () => (cur.top + cur.bottom) / 2;

  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    const lineH = cur.bottom - cur.top;
    if (Math.abs(b.midY - curMidY()) < lineH * 0.6) {
      cur.left = Math.min(cur.left, b.left);
      cur.right = Math.max(cur.right, b.right);
      cur.top = Math.min(cur.top, b.top);
      cur.bottom = Math.max(cur.bottom, b.bottom);
    } else {
      lines.push(cur);
      cur = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    }
  }
  lines.push(cur);
  return lines.map(l => ({ left: l.left, top: l.top, width: l.right - l.left, height: l.bottom - l.top }));
}

/** Build selected text string with newlines at line breaks. */
function extractSelectedText(boxes: WordBox[]): string {
  if (boxes.length === 0) return '';
  let text = boxes[0].text;
  for (let i = 1; i < boxes.length; i++) {
    const prev = boxes[i - 1];
    const cur = boxes[i];
    const lineH = prev.bottom - prev.top;
    text += Math.abs(cur.midY - prev.midY) < lineH * 0.6 ? ' ' : '\n';
    text += cur.text;
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export default function PDFViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTasksRef = useRef<Map<number, any>>(new Map());

  // Per-page word cache + viewport dimensions (set during render)
  const wordCacheRef = useRef<Map<number, WordBox[]>>(new Map());
  const viewportSizeRef = useRef<Map<number, { width: number; height: number }>>(new Map());

  // Selection drag state (refs to avoid re-renders during drag)
  const dragRef = useRef<{
    active: boolean;
    page: number;
    startIdx: number;
  } | null>(null);

  // Live selection data
  const liveSelRef = useRef<{ page: number; text: string; startIdx: number; endIdx: number } | null>(null);

  // Overlay layer + div pool for performant rendering
  const overlayRef = useRef<{ layer: HTMLDivElement; page: number; pool: HTMLDivElement[] } | null>(null);

  const {
    pdfFile, zoom, currentPage, numPages, activeTool, activeHighlightColor,
    highlights, setNumPages, setCurrentPage, setPageText, setPdfText, setZoom,
    addHighlight, setSelectedTextForAI, setSidebarOpen, setSidebarTab,
  } = useStore();

  const [selectionInfo, setSelectionInfo] = useState<{
    text: string; rect: DOMRect; page: number; relativeRects: RelativeRect[];
  } | null>(null);

  const [commentModalInfo, setCommentModalInfo] = useState<{
    text: string; page: number; rects: RelativeRect[];
  } | null>(null);

  // ─── Coordinate conversion: page-local px → relative 0-1 ───

  const toRelativeRects = useCallback((
    lineRects: { left: number; top: number; width: number; height: number }[],
    pageNum: number
  ): RelativeRect[] => {
    const vp = viewportSizeRef.current.get(pageNum);
    if (!vp || vp.width === 0 || vp.height === 0) return [];
    return lineRects.map(r => ({
      x: r.left / vp.width,
      y: r.top / vp.height,
      width: r.width / vp.width,
      height: r.height / vp.height,
    }));
  }, []);

  // ─── Selection overlay management ───

  const removeOverlay = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.layer.remove();
      overlayRef.current = null;
    }
  }, []);

  const renderOverlay = useCallback((page: number, lineRects: { left: number; top: number; width: number; height: number }[]) => {
    const pageDiv = pagesRef.current.get(page);
    if (!pageDiv) return;

    let info = overlayRef.current;
    if (!info || info.page !== page || !pageDiv.contains(info.layer)) {
      if (info) info.layer.remove();
      const layer = document.createElement('div');
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;';
      const textLayer = pageDiv.querySelector('.textLayer');
      textLayer ? pageDiv.insertBefore(layer, textLayer) : pageDiv.appendChild(layer);
      info = { layer, page, pool: [] };
      overlayRef.current = info;
    }

    while (info.pool.length < lineRects.length) {
      const div = document.createElement('div');
      div.className = 'custom-sel-rect';
      div.style.position = 'absolute';
      info.layer.appendChild(div);
      info.pool.push(div);
    }

    for (let i = 0; i < lineRects.length; i++) {
      const r = lineRects[i];
      const div = info.pool[i];
      div.style.left = `${r.left}px`;
      div.style.top = `${r.top}px`;
      div.style.width = `${r.width}px`;
      div.style.height = `${r.height}px`;
      div.style.display = '';
    }
    for (let i = lineRects.length; i < info.pool.length; i++) {
      info.pool[i].style.display = 'none';
    }
  }, []);

  // ─── Highlight rendering ───

  const renderHighlightsForPage = useCallback((
    pageNum: number, pageDiv: HTMLDivElement, pageWidth: number, pageHeight: number
  ) => {
    pageDiv.querySelectorAll('.highlight-layer').forEach(el => el.remove());
    const pageHighlights = highlights.filter(h => h.page === pageNum);
    if (pageHighlights.length === 0) return;

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-layer';
    highlightLayer.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;';

    for (const highlight of pageHighlights) {
      for (const rect of highlight.rects) {
        const overlay = document.createElement('div');
        overlay.className = 'highlight-overlay';
        const left = rect.x * pageWidth;
        const top = rect.y * pageHeight;
        const width = rect.width * pageWidth;
        const height = rect.height * pageHeight;

        if (highlight.type === 'underline') {
          overlay.style.cssText = `position:absolute;left:${left}px;top:${top + height - 2}px;width:${width}px;height:2px;background:${HIGHLIGHT_COLORS[highlight.color].replace('0.4', '0.8')};pointer-events:none;`;
        } else if (highlight.type === 'strikeout') {
          overlay.style.cssText = `position:absolute;left:${left}px;top:${top + height / 2 - 1}px;width:${width}px;height:2px;background:${HIGHLIGHT_COLORS[highlight.color].replace('0.4', '0.8')};pointer-events:none;`;
        } else {
          overlay.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:${HIGHLIGHT_COLORS[highlight.color]};border-radius:2px;pointer-events:none;mix-blend-mode:multiply;`;
        }
        highlightLayer.appendChild(overlay);
      }
    }

    const textLayerEl = pageDiv.querySelector('.textLayer');
    textLayerEl ? pageDiv.insertBefore(highlightLayer, textLayerEl) : pageDiv.appendChild(highlightLayer);
  }, [highlights]);

  // ─── Load PDF ───

  useEffect(() => {
    if (!pdfFile) return;
    const loadPdf = async () => {
      const data = Uint8Array.from(atob(pdfFile.data), (c) => c.charCodeAt(0));
      const doc = await pdfjsLib.getDocument({
        data,
        cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
        cMapPacked: true,
      }).promise;
      pdfDocRef.current = doc;
      setNumPages(doc.numPages);
      let fullText = '';
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        setPageText(i, pageText);
        fullText += `\n--- Page ${i} ---\n${pageText}`;
      }
      setPdfText(fullText);
    };
    loadPdf();
    return () => { pdfDocRef.current?.destroy(); pdfDocRef.current = null; };
  }, [pdfFile, setNumPages, setPageText, setPdfText]);

  // ─── Render visible pages ───

  useEffect(() => {
    if (!pdfDocRef.current || numPages === 0) return;

    const renderPage = async (pageNum: number) => {
      const doc = pdfDocRef.current;
      if (!doc) return;
      const existing = renderTasksRef.current.get(pageNum);
      if (existing) { try { existing.cancel(); } catch {} }

      const page = await doc.getPage(pageNum);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: zoom });

      const pageDiv = pagesRef.current.get(pageNum);
      if (!pageDiv) return;

      wordCacheRef.current.delete(pageNum);
      pageDiv.innerHTML = '';
      pageDiv.style.width = `${viewport.width}px`;
      pageDiv.style.height = `${viewport.height}px`;

      // Store viewport dimensions for this page (used by toRelativeRects)
      viewportSizeRef.current.set(pageNum, { width: viewport.width, height: viewport.height });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width * dpr);
      canvas.height = Math.round(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      pageDiv.appendChild(canvas);

      const ctx = canvas.getContext('2d')!;
      const renderViewport = page.getViewport({ scale: zoom * dpr });
      const renderTask = page.render({ canvasContext: ctx, viewport: renderViewport });
      renderTasksRef.current.set(pageNum, renderTask);
      await renderTask.promise;

      const textContent = await page.getTextContent();
      const textLayerDiv = document.createElement('div');
      textLayerDiv.className = 'textLayer';
      textLayerDiv.dataset.page = String(pageNum);
      pageDiv.appendChild(textLayerDiv);

      const textLayer = new TextLayer({
        textContentSource: textContent,
        container: textLayerDiv,
        viewport,
      });
      await textLayer.render();

      // ─── Build word cache from PDF textContent + viewport math ───
      // This is computed purely from the PDF data and viewport transform.
      // No DOM getBoundingClientRect — immune to any layout timing or CSS issues.
      // Text items are in PDF reading order (handles multi-column correctly).
      wordCacheRef.current.set(pageNum, buildWordCache(textContent, viewport));

      renderHighlightsForPage(pageNum, pageDiv, viewport.width, viewport.height);
    };

    const start = Math.max(1, currentPage - 2);
    const end = Math.min(numPages, currentPage + 3);
    for (let i = start; i <= end; i++) renderPage(i);
  }, [pdfFile, numPages, currentPage, zoom]);

  // ─── Re-render highlights when they change ───

  useEffect(() => {
    if (!pdfDocRef.current) return;
    pagesRef.current.forEach((pageDiv, pageNum) => {
      const vp = viewportSizeRef.current.get(pageNum);
      if (vp) {
        renderHighlightsForPage(pageNum, pageDiv, vp.width, vp.height);
      }
    });
  }, [highlights, renderHighlightsForPage]);

  // ─── Scroll to current page ───

  useEffect(() => {
    const pageDiv = pagesRef.current.get(currentPage);
    if (pageDiv) pageDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [currentPage]);

  // ─── Intersection observer for page tracking ───

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const pageNum = parseInt(entry.target.getAttribute('data-page') || '1');
            setCurrentPage(pageNum);
          }
        }
      },
      { root: containerRef.current, threshold: 0.5 }
    );
    pagesRef.current.forEach((div) => observer.observe(div));
    return () => observer.disconnect();
  }, [numPages, setCurrentPage]);

  // ─── Ctrl+Scroll zoom ───

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(zoom + delta);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [zoom, setZoom]);

  // ─── Determine which page the cursor is over ───

  const getPageAtPoint = useCallback((clientX: number, clientY: number): number | null => {
    for (const [pageNum, pageDiv] of pagesRef.current) {
      const r = pageDiv.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
        return pageNum;
      }
    }
    return null;
  }, []);

  // ─── Convert client coords to page-local coords ───
  // Mouse clientX/Y → position relative to pageDiv's top-left corner.
  // This matches the word box coordinate system (both in page-local CSS pixels).

  const toPageCoords = useCallback((clientX: number, clientY: number, pageNum: number): { mx: number; my: number } | null => {
    const pageDiv = pagesRef.current.get(pageNum);
    if (!pageDiv) return null;
    const r = pageDiv.getBoundingClientRect();
    return { mx: clientX - r.left, my: clientY - r.top };
  }, []);

  // ─── Mouse handlers ───

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pageNum = getPageAtPoint(e.clientX, e.clientY);
    if (pageNum === null) {
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
      setSelectionInfo(null);
      return;
    }

    const words = wordCacheRef.current.get(pageNum);
    if (!words || words.length === 0) {
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
      setSelectionInfo(null);
      return;
    }

    const coords = toPageCoords(e.clientX, e.clientY, pageNum);
    if (!coords) return;

    const idx = findNearestWord(coords.mx, coords.my, words);
    if (idx === -1) {
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
      setSelectionInfo(null);
      return;
    }

    e.preventDefault();
    dragRef.current = { active: true, page: pageNum, startIdx: idx };
    liveSelRef.current = { page: pageNum, text: words[idx].text, startIdx: idx, endIdx: idx };

    const lineRects = mergeIntoLineRects([words[idx]]);
    renderOverlay(pageNum, lineRects);
    setSelectionInfo(null);
  }, [getPageAtPoint, toPageCoords, removeOverlay, renderOverlay]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag?.active) return;

    const words = wordCacheRef.current.get(drag.page);
    if (!words) return;

    const coords = toPageCoords(e.clientX, e.clientY, drag.page);
    if (!coords) return;

    const endIdx = findNearestWord(coords.mx, coords.my, words);
    if (endIdx === -1) return;

    const lo = Math.min(drag.startIdx, endIdx);
    const hi = Math.max(drag.startIdx, endIdx);
    const selected = words.slice(lo, hi + 1);
    const text = extractSelectedText(selected);
    const lineRects = mergeIntoLineRects(selected);

    liveSelRef.current = { page: drag.page, text, startIdx: lo, endIdx: hi };
    renderOverlay(drag.page, lineRects);
  }, [toPageCoords, renderOverlay]);

  const handleMouseUp = useCallback(() => {
    const drag = dragRef.current;
    const live = liveSelRef.current;

    if (!drag?.active || !live || !live.text.trim()) {
      if (drag) drag.active = false;
      return;
    }

    drag.active = false;

    const { page, text, startIdx, endIdx } = live;
    const words = wordCacheRef.current.get(page);
    const pageDiv = pagesRef.current.get(page);
    if (!words || !pageDiv) return;

    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    const selected = words.slice(lo, hi + 1);
    const lineRects = mergeIntoLineRects(selected);
    const relativeRects = toRelativeRects(lineRects, page);

    // Compute bounding rect in viewport coords for the action bar
    const pr = pageDiv.getBoundingClientRect();
    const viewportRects = lineRects.map(r => new DOMRect(
      pr.left + r.left, pr.top + r.top, r.width, r.height
    ));
    const boundingRect = new DOMRect(
      Math.min(...viewportRects.map(r => r.left)),
      Math.min(...viewportRects.map(r => r.top)),
      Math.max(...viewportRects.map(r => r.right)) - Math.min(...viewportRects.map(r => r.left)),
      Math.max(...viewportRects.map(r => r.bottom)) - Math.min(...viewportRects.map(r => r.top))
    );

    const annotationTools: AnnotationType[] = ['highlight', 'underline', 'strikeout'];
    if (annotationTools.includes(activeTool as AnnotationType)) {
      addHighlight({
        id: Math.random().toString(36).substring(2, 10),
        page, rects: relativeRects, text, color: activeHighlightColor,
        type: activeTool as AnnotationType, createdAt: Date.now(),
      });
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
    } else if (activeTool === 'comment') {
      setCommentModalInfo({ text, page, rects: relativeRects });
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
    } else {
      setSelectionInfo({ text, rect: boundingRect, page, relativeRects });
    }
  }, [activeTool, activeHighlightColor, addHighlight, removeOverlay, toRelativeRects]);

  // ─── Action bar callbacks ───

  const handleAskAI = useCallback(() => {
    if (!selectionInfo) return;
    setSelectedTextForAI(selectionInfo.text, selectionInfo.page, selectionInfo.relativeRects);
    setSidebarOpen(true);
    setSidebarTab('chat');
    setSelectionInfo(null);
    removeOverlay();
    liveSelRef.current = null;
  }, [selectionInfo, setSelectedTextForAI, setSidebarOpen, setSidebarTab, removeOverlay]);

  const handleHighlightSelection = useCallback((type: AnnotationType = 'highlight') => {
    if (!selectionInfo) return;
    addHighlight({
      id: Math.random().toString(36).substring(2, 10),
      page: selectionInfo.page, rects: selectionInfo.relativeRects,
      text: selectionInfo.text, color: activeHighlightColor, type, createdAt: Date.now(),
    });
    setSelectionInfo(null);
    removeOverlay();
    liveSelRef.current = null;
  }, [selectionInfo, activeHighlightColor, addHighlight, removeOverlay]);

  const handleSaveComment = useCallback((comment: string) => {
    if (!commentModalInfo) return;
    addHighlight({
      id: Math.random().toString(36).substring(2, 10),
      page: commentModalInfo.page, rects: commentModalInfo.rects,
      text: commentModalInfo.text, color: activeHighlightColor,
      type: 'highlight', comment, createdAt: Date.now(),
    });
    setCommentModalInfo(null);
  }, [commentModalInfo, activeHighlightColor, addHighlight]);

  // ─── Render ───

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto bg-surface-0 relative"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      <div className="flex flex-col items-center py-6 gap-4 min-h-full">
        {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
          <div
            key={pageNum}
            data-page={pageNum}
            ref={(el) => { if (el) pagesRef.current.set(pageNum, el); }}
            className="pdf-page-container relative bg-white"
            style={{ minHeight: 200 }}
          />
        ))}
        {numPages === 0 && pdfFile && (
          <div className="flex items-center justify-center h-full text-text-muted">
            Loading PDF…
          </div>
        )}
      </div>

      {selectionInfo && (
        <SelectionActionBar
          rect={selectionInfo.rect}
          containerRef={containerRef}
          onAskAI={handleAskAI}
          onHighlight={handleHighlightSelection}
        />
      )}

      {commentModalInfo && (
        <CommentModal
          text={commentModalInfo.text}
          onSave={handleSaveComment}
          onCancel={() => setCommentModalInfo(null)}
        />
      )}
    </div>
  );
}
