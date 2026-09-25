import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useStore } from '../stores/useStore';
import { openPdfDocument, pdfjsLib } from '../utils/pdfjs';
import { loadRegisteredDocument } from '../utils/pdf-document-registry';
import SelectionActionBar from './SelectionActionBar';
import CommentModal from './CommentModal';
import type { AnnotationType, RelativeRect } from '../types';
import { hasExceededDragThreshold } from '../utils/selection-gesture';
import { copyText } from '../utils/clipboard';
import { findNearestVisiblePage } from '../utils/page-visibility';
import { findDocumentMatches, type DocumentSearchMatch } from '../utils/document-search';

// Rendered canvases are kept only for pages within this distance of the
// current page. An A4 canvas at 2x DPR is about 8 MB, so keeping every page a
// reader scrolls past would grow memory without bound.
const KEEP_RENDERED_DISTANCE = 5;
// File annotations that Lexio lists and may hide from pdf.js rendering.
const HIDEABLE_SUBTYPES = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Text', 'FreeText']);
const SEARCH_DEBOUNCE_MS = 150;
const WHEEL_ZOOM_SETTLE_MS = 150;

type PageSize = { width: number; height: number };
type TextContent = Awaited<ReturnType<pdfjsLib.PDFPageProxy['getTextContent']>>;

// Page sizes per parsed document. Documents live across tab switches (see
// pdf-document-registry), so switching back to a tab reuses its sizes.
const pageSizeCache = new WeakMap<pdfjsLib.PDFDocumentProxy, Map<number, PageSize>>();

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: 'rgba(255, 235, 59, 0.4)',
  green: 'rgba(76, 175, 80, 0.4)',
  blue: 'rgba(33, 150, 243, 0.4)',
  pink: 'rgba(233, 30, 99, 0.4)',
  orange: 'rgba(255, 152, 0, 0.4)',
};

// ─── Character-level bounding box ───
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
  startsItem: boolean;
  hasEOL: boolean;
}

interface SelectionPoint {
  page: number;
  index: number;
}

interface SelectionSegment {
  page: number;
  boxes: WordBox[];
  text: string;
  lineRects: { left: number; top: number; width: number; height: number }[];
}

interface PageSelection {
  page: number;
  text: string;
  rects: RelativeRect[];
}

const annotationId = () => Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

/** Build character boxes from PDF textContent items using viewport math.
 *  Positions are in page-local CSS pixels — matches pageDiv coordinate system. */
function buildWordCache(
  textContent: { items: any[] },
  viewport: pdfjsLib.PageViewport
): WordBox[] {
  const words: WordBox[] = [];

  for (const item of textContent.items) {
    if (typeof item.str !== 'string' || item.str.length === 0) continue;

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

    // PDF.js exposes item-level geometry. Divide it into Unicode character
    // cells so dragging starts and ends at characters instead of whole words.
    const characters = Array.from(item.str as string);
    if (characters.length === 0) continue;

    for (let i = 0; i < characters.length; i++) {
      const wLeft = vx + (i / characters.length) * itemWidth;
      const wRight = vx + ((i + 1) / characters.length) * itemWidth;

      words.push({
        text: characters[i],
        left: wLeft, top: boxTop,
        right: wRight, bottom: boxBottom,
        midY: (boxTop + boxBottom) / 2,
        height: boxBottom - boxTop,
        startsItem: i === 0,
        hasEOL: Boolean(item.hasEOL) && i === characters.length - 1,
      });
    }
  }

  return words;
}

/** Find the nearest character box to page-local point (mx, my). Returns index or -1. */
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

/** Merge consecutive selected character boxes on the same line into line rects. */
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

/** Reconstruct selected text without inserting spaces between characters. */
function extractSelectedText(boxes: WordBox[]): string {
  if (boxes.length === 0) return '';
  let text = boxes[0].text;
  for (let i = 1; i < boxes.length; i++) {
    const prev = boxes[i - 1];
    const cur = boxes[i];
    const lineH = prev.bottom - prev.top;
    const sameLine = Math.abs(cur.midY - prev.midY) < lineH * 0.6;
    if (!sameLine || prev.hasEOL) {
      text += '\n';
    } else if (
      cur.startsItem &&
      !/\s$/.test(prev.text) &&
      !/^\s/.test(cur.text) &&
      cur.left - prev.right > Math.max(1, lineH * 0.12)
    ) {
      text += ' ';
    }
    text += cur.text;
  }
  return text;
}

/** Build a document-order selection between two character positions, spanning pages as needed. */
function buildSelectionSegments(
  wordCache: ReadonlyMap<number, WordBox[]>,
  start: SelectionPoint,
  end: SelectionPoint
): SelectionSegment[] {
  const forward = start.page < end.page || (start.page === end.page && start.index <= end.index);
  const first = forward ? start : end;
  const last = forward ? end : start;
  const segments: SelectionSegment[] = [];

  for (let page = first.page; page <= last.page; page++) {
    const words = wordCache.get(page);
    if (!words || words.length === 0) continue;

    const from = page === first.page ? first.index : 0;
    const to = page === last.page ? last.index : words.length - 1;
    const boxes = words.slice(Math.max(0, from), Math.min(words.length - 1, to) + 1);
    if (boxes.length === 0) continue;

    segments.push({
      page,
      boxes,
      text: extractSelectedText(boxes),
      lineRects: mergeIntoLineRects(boxes),
    });
  }

  return segments;
}

// ═══════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════

export default function PDFViewer() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const renderTasksRef = useRef<Map<number, any>>(new Map());
  const renderedPagesRef = useRef<Map<number, string>>(new Map());
  const observerPageUpdateRef = useRef(false);
  const positionedLayoutRef = useRef('');
  const scrolledPageRef = useRef(0);

  // Per-page word cache + viewport dimensions (set during render)
  const wordCacheRef = useRef<Map<number, WordBox[]>>(new Map());
  const viewportSizeRef = useRef<Map<number, { width: number; height: number }>>(new Map());

  // Selection drag state (refs to avoid re-renders during drag)
  const dragRef = useRef<{
    active: boolean;
    started: boolean;
    start: SelectionPoint;
    originX: number;
    originY: number;
  } | null>(null);

  // Live selection data
  const liveSelRef = useRef<{
    start: SelectionPoint;
    end: SelectionPoint;
    text: string;
    segments: SelectionSegment[];
  } | null>(null);

  // Overlay layer + div pool for performant rendering
  const overlayRef = useRef<Map<number, { layer: HTMLDivElement; pool: HTMLDivElement[] }>>(new Map());
  const searchOverlayRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pagesWrapperRef = useRef<HTMLDivElement>(null);
  const textContentCacheRef = useRef<Map<number, Promise<TextContent>>>(new Map());
  const intersectingPagesRef = useRef<Set<number>>(new Set());
  const activeSearchMatchRef = useRef<DocumentSearchMatch | null>(null);

  const {
    hasPdf, activeDocumentTabId, documentSessionId, zoom, currentPage, numPages, pageTexts,
    highlights, activeTool, activeHighlightColor,
    setNumPages, setCurrentPage, addHighlight,
    setSelectedTextForAI, clearSelectedTextForAI,
    setSidebarOpen, setSidebarTab,
  } = useStore(useShallow((state) => ({
    hasPdf: Boolean(state.pdfFile),
    activeDocumentTabId: state.activeDocumentTabId,
    documentSessionId: state.documentSessionId,
    zoom: state.zoom,
    currentPage: state.currentPage,
    numPages: state.numPages,
    pageTexts: state.pageTexts,
    highlights: state.highlights,
    activeTool: state.activeTool,
    activeHighlightColor: state.activeHighlightColor,
    setNumPages: state.setNumPages,
    setCurrentPage: state.setCurrentPage,
    addHighlight: state.addHighlight,
    setSelectedTextForAI: state.setSelectedTextForAI,
    clearSelectedTextForAI: state.clearSelectedTextForAI,
    setSidebarOpen: state.setSidebarOpen,
    setSidebarTab: state.setSidebarTab,
  })));

  const [selectionInfo, setSelectionInfo] = useState<{
    text: string;
    rect: DOMRect;
    page: number;
    endPage: number;
    relativeRects: RelativeRect[];
    pageSelections: PageSelection[];
  } | null>(null);
  const [commentModalInfo, setCommentModalInfo] = useState<{
    text: string;
    pageSelections: PageSelection[];
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Matching runs over the whole document, so it waits until typing pauses.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageBaseSizes, setPageBaseSizes] = useState<Map<number, PageSize>>(
    () => new Map()
  );
  const searchMatches = useMemo(
    () => findDocumentMatches(pageTexts, debouncedQuery),
    [pageTexts, debouncedQuery]
  );
  const activeSearchMatch = searchMatches[searchMatchIndex] ?? null;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  // One text-content request per page, shared by extraction and rendering.
  // Entries are dropped for pages far from the viewport to bound memory.
  const loadTextContent = useCallback((page: pdfjsLib.PDFPageProxy): Promise<TextContent> => {
    let entry = textContentCacheRef.current.get(page.pageNumber);
    if (!entry) {
      entry = page.getTextContent();
      textContentCacheRef.current.set(page.pageNumber, entry);
    }
    return entry;
  }, []);

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
    overlayRef.current.forEach(({ layer }) => layer.remove());
    overlayRef.current.clear();
  }, []);

  const renderPageOverlay = useCallback((page: number, lineRects: { left: number; top: number; width: number; height: number }[]) => {
    const pageDiv = pagesRef.current.get(page);
    if (!pageDiv) return;

    let info = overlayRef.current.get(page);
    if (!info || !pageDiv.contains(info.layer)) {
      info?.layer.remove();
      const layer = document.createElement('div');
      layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:3;';
      const textLayer = pageDiv.querySelector('.textLayer');
      textLayer ? pageDiv.insertBefore(layer, textLayer) : pageDiv.appendChild(layer);
      info = { layer, pool: [] };
      overlayRef.current.set(page, info);
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

  const renderSelectionOverlays = useCallback((segments: SelectionSegment[]) => {
    const selectedPages = new Set(segments.map((segment) => segment.page));
    overlayRef.current.forEach((info, page) => {
      if (!selectedPages.has(page)) {
        info.layer.remove();
        overlayRef.current.delete(page);
      }
    });
    for (const segment of segments) {
      renderPageOverlay(segment.page, segment.lineRects);
    }
  }, [renderPageOverlay]);

  const clearSearchOverlays = useCallback(() => {
    searchOverlayRef.current.forEach((layer) => layer.remove());
    searchOverlayRef.current.clear();
  }, []);

  const renderSearchHighlightsForPage = useCallback((pageNum: number) => {
    searchOverlayRef.current.get(pageNum)?.remove();
    searchOverlayRef.current.delete(pageNum);
    const query = debouncedQuery.trim().toLocaleLowerCase();
    const pageDiv = pagesRef.current.get(pageNum);
    const boxes = wordCacheRef.current.get(pageNum);
    if (!query || !pageDiv || !boxes || boxes.length === 0) return;

    const pageText = boxes.map((box) => box.text).join('').toLocaleLowerCase();
    const matches: Array<{
      occurrence: number;
      rects: Array<{ left: number; top: number; width: number; height: number }>;
    }> = [];
    let offset = 0;
    let occurrence = 0;
    while (offset <= pageText.length - query.length) {
      const index = pageText.indexOf(query, offset);
      if (index < 0) break;
      matches.push({
        occurrence,
        rects: mergeIntoLineRects(boxes.slice(index, index + query.length)),
      });
      occurrence += 1;
      offset = index + Math.max(1, query.length);
    }
    if (matches.length === 0) return;

    // Markers are styled by CSS (.search-hit). Moving between matches only
    // flips data-search-active on a few markers instead of rebuilding layers.
    const active = activeSearchMatchRef.current;
    const layer = document.createElement('div');
    layer.className = 'search-highlight-layer';
    layer.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;';
    for (const match of matches) {
      const isActive = active?.page === pageNum && active.occurrence === match.occurrence;
      for (const [rectIndex, rect] of match.rects.entries()) {
        const marker = document.createElement('div');
        marker.className = 'search-hit';
        marker.dataset.searchOccurrence = String(match.occurrence);
        marker.dataset.searchActive = isActive ? 'true' : 'false';
        marker.dataset.searchPrimary = rectIndex === 0 ? 'true' : 'false';
        marker.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
        layer.appendChild(marker);
      }
    }
    pageDiv.appendChild(layer);
    searchOverlayRef.current.set(pageNum, layer);
  }, [debouncedQuery]);

  // ─── Highlight rendering ───

  const renderHighlightsForPage = useCallback((
    pageNum: number, pageDiv: HTMLDivElement, pageWidth: number, pageHeight: number
  ) => {
    pageDiv.querySelectorAll('.highlight-layer').forEach(el => el.remove());
    // Notes (sticky notes, text boxes) have no marked text; pdf.js draws them.
    const pageHighlights = highlights.filter(h => h.page === pageNum && h.type !== 'note');
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

  useEffect(() => {
    for (const task of renderTasksRef.current.values()) {
      try { task.cancel(); } catch {}
    }
    renderTasksRef.current.clear();
    renderedPagesRef.current.clear();
    wordCacheRef.current.clear();
    viewportSizeRef.current.clear();
    textContentCacheRef.current.clear();
    intersectingPagesRef.current.clear();
    pagesRef.current.forEach((pageDiv) => { pageDiv.innerHTML = ''; });
    observerPageUpdateRef.current = false;
    positionedLayoutRef.current = '';
    removeOverlay();
    clearSearchOverlays();
    setSelectionInfo(null);
    dragRef.current = null;
    liveSelRef.current = null;
  }, [documentSessionId, removeOverlay, clearSearchOverlays]);

  // ─── Load PDF ───

  useEffect(() => {
    const pdfFile = useStore.getState().pdfFile;
    if (!pdfFile || !activeDocumentTabId) return;
    const viewerTabId = activeDocumentTabId;
    const viewerIsActive = () => useStore.getState().activeDocumentTabId === viewerTabId;
    let cancelled = false;
    const stillCurrent = () => !cancelled && viewerIsActive();

    const loadPdf = async () => {
      // The parsed document is shared with the thumbnail sidebar and survives
      // tab switches, so switching back to a tab does not parse the file again.
      const doc = await loadRegisteredDocument(viewerTabId, () => openPdfDocument(pdfFile.data));
      if (!stillCurrent()) return;

      // Show the page column right away. Until real sizes are known, every
      // page uses the first page's size; odd-sized pages are corrected below.
      let sizes = pageSizeCache.get(doc);
      const sizesKnown = Boolean(sizes);
      if (!sizes) {
        const firstViewport = (await doc.getPage(1)).getViewport({ scale: 1 });
        if (!stillCurrent()) return;
        sizes = new Map();
        for (let i = 1; i <= doc.numPages; i++) {
          sizes.set(i, { width: firstViewport.width, height: firstViewport.height });
        }
      }

      pdfDocRef.current = doc;
      setPageBaseSizes(sizes);
      setPdfDocument(doc);
      setNumPages(doc.numPages);
      if (sizesKnown) return;

      // One background pass reads each page's real size. Text is extracted
      // separately for every open tab by DocumentIndexer.
      const actualSizes = new Map(sizes);
      let sizesChanged = false;
      for (let i = 1; i <= doc.numPages; i++) {
        if (!stillCurrent()) return;
        const page = await doc.getPage(i);
        const viewport = page.getViewport({ scale: 1 });
        const assumed = actualSizes.get(i);
        if (!assumed || assumed.width !== viewport.width || assumed.height !== viewport.height) {
          actualSizes.set(i, { width: viewport.width, height: viewport.height });
          sizesChanged = true;
        }
      }
      if (!stillCurrent()) return;
      pageSizeCache.set(doc, actualSizes);
      if (sizesChanged) setPageBaseSizes(actualSizes);
    };
    void loadPdf().catch((error) => {
      if (!cancelled) console.error('Failed to load PDF:', error);
    });
    return () => {
      cancelled = true;
      pdfDocRef.current = null;
    };
  }, [activeDocumentTabId, documentSessionId, setNumPages]);

  // Cancel in-flight renders when the viewer unmounts (tab switch or close).
  // The parsed document itself stays in the registry until its tab closes.
  useEffect(() => () => {
    for (const task of renderTasksRef.current.values()) {
      try { task.cancel(); } catch {}
    }
    renderTasksRef.current.clear();
  }, []);

  // A zoom change invalidates rendered canvases, but page placeholders retain
  // exact scaled dimensions so scrolling and page tracking remain stable.
  useEffect(() => {
    for (const task of renderTasksRef.current.values()) {
      try { task.cancel(); } catch {}
    }
    renderTasksRef.current.clear();
    renderedPagesRef.current.clear();
    wordCacheRef.current.clear();
    viewportSizeRef.current.clear();
    removeOverlay();
    clearSearchOverlays();
    pagesRef.current.forEach((pageDiv) => { pageDiv.innerHTML = ''; });
  }, [pdfDocument, zoom, removeOverlay, clearSearchOverlays]);

  // ─── Render visible pages ───

  useEffect(() => {
    if (!pdfDocument || numPages === 0 || pageBaseSizes.size !== numPages) return;

    const renderSignature = `${documentSessionId}:${zoom}`;

    const renderPage = async (pageNum: number) => {
      const doc = pdfDocument;
      if (pdfDocRef.current !== doc || renderedPagesRef.current.get(pageNum) === renderSignature) return;
      const existing = renderTasksRef.current.get(pageNum);
      if (existing) { try { existing.cancel(); } catch {} }

      const page = await doc.getPage(pageNum);
      if (pdfDocRef.current !== doc) return;
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: zoom });

      const pageDiv = pagesRef.current.get(pageNum);
      if (!pageDiv || !pageDiv.isConnected) return;

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

      // Highlights, underlines and strikethroughs read from the file are drawn
      // by Lexio's overlay (so they can be edited and deleted); pdf.js must
      // not draw them too. Notes deleted in Lexio are hidden until saved.
      const fileAnnotations = await page.getAnnotations();
      const listed = new Map(useStore.getState().highlights.filter((h) => h.pdfRef).map((h) => [h.pdfRef!, h]));
      for (const annotation of fileAnnotations) {
        if (!HIDEABLE_SUBTYPES.has(annotation.subtype) || annotation.inReplyTo) continue;
        const highlight = listed.get(annotation.id);
        doc.annotationStorage.setValue(annotation.id, { noView: !highlight || highlight.type !== 'note' });
      }
      if (pdfDocRef.current !== doc || pagesRef.current.get(pageNum) !== pageDiv || !pageDiv.isConnected) return;

      const ctx = canvas.getContext('2d')!;
      const renderViewport = page.getViewport({ scale: zoom * dpr });
      const renderTask = page.render({
        canvasContext: ctx,
        viewport: renderViewport,
        annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE,
      });
      renderTasksRef.current.set(pageNum, renderTask);
      try {
        await renderTask.promise;
        if (
          pdfDocRef.current !== doc ||
          pagesRef.current.get(pageNum) !== pageDiv ||
          !pageDiv.isConnected
        ) return;

        const textContent = await loadTextContent(page);
        if (
          pdfDocRef.current !== doc ||
          pagesRef.current.get(pageNum) !== pageDiv ||
          !pageDiv.isConnected
        ) return;

        const textLayerDiv = document.createElement('div');
        textLayerDiv.className = 'textLayer';
        textLayerDiv.dataset.page = String(pageNum);
        pageDiv.appendChild(textLayerDiv);

        const textLayer = new pdfjsLib.TextLayer({
          textContentSource: textContent,
          container: textLayerDiv,
          viewport,
        });
        await textLayer.render();
        if (
          pdfDocRef.current !== doc ||
          pagesRef.current.get(pageNum) !== pageDiv ||
          !pageDiv.isConnected
        ) return;

        wordCacheRef.current.set(pageNum, buildWordCache(textContent, viewport));
        renderHighlightsForPage(pageNum, pageDiv, viewport.width, viewport.height);
        renderSearchHighlightsForPage(pageNum);
        renderedPagesRef.current.set(pageNum, renderSignature);
      } catch (error: any) {
        if (error?.name !== 'RenderingCancelledException') {
          console.error(`Failed to render PDF page ${pageNum}:`, error);
        }
      } finally {
        if (renderTasksRef.current.get(pageNum) === renderTask) {
          renderTasksRef.current.delete(pageNum);
        }
      }
    };

    // Free pages that scrolled far away: canvas, text layer, overlays and
    // pdf.js page resources. Skipped during a drag so a long selection keeps
    // the character boxes of its starting page.
    if (!dragRef.current?.active) {
      for (const pageNum of [...renderedPagesRef.current.keys(), ...renderTasksRef.current.keys()]) {
        if (Math.abs(pageNum - currentPage) <= KEEP_RENDERED_DISTANCE) continue;
        const task = renderTasksRef.current.get(pageNum);
        if (task) { try { task.cancel(); } catch {} }
        renderTasksRef.current.delete(pageNum);
        renderedPagesRef.current.delete(pageNum);
        wordCacheRef.current.delete(pageNum);
        viewportSizeRef.current.delete(pageNum);
        textContentCacheRef.current.delete(pageNum);
        searchOverlayRef.current.delete(pageNum);
        const pageDiv = pagesRef.current.get(pageNum);
        if (pageDiv) pageDiv.innerHTML = '';
        void pdfDocument.getPage(pageNum).then((page) => page.cleanup()).catch(() => {});
      }
    }

    const start = Math.max(1, currentPage - 2);
    const end = Math.min(numPages, currentPage + 3);
    for (let i = start; i <= end; i++) {
      void renderPage(i).catch((error) => {
        if (pdfDocRef.current === pdfDocument) {
          console.error(`Failed to prepare PDF page ${i}:`, error);
        }
      });
    }
  }, [
    pdfDocument,
    pageBaseSizes,
    documentSessionId,
    numPages,
    currentPage,
    zoom,
    renderHighlightsForPage,
    renderSearchHighlightsForPage,
    loadTextContent,
  ]);

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

  useEffect(() => {
    if (!debouncedQuery.trim()) {
      clearSearchOverlays();
      return;
    }
    // Only rendered pages have character boxes; others are skipped inside.
    renderedPagesRef.current.forEach((_, pageNum) => renderSearchHighlightsForPage(pageNum));
  }, [debouncedQuery, clearSearchOverlays, renderSearchHighlightsForPage]);

  // Move the "active" styling between markers without rebuilding overlays.
  useEffect(() => {
    activeSearchMatchRef.current = activeSearchMatch;
    searchOverlayRef.current.forEach((layer, pageNum) => {
      layer.querySelectorAll<HTMLElement>('[data-search-active="true"]').forEach((marker) => {
        marker.dataset.searchActive = 'false';
      });
      if (activeSearchMatch?.page !== pageNum) return;
      layer.querySelectorAll<HTMLElement>(`[data-search-occurrence="${activeSearchMatch.occurrence}"]`)
        .forEach((marker) => { marker.dataset.searchActive = 'true'; });
    });
  }, [activeSearchMatch]);

  // ─── Scroll to current page ───

  useEffect(() => {
    if (!pdfDocument || pageBaseSizes.size !== numPages) return;
    if (observerPageUpdateRef.current) {
      // The reader scrolled here; the view is already on this page.
      observerPageUpdateRef.current = false;
      scrolledPageRef.current = currentPage;
      return;
    }
    const pageDiv = pagesRef.current.get(currentPage);
    if (pageDiv) {
      const layoutSignature = `${documentSessionId}:${zoom}`;
      const layoutWasPositioned = positionedLayoutRef.current === layoutSignature;
      // Real page sizes arrive after the first paint. That refinement alone
      // must not scroll: the reader may already be elsewhere and the page
      // observer may not have reported it yet. Browser scroll anchoring keeps
      // the view steady while pages above it change height.
      if (layoutWasPositioned && scrolledPageRef.current === currentPage) return;
      pageDiv.scrollIntoView({ behavior: layoutWasPositioned ? 'smooth' : 'auto', block: 'start' });
      positionedLayoutRef.current = layoutSignature;
      scrolledPageRef.current = currentPage;
    }
  }, [currentPage, documentSessionId, pdfDocument, pageBaseSizes, numPages, zoom]);

  // Outline a page briefly after a citation jump.
  const flashPage = useStore((state) => state.flashPage);
  useEffect(() => {
    if (!flashPage) return;
    const timer = window.setTimeout(() => {
      const pageDiv = pagesRef.current.get(flashPage.page);
      if (!pageDiv) return;
      pageDiv.classList.remove('lexio-page-flash');
      void pageDiv.offsetWidth;
      pageDiv.classList.add('lexio-page-flash');
    }, 350);
    return () => window.clearTimeout(timer);
  }, [flashPage]);

  // ─── Intersection observer for page tracking ───

  useEffect(() => {
    if (!containerRef.current || !pdfDocument || pageBaseSizes.size !== numPages) return;
    const viewerTabId = activeDocumentTabId;
    const intersecting = intersectingPagesRef.current;
    intersecting.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        // Track which pages overlap the viewport from the entries themselves,
        // then measure only those few pages instead of every page.
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) intersecting.add(page);
          else intersecting.delete(page);
        }
        if (useStore.getState().activeDocumentTabId !== viewerTabId) return;
        const container = containerRef.current;
        if (!container) return;
        const rootRect = container.getBoundingClientRect();
        const nearestPage = findNearestVisiblePage(
          rootRect.top,
          rootRect.bottom,
          [...intersecting].flatMap((page) => {
            const pageDiv = pagesRef.current.get(page);
            if (!pageDiv?.isConnected) return [];
            const rect = pageDiv.getBoundingClientRect();
            return [{ page, top: rect.top, bottom: rect.bottom }];
          })
        );
        if (nearestPage !== null && nearestPage !== useStore.getState().currentPage) {
          observerPageUpdateRef.current = true;
          setCurrentPage(nearestPage);
        }
      },
      { root: containerRef.current, threshold: [0.01, 0.25, 0.5, 0.75] }
    );
    pagesRef.current.forEach((div) => observer.observe(div));
    return () => observer.disconnect();
  }, [activeDocumentTabId, numPages, pdfDocument, pageBaseSizes, setCurrentPage]);

  // ─── Ctrl+Scroll zoom ───

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let pendingZoom: number | null = null;
    let settleTimer = 0;

    // While the wheel moves, scale the already-rendered pages with a CSS
    // transform (cheap, GPU). Only after the wheel has been still for
    // WHEEL_ZOOM_SETTLE_MS is the zoom committed, which re-renders the pages
    // once at the final size instead of once per wheel tick.
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const committedZoom = useStore.getState().zoom;
      const wrapper = pagesWrapperRef.current;
      if (pendingZoom === null && wrapper) {
        const rect = container.getBoundingClientRect();
        wrapper.style.transformOrigin = `50% ${container.scrollTop + e.clientY - rect.top}px`;
      }
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      pendingZoom = Math.max(0.25, Math.min(5, (pendingZoom ?? committedZoom) + delta));
      if (wrapper) wrapper.style.transform = `scale(${pendingZoom / committedZoom})`;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        if (wrapper) wrapper.style.transform = '';
        const nextZoom = pendingZoom;
        pendingZoom = null;
        if (nextZoom !== null) useStore.getState().setZoom(nextZoom);
      }, WHEEL_ZOOM_SETTLE_MS);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      window.clearTimeout(settleTimer);
      container.removeEventListener('wheel', handleWheel);
      if (pagesWrapperRef.current) pagesWrapperRef.current.style.transform = '';
    };
  }, []);

  // ─── Determine which page the cursor is over ───
  // Hit-testing asks the browser for the element under the cursor instead of
  // measuring every page on every mouse move.

  const getPageAtPoint = useCallback((
    clientX: number,
    clientY: number,
    allowHorizontalOutside = false
  ): number | null => {
    const pageAt = (x: number, y: number) => {
      const pageDiv = document.elementFromPoint(x, y)?.closest<HTMLElement>('.pdf-page-container');
      return pageDiv?.dataset.page ? Number(pageDiv.dataset.page) : null;
    };
    const page = pageAt(clientX, clientY);
    if (page !== null || !allowHorizontalOutside) return page;
    // The cursor is beside the page column while dragging: probe the middle
    // of the viewer at the same height.
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return pageAt(rect.left + rect.width / 2, clientY);
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
    if (e.button !== 0) return;
    removeOverlay();
    liveSelRef.current = null;
    setSelectionInfo(null);
    clearSelectedTextForAI();

    const pageNum = getPageAtPoint(e.clientX, e.clientY);
    if (pageNum === null) {
      dragRef.current = null;
      return;
    }

    const words = wordCacheRef.current.get(pageNum);
    if (!words || words.length === 0) {
      dragRef.current = null;
      return;
    }

    const coords = toPageCoords(e.clientX, e.clientY, pageNum);
    if (!coords) return;

    const idx = findNearestWord(coords.mx, coords.my, words);
    if (idx === -1) {
      dragRef.current = null;
      return;
    }

    e.preventDefault();
    const start = { page: pageNum, index: idx };
    dragRef.current = {
      active: true,
      started: false,
      start,
      originX: e.clientX,
      originY: e.clientY,
    };
  }, [getPageAtPoint, toPageCoords, removeOverlay, clearSelectedTextForAI]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const drag = dragRef.current;
    if (!drag?.active) return;

    if (!drag.started) {
      if (!hasExceededDragThreshold(drag.originX, drag.originY, e.clientX, e.clientY)) return;
      drag.started = true;
    }

    const container = containerRef.current;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const edgeSize = 48;
      if (e.clientY > containerRect.bottom - edgeSize) container.scrollTop += 18;
      else if (e.clientY < containerRect.top + edgeSize) container.scrollTop -= 18;
    }

    const pageNum = getPageAtPoint(e.clientX, e.clientY, true);
    if (pageNum === null) return;

    const words = wordCacheRef.current.get(pageNum);
    if (!words) return;

    const coords = toPageCoords(e.clientX, e.clientY, pageNum);
    if (!coords) return;

    const endIdx = findNearestWord(coords.mx, coords.my, words);
    if (endIdx === -1) return;

    const end = { page: pageNum, index: endIdx };
    const segments = buildSelectionSegments(wordCacheRef.current, drag.start, end);
    if (segments.length === 0) return;
    const text = segments.map((segment) => segment.text).join('\n\n');

    liveSelRef.current = { start: drag.start, end, text, segments };
    renderSelectionOverlays(segments);
  }, [getPageAtPoint, toPageCoords, renderSelectionOverlays]);

  const handleMouseUp = useCallback(() => {
    const drag = dragRef.current;
    const live = liveSelRef.current;

    if (!drag?.active || !drag.started || !live || !live.text.trim()) {
      if (drag) drag.active = false;
      dragRef.current = null;
      return;
    }

    drag.active = false;
    dragRef.current = null;

    const endpointWords = wordCacheRef.current.get(live.end.page);
    const endpointPageDiv = pagesRef.current.get(live.end.page);
    const endpointWord = endpointWords?.[live.end.index];
    if (!endpointWords || !endpointPageDiv || !endpointWord) return;

    const endpointPageRect = endpointPageDiv.getBoundingClientRect();
    const boundingRect = new DOMRect(
      endpointPageRect.left + endpointWord.left,
      endpointPageRect.top + endpointWord.top,
      endpointWord.right - endpointWord.left,
      endpointWord.bottom - endpointWord.top
    );
    const firstSegment = live.segments[0];
    const lastSegment = live.segments[live.segments.length - 1];
    const pageSelections = live.segments.map((segment) => ({
      page: segment.page,
      text: segment.text,
      rects: toRelativeRects(segment.lineRects, segment.page),
    })).filter((selection) => selection.rects.length > 0);
    if (pageSelections.length === 0) return;
    const relativeRects = pageSelections.length === 1 ? pageSelections[0].rects : [];

    if (['highlight', 'underline', 'strikeout'].includes(activeTool)) {
      for (const selection of pageSelections) {
        addHighlight({
          id: annotationId(),
          page: selection.page,
          rects: selection.rects,
          text: selection.text,
          color: activeHighlightColor,
          type: activeTool as AnnotationType,
          createdAt: Date.now(),
        });
      }
      removeOverlay();
      liveSelRef.current = null;
      return;
    }

    if (activeTool === 'comment') {
      setCommentModalInfo({ text: live.text, pageSelections });
      removeOverlay();
      liveSelRef.current = null;
      return;
    }

    setSelectionInfo({
      text: live.text,
      rect: boundingRect,
      page: firstSegment.page,
      endPage: lastSegment.page,
      relativeRects,
      pageSelections,
    });
  }, [activeTool, activeHighlightColor, addHighlight, removeOverlay, toRelativeRects]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const page = getPageAtPoint(e.clientX, e.clientY);
    if (page === null) return;
    const words = wordCacheRef.current.get(page);
    const pageDiv = pagesRef.current.get(page);
    const coords = toPageCoords(e.clientX, e.clientY, page);
    if (!words || !pageDiv || !coords) return;

    const index = findNearestWord(coords.mx, coords.my, words, 20);
    if (index === -1) return;
    e.preventDefault();
    const point = { page, index };
    const segments = buildSelectionSegments(wordCacheRef.current, point, point);
    const segment = segments[0];
    const word = words[index];
    if (!segment || !word) return;

    renderSelectionOverlays(segments);
    const pageRect = pageDiv.getBoundingClientRect();
    const rects = toRelativeRects(segment.lineRects, page);
    const pageSelections = [{ page, text: word.text, rects }];
    const boundingRect = new DOMRect(
      pageRect.left + word.left,
      pageRect.top + word.top,
      word.right - word.left,
      word.bottom - word.top
    );

    if (['highlight', 'underline', 'strikeout'].includes(activeTool)) {
      addHighlight({
        id: annotationId(),
        page,
        rects,
        text: word.text,
        color: activeHighlightColor,
        type: activeTool as AnnotationType,
        createdAt: Date.now(),
      });
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
      return;
    } else if (activeTool === 'comment') {
      setCommentModalInfo({ text: word.text, pageSelections });
      removeOverlay();
      liveSelRef.current = null;
      dragRef.current = null;
      return;
    } else {
      setSelectionInfo({
        text: word.text,
        rect: boundingRect,
        page,
        endPage: page,
        relativeRects: rects,
        pageSelections,
      });
    }
    liveSelRef.current = { start: point, end: point, text: word.text, segments };
    dragRef.current = null;
  }, [
    activeTool,
    activeHighlightColor,
    addHighlight,
    getPageAtPoint,
    toPageCoords,
    renderSelectionOverlays,
    removeOverlay,
    toRelativeRects,
  ]);

  // ─── Action bar callbacks ───

  const handleAskAI = useCallback(() => {
    if (!selectionInfo) return;
    setSelectedTextForAI(
      selectionInfo.text,
      selectionInfo.page,
      selectionInfo.relativeRects,
      selectionInfo.endPage
    );
    setSidebarOpen(true);
    setSidebarTab('chat');
    setSelectionInfo(null);
    removeOverlay();
    liveSelRef.current = null;
  }, [selectionInfo, setSelectedTextForAI, setSidebarOpen, setSidebarTab, removeOverlay]);

  const handleAnnotateSelection = useCallback((type: AnnotationType) => {
    if (!selectionInfo) return;
    for (const selection of selectionInfo.pageSelections) {
      addHighlight({
        id: annotationId(),
        page: selection.page,
        rects: selection.rects,
        text: selection.text,
        color: activeHighlightColor,
        type,
        createdAt: Date.now(),
      });
    }
    setSelectionInfo(null);
    removeOverlay();
    liveSelRef.current = null;
  }, [selectionInfo, activeHighlightColor, addHighlight, removeOverlay]);

  const handleCommentSelection = useCallback(() => {
    if (!selectionInfo) return;
    setCommentModalInfo({
      text: selectionInfo.text,
      pageSelections: selectionInfo.pageSelections,
    });
    setSelectionInfo(null);
    removeOverlay();
    liveSelRef.current = null;
  }, [selectionInfo, removeOverlay]);

  const handleSaveComment = useCallback((comment: string) => {
    if (!commentModalInfo) return;
    const trimmedComment = comment.trim();
    if (trimmedComment) {
      for (const selection of commentModalInfo.pageSelections) {
        addHighlight({
          id: annotationId(),
          page: selection.page,
          rects: selection.rects,
          text: selection.text,
          color: activeHighlightColor,
          type: 'highlight',
          comment: trimmedComment,
          createdAt: Date.now(),
        });
      }
    }
    setCommentModalInfo(null);
  }, [commentModalInfo, activeHighlightColor, addHighlight]);

  useEffect(() => {
    if (!selectionInfo?.text) return;
    const copySelection = () => {
      void copyText(selectionInfo.text).catch((error) => {
        console.error('Failed to copy selected PDF text:', error);
      });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return;
      event.preventDefault();
      event.stopPropagation();
      copySelection();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('lexio:copy-selection', copySelection);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('lexio:copy-selection', copySelection);
    };
  }, [selectionInfo]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setDebouncedQuery('');
    setSearchMatchIndex(0);
    clearSearchOverlays();
  }, [clearSearchOverlays]);

  const focusSearchInput = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        searchInputRef.current?.focus({ preventScroll: true });
        searchInputRef.current?.select();
      });
    });
  }, []);

  const navigateSearch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return;
    const nextIndex = (
      searchMatchIndex + direction + searchMatches.length
    ) % searchMatches.length;
    setSearchMatchIndex(nextIndex);
    setCurrentPage(searchMatches[nextIndex].page);
  }, [searchMatches, searchMatchIndex, setCurrentPage]);

  useEffect(() => {
    const openSearch = () => {
      setSearchOpen(true);
      focusSearchInput();
    };
    window.addEventListener('lexio:find', openSearch);
    return () => window.removeEventListener('lexio:find', openSearch);
  }, [focusSearchInput]);

  useEffect(() => {
    if (searchOpen) focusSearchInput();
  }, [focusSearchInput, searchOpen]);

  useEffect(() => {
    setSearchMatchIndex(0);
    if (debouncedQuery.trim() && searchMatches[0]) {
      setCurrentPage(searchMatches[0].page);
    }
    // searchMatches is calculated from this exact query during render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery, setCurrentPage]);

  useEffect(() => {
    if (searchMatches.length === 0) {
      setSearchMatchIndex(0);
    } else if (searchMatchIndex >= searchMatches.length) {
      setSearchMatchIndex(searchMatches.length - 1);
    }
  }, [searchMatches.length, searchMatchIndex]);

  useEffect(() => {
    if (!activeSearchMatch || !debouncedQuery.trim()) return;

    setCurrentPage(activeSearchMatch.page);
    let attempts = 0;
    let animationFrame = 0;
    const revealActiveMatch = () => {
      const layer = searchOverlayRef.current.get(activeSearchMatch.page);
      const marker = layer?.querySelector<HTMLElement>(
        `[data-search-occurrence="${activeSearchMatch.occurrence}"][data-search-primary="true"]`
      );
      if (marker) {
        marker.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        return;
      }
      attempts += 1;
      if (attempts < 120) {
        animationFrame = window.requestAnimationFrame(revealActiveMatch);
      }
    };
    animationFrame = window.requestAnimationFrame(revealActiveMatch);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [activeSearchMatch, debouncedQuery, setCurrentPage]);

  // ─── Render ───

  return (
    <div
      ref={containerRef}
      className="h-full overflow-auto bg-surface-0 relative"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
    >
      {searchOpen && (
        <div
          className="sticky top-2 z-[120] ml-auto mr-3 flex w-fit items-center gap-1 rounded-lg border border-surface-4 bg-surface-2 p-1.5 shadow-xl"
          onMouseDown={(event) => event.stopPropagation()}
          onMouseUp={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <Search size={14} className="ml-1 text-text-muted" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                navigateSearch(event.shiftKey ? -1 : 1);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                closeSearch();
              }
            }}
            placeholder="Find in document"
            className="w-52 bg-transparent px-1 py-1 text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <span className="min-w-[62px] text-center text-[11px] text-text-muted">
            {!debouncedQuery.trim()
              ? ''
              : searchMatches.length === 0
                ? 'No results'
                : `${searchMatchIndex + 1} / ${searchMatches.length}`}
          </span>
          <button
            type="button"
            onClick={() => navigateSearch(-1)}
            disabled={searchMatches.length === 0}
            className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary disabled:opacity-30"
            title="Previous match (Shift+Enter)"
            aria-label="Previous search match"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={() => navigateSearch(1)}
            disabled={searchMatches.length === 0}
            className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary disabled:opacity-30"
            title="Next match (Enter)"
            aria-label="Next search match"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            className="rounded p-1 text-text-muted hover:bg-surface-3 hover:text-text-primary"
            title="Close search (Esc)"
            aria-label="Close document search"
          >
            <X size={14} />
          </button>
        </div>
      )}
      {/* w-max + min-w-full: pages wider than the viewer widen the column so
          the viewer scrolls horizontally, instead of centering them with
          their left edge cut off and unreachable. */}
      <div ref={pagesWrapperRef} className="flex flex-col items-center py-6 px-4 gap-4 min-h-full w-max min-w-full">
        {pdfDocument && pageBaseSizes.size === numPages && Array.from(
          { length: numPages },
          (_, i) => i + 1
        ).map((pageNum) => {
          const baseSize = pageBaseSizes.get(pageNum);
          return (
            <div
              key={`${documentSessionId}-${pageNum}`}
              data-page={pageNum}
              ref={(el) => {
                if (el) pagesRef.current.set(pageNum, el);
                else pagesRef.current.delete(pageNum);
              }}
              className="pdf-page-container relative bg-white"
              style={baseSize ? {
                width: baseSize.width * zoom,
                height: baseSize.height * zoom,
              } : undefined}
            />
          );
        })}
        {(!pdfDocument || pageBaseSizes.size !== numPages) && hasPdf && (
          <div className="flex items-center justify-center h-full text-text-muted">
            Loading PDF…
          </div>
        )}
      </div>

      {selectionInfo && (
        <SelectionActionBar
          rect={selectionInfo.rect}
          containerRef={containerRef}
          text={selectionInfo.text}
          onAskAI={handleAskAI}
          onAnnotate={handleAnnotateSelection}
          onComment={handleCommentSelection}
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
