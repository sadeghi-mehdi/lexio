import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores/useStore';
import { openPdfDocument, type pdfjsLib } from '../utils/pdfjs';
import { loadRegisteredDocument, releaseRegisteredDocument } from '../utils/pdf-document-registry';
import {
  embeddingWindows,
  getDocumentIndex,
  pageTextFromItems,
  type DocumentIndex,
  type OutlineEntry,
} from '../utils/text-index';
import { loadLibrary, saveLibrary } from '../utils/library-store';
import {
  documentVectors,
  downloadEmbeddingModel,
  embeddingInstalled,
  embedTexts,
  loadEmbedder,
} from '../utils/embedding-client';
import { EMBEDDING_MODEL_ID, vectorsFromBase64, vectorsToBase64 } from '../utils/embeddings';
import type { DocumentTabSession } from '../stores/useStore';
import type { Highlight, OcrPage } from '../types';
import { needsOcr, recognizePage, renderPageImage } from '../utils/ocr';
import { chatWithImage } from '../providers/tool-providers';
import { mergeNotes, NOTES_VERSION, readPageAnnotations, type SavedNotes } from '../utils/pdf-annotations';

// Extracts the text of every open PDF in the background, one tab at a time,
// active tab first. Text, headings and the outline are cached on disk by file
// hash, so reopening a PDF does not extract it again.

// Version 2 added the annotations read from the file.
const TEXT_CACHE_VERSION = 2;
const BATCH = 10;

interface CachedText {
  version: number;
  pageCount: number;
  pages: Array<[number, string]>;
  headings: Array<[number, string[]]>;
  outline: OutlineEntry[];
  annotations: Highlight[];
}

// ─── Notes ───

// The user's annotations for a document are saved automatically, by file
// hash, together with the ids of the annotations the file itself contained.
// When the file is opened again, annotations added or deleted by another app
// in the meantime are taken over (see mergeNotes).

// Tabs whose annotations have been loaded and may be saved, with the file's
// annotation ids at load time.
const notesLoaded = new Map<string, { key: string; importedRefs: string[] }>();

async function applyNotes(tabId: string, key: string, fromFile: Highlight[]): Promise<void> {
  const saved = /^[a-f0-9]{64}$/i.test(key) ? await loadLibrary<SavedNotes>('notes', key) : null;
  const tab = tabState(tabId);
  if (!tab) return;
  useStore.getState().setTabHighlights(mergeNotes(saved, fromFile, tab.highlights), tabId);
  notesLoaded.set(tabId, { key, importedRefs: fromFile.map((highlight) => highlight.pdfRef!).filter(Boolean) });
}

let notesTimer = 0;
function saveNotesSoon(): void {
  window.clearTimeout(notesTimer);
  notesTimer = window.setTimeout(() => {
    const state = useStore.getState();
    const tabId = state.activeDocumentTabId;
    const loaded = tabId ? notesLoaded.get(tabId) : undefined;
    if (!loaded || !/^[a-f0-9]{64}$/i.test(loaded.key)) return;
    void saveLibrary('notes', loaded.key, {
      version: NOTES_VERSION,
      highlights: state.highlights,
      importedRefs: loaded.importedRefs,
    } satisfies SavedNotes);
  }, 800);
}

// The tab being extracted and a way to stop it. Only one extraction runs at a
// time so a large background PDF cannot slow down the one being read.
let running: { tabId: string; abort: AbortController } | null = null;

function tabState(tabId: string) {
  const state = useStore.getState();
  if (state.activeDocumentTabId === tabId) return state;
  return state.documentTabs.find((tab) => tab.id === tabId) || null;
}

async function resolveOutline(doc: pdfjsLib.PDFDocumentProxy): Promise<OutlineEntry[]> {
  const entries: OutlineEntry[] = [];
  const walk = async (items: Awaited<ReturnType<typeof doc.getOutline>>, depth: number) => {
    for (const item of items || []) {
      if (entries.length >= 500) return;
      try {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        const ref = Array.isArray(dest) ? dest[0] : null;
        if (ref !== null && ref !== undefined) {
          const pageIndex = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
          entries.push({ title: item.title.trim(), page: pageIndex + 1, depth });
        }
      } catch {
        // Broken outline entries are skipped.
      }
      if (item.items?.length && depth < 3) await walk(item.items, depth + 1);
    }
  };
  try {
    await walk(await doc.getOutline(), 0);
  } catch {
    return [];
  }
  return entries;
}

async function extractTab(tabId: string, signal: AbortSignal): Promise<void> {
  const store = useStore.getState();
  const tab = tabState(tabId);
  const pdfFile = tab?.pdfFile;
  if (!tab || !pdfFile || tab.documentTextReady) return;
  const key = pdfFile.fingerprint || '';

  if (key && tab.extractedPageCount === 0) {
    const cached = await loadLibrary<CachedText>('text', key);
    if (signal.aborted) return;
    if (cached?.version === TEXT_CACHE_VERSION && Array.isArray(cached.pages) && cached.pageCount > 0) {
      store.mergePageTexts(cached.pages, tabId, cached.headings || []);
      store.setDocumentOutline(cached.outline || [], tabId);
      await applyNotes(tabId, key, cached.annotations || []);
      store.setExtractionProgress(cached.pageCount, true, tabId);
      return;
    }
  }

  const doc = await loadRegisteredDocument(tabId, () => openPdfDocument(pdfFile.data));
  if (signal.aborted) return;
  const outline = await resolveOutline(doc);
  if (signal.aborted) return;
  store.setDocumentOutline(outline, tabId);

  // Resume after the pages an interrupted run already committed. Annotations
  // are read for every page, including pages committed earlier.
  const fromFile: Highlight[] = [];
  const firstPage = (tabState(tabId)?.extractedPageCount || 0) + 1;
  for (let pageNumber = 1; pageNumber < firstPage; pageNumber++) {
    if (signal.aborted) return;
    const page = await doc.getPage(pageNumber);
    fromFile.push(...readPageAnnotations(pageNumber, await page.getAnnotations(), (await page.getTextContent()).items, page.getViewport({ scale: 1 })));
  }
  let batch: Array<[number, string]> = [];
  let headingBatch: Array<[number, string[]]> = [];
  for (let pageNumber = firstPage; pageNumber <= doc.numPages; pageNumber++) {
    if (signal.aborted) return;
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const annotations = await page.getAnnotations();
    if (signal.aborted) return;
    const { text, headings } = pageTextFromItems(content.items);
    fromFile.push(...readPageAnnotations(pageNumber, annotations, content.items, page.getViewport({ scale: 1 })));
    batch.push([pageNumber, text]);
    if (headings.length) headingBatch.push([pageNumber, headings]);
    if (batch.length >= BATCH || pageNumber === doc.numPages) {
      store.mergePageTexts(batch, tabId, headingBatch);
      if (pageNumber === doc.numPages) await applyNotes(tabId, key || tabId, fromFile);
      store.setExtractionProgress(pageNumber, pageNumber === doc.numPages, tabId);
      batch = [];
      headingBatch = [];
    }
  }

  const finished = tabState(tabId);
  if (!finished) return;
  if (key) {
    void saveLibrary('text', key, {
      version: TEXT_CACHE_VERSION,
      pageCount: doc.numPages,
      pages: [...finished.pageTexts.entries()],
      headings: [...finished.pageHeadings.entries()],
      outline,
      annotations: fromFile,
    } satisfies CachedText);
  }
  // A background tab does not need its parsed PDF until it is shown. The
  // viewer loads it again on activation.
  if (useStore.getState().activeDocumentTabId !== tabId) releaseRegisteredDocument(tabId);
}

type TabLike = Pick<DocumentTabSession, 'pdfFile' | 'pageTexts' | 'pageHeadings' | 'documentOutline'> &
  Partial<Pick<DocumentTabSession, 'ocrPages'>>;

// Key for per-document data: the file hash, or the tab id for a file
// without one. The same PDF open twice shares its index and vectors.
export function documentKey(tab: TabLike, tabId: string): string {
  return tab.pdfFile.fingerprint || tabId;
}

// The search index of a tab's document, rebuilt only when its text changes.
export function tabDocumentIndex(tab: TabLike, tabId: string): DocumentIndex {
  return getDocumentIndex({
    key: documentKey(tab, tabId),
    name: tab.pdfFile.name,
    pageTexts: tab.pageTexts,
    headings: tab.pageHeadings,
    outline: tab.documentOutline,
    ocrPages: new Set(tab.ocrPages?.keys() || []),
  });
}

// ─── Meaning-based search ───

const VECTOR_CACHE_VERSION = 1;

interface CachedVectors {
  version: number;
  model: string;
  check: string;
  passageOf: number[];
  vectors: string;
}

// FNV-1a hash of the window texts. Cached vectors are used only when the
// windows they were computed from are identical.
function textCheck(texts: string[]): string {
  let hash = 0x811c9dc5;
  for (const text of texts) {
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 0x0a;
  }
  return `${texts.length}:${(hash >>> 0).toString(16)}`;
}

let vectorJob: Promise<void> | null = null;
let vectorRerun = false;

// Computes passage vectors for every tab whose text is ready, active tab
// first. Runs one document at a time and starts again if tabs changed.
function scheduleVectors(): void {
  const state = useStore.getState();
  if (!state.settings.semanticSearch || !['ready', 'indexing'].includes(state.embeddingStatus)) return;
  if (vectorJob) {
    vectorRerun = true;
    return;
  }
  vectorJob = (async () => {
    const tabs: Array<[string, TabLike]> = [];
    const current = useStore.getState();
    if (current.activeDocumentTabId && current.pdfFile && current.documentTextReady) {
      tabs.push([current.activeDocumentTabId, current as unknown as TabLike]);
    }
    for (const tab of current.documentTabs) {
      if (tab.id !== current.activeDocumentTabId && tab.documentTextReady) tabs.push([tab.id, tab]);
    }
    for (const [tabId, tab] of tabs) {
      const key = documentKey(tab, tabId);
      const index = tabDocumentIndex(tab, tabId);
      const windows = embeddingWindows(index);
      const check = textCheck(windows.texts);
      if (documentVectors.get(key)?.check === check) continue;

      const cached = /^[a-f0-9]{64}$/i.test(key) ? await loadLibrary<CachedVectors>('embeddings', key) : null;
      if (cached?.version === VECTOR_CACHE_VERSION && cached.model === EMBEDDING_MODEL_ID && cached.check === check) {
        documentVectors.set(key, { check, vectors: vectorsFromBase64(cached.vectors), passageOf: cached.passageOf });
        continue;
      }

      const parts: Float32Array[] = [];
      for (let start = 0; start < windows.texts.length; start += 8) {
        if (!useStore.getState().settings.semanticSearch) return;
        useStore.getState().setEmbeddingState(
          'indexing',
          `preparing ${tab.pdfFile.name} (${Math.round((start / windows.texts.length) * 100)}%)`
        );
        parts.push(await embedTexts(windows.texts.slice(start, start + 8)));
      }
      const vectors = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        vectors.set(part, offset);
        offset += part.length;
      }
      documentVectors.set(key, { check, vectors, passageOf: windows.passageOf });
      if (/^[a-f0-9]{64}$/i.test(key)) {
        void saveLibrary('embeddings', key, {
          version: VECTOR_CACHE_VERSION,
          model: EMBEDDING_MODEL_ID,
          check,
          passageOf: windows.passageOf,
          vectors: vectorsToBase64(vectors),
        } satisfies CachedVectors);
      }
    }
  })()
    .catch((error) => {
      console.error('Preparing meaning-based search failed:', error);
      useStore.getState().setEmbeddingState('error', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      vectorJob = null;
      if (useStore.getState().embeddingStatus === 'indexing') useStore.getState().setEmbeddingState('ready');
      if (vectorRerun) {
        vectorRerun = false;
        scheduleVectors();
      }
    });
}

// ─── OCR ───

const OCR_CACHE_VERSION = 1;
let ocrJob: Promise<void> | null = null;
let ocrRerun = false;

// Recognizes text on scanned pages of every open PDF, active tab first, one
// page at a time. Results (including empty ones for blank pages) are cached
// by file hash, so a page is never recognized twice.
function scheduleOcr(): void {
  if (!useStore.getState().settings.ocrEnabled) return;
  if (ocrJob) {
    ocrRerun = true;
    return;
  }
  ocrJob = (async () => {
    const current = useStore.getState();
    const tabIds = [
      ...(current.activeDocumentTabId && current.pdfFile ? [current.activeDocumentTabId] : []),
      ...current.documentTabs.map((tab) => tab.id).filter((id) => id !== current.activeDocumentTabId),
    ];
    for (const tabId of tabIds) {
      const found = tabState(tabId);
      if (!found?.pdfFile || !found.documentTextReady) continue;
      const tab = found as typeof found & TabLike & { ocrPages: Map<number, OcrPage> };
      const pending = [...tab.pageTexts.entries()]
        .filter(([page, text]) => needsOcr(text) && !tab.ocrPages.has(page))
        .map(([page]) => page)
        .sort((a, b) => a - b);
      if (!pending.length) continue;
      const key = documentKey(tab, tabId);
      const cacheable = /^[a-f0-9]{64}$/i.test(key);
      const cached = cacheable ? await loadLibrary<{ version: number; pages: Array<[number, OcrPage]> }>('ocr', key) : null;
      const results = new Map<number, OcrPage>(cached?.version === OCR_CACHE_VERSION ? cached.pages : []);
      const fromCache = pending.filter((page) => results.has(page)).map((page) => [page, results.get(page)!] as const);
      if (fromCache.length) useStore.getState().applyOcrPages(fromCache, tabId);
      const toRecognize = pending.filter((page) => !results.has(page));
      if (!toRecognize.length) continue;

      const doc = await loadRegisteredDocument(tabId, () => openPdfDocument(tab.pdfFile.data));
      for (let position = 0; position < toRecognize.length; position++) {
        const state = useStore.getState();
        if (!state.settings.ocrEnabled || !tabState(tabId)) return;
        state.setIndexProgress(`Recognizing text (OCR) ${position + 1}/${toRecognize.length}`, tabId);
        const pageNumber = toRecognize[position];
        const page = await doc.getPage(pageNumber);
        const ocr = await recognizePage(await renderPageImage(page as never));
        results.set(pageNumber, ocr);
        useStore.getState().applyOcrPages([[pageNumber, ocr]], tabId);
        if (cacheable && (position % 5 === 4 || position === toRecognize.length - 1)) {
          void saveLibrary('ocr', key, { version: OCR_CACHE_VERSION, pages: [...results.entries()] });
        }
      }
      const pages = toRecognize.length;
      const low = [...results.values()].filter((result) => result.words.length && result.confidence < 60).length;
      useStore.getState().setIndexProgress(
        `Text ready · OCR on ${pages} page${pages === 1 ? '' : 's'}${low ? ` (${low} with low confidence)` : ''}`,
        tabId
      );
      if (useStore.getState().activeDocumentTabId !== tabId) releaseRegisteredDocument(tabId);
      // Vectors must be recomputed for the new text.
      scheduleVectors();
    }
  })()
    .catch((error) => console.error('OCR failed:', error))
    .finally(() => {
      ocrJob = null;
      if (ocrRerun) {
        ocrRerun = false;
        scheduleOcr();
      }
    });
}

// Re-reads one page with the chat's vision model (for tables, equations or
// poor scans). The page image is sent to the provider; for cloud providers
// the caller asks first. Tesseract's word boxes stay for selection; the
// model's text replaces the page text used for search and the AI.
export async function rereadPageWithModel(tabId: string, pageNumber: number, signal: AbortSignal): Promise<void> {
  const state = useStore.getState();
  const tab = tabState(tabId) as (DocumentTabSession | null);
  if (!tab?.pdfFile) return;
  const config = state.settings.providers[state.settings.activeProvider];
  if (!config.enabled) throw new Error(`${config.name} is disabled. Enable it in Settings first.`);
  const doc = await loadRegisteredDocument(tabId, () => openPdfDocument(tab.pdfFile.data));
  const canvas = await renderPageImage((await doc.getPage(pageNumber)) as never);
  const pngBase64 = canvas.toDataURL('image/png').split(',')[1];
  state.setIndexProgress(`Reading page ${pageNumber} with ${config.model}…`, tabId);
  const text = await chatWithImage(
    state.settings.activeProvider,
    'Transcribe all text on this page exactly as printed, in reading order. Keep line breaks between paragraphs. Write tables as markdown tables and equations in plain text or LaTeX. Output only the transcription.',
    pngBase64,
    config,
    signal
  );
  if (!text.trim()) throw new Error('The model returned no text for this page.');
  const previous = tabState(tabId)?.ocrPages?.get(pageNumber);
  const ocr: OcrPage = { text: text.trim(), confidence: 100, words: previous?.words || [], engine: config.model };
  useStore.getState().applyOcrPages([[pageNumber, ocr]], tabId);
  useStore.getState().setIndexProgress(`Page ${pageNumber} re-read with ${config.model}`, tabId);
  const key = documentKey(tab, tabId);
  if (/^[a-f0-9]{64}$/i.test(key)) {
    const cached = await loadLibrary<{ version: number; pages: Array<[number, OcrPage]> }>('ocr', key);
    const pages = new Map(cached?.version === OCR_CACHE_VERSION ? cached.pages : []);
    pages.set(pageNumber, ocr);
    void saveLibrary('ocr', key, { version: OCR_CACHE_VERSION, pages: [...pages.entries()] });
  }
  scheduleVectors();
}

async function startEmbedder(): Promise<void> {
  const { setEmbeddingState } = useStore.getState();
  try {
    setEmbeddingState('loading');
    await loadEmbedder();
    setEmbeddingState('ready');
    scheduleVectors();
  } catch (error) {
    setEmbeddingState('error', error instanceof Error ? error.message : String(error));
  }
}

// Downloads the model on the user's request (first use), then loads it.
export function startEmbeddingDownload(): void {
  const { setEmbeddingState } = useStore.getState();
  setEmbeddingState('downloading', 'downloading model (0%)');
  void downloadEmbeddingModel((fraction) => {
    setEmbeddingState('downloading', `downloading model (${Math.round(fraction * 100)}%)`);
  })
    .then(startEmbedder)
    .catch((error) => setEmbeddingState('error', error instanceof Error ? error.message : String(error)));
}

// Picks the next tab to extract: the active one if it still needs text,
// otherwise the first open tab that does.
function nextTab(): string | null {
  const state = useStore.getState();
  if (state.activeDocumentTabId && state.pdfFile && !state.documentTextReady) return state.activeDocumentTabId;
  return state.documentTabs.find((tab) => tab.id !== state.activeDocumentTabId && !tab.documentTextReady)?.id || null;
}

function schedule(): void {
  const target = nextTab();
  if (running && running.tabId === target) return;
  // A higher-priority tab (usually one the user just switched to) interrupts
  // the current extraction. Committed pages stay, so it resumes later.
  running?.abort.abort();
  running = null;
  if (!target) return;
  const job = { tabId: target, abort: new AbortController() };
  running = job;
  void extractTab(target, job.abort.signal)
    .catch((error) => {
      if (!job.abort.signal.aborted) {
        console.error('Text extraction failed:', error);
        // Mark the tab done so the scheduler moves on instead of retrying forever.
        const tab = tabState(target);
        useStore.getState().setExtractionProgress(tab?.extractedPageCount || 0, true, target);
      }
    })
    .finally(() => {
      if (running === job) {
        running = null;
        schedule();
      }
    });
}

export default function DocumentIndexer() {
  // Re-evaluate whenever the set of tabs, the active tab or any tab's
  // extraction state changes.
  const signature = useStore(useShallow((state) => [
    state.activeDocumentTabId || '',
    state.documentTextReady ? 'ready' : 'pending',
    ...state.documentTabs.map((tab) => `${tab.id}:${tab.id === state.activeDocumentTabId || tab.documentTextReady}`),
  ]));

  const semanticSearch = useStore((state) => state.settings.semanticSearch);

  const ocrEnabled = useStore((state) => state.settings.ocrEnabled);

  useEffect(() => {
    schedule();
    scheduleVectors();
    scheduleOcr();
  }, [signature, ocrEnabled]);

  // Load the embedding model at start if it is installed. It is downloaded
  // only when the user asks (see startEmbeddingDownload).
  useEffect(() => {
    if (!semanticSearch) return;
    const { embeddingStatus, setEmbeddingState } = useStore.getState();
    if (embeddingStatus === 'ready') {
      scheduleVectors();
      return;
    }
    if (embeddingStatus !== 'unknown' && embeddingStatus !== 'not-installed' && embeddingStatus !== 'unavailable') return;
    if (!window.electronAPI) {
      setEmbeddingState('unavailable');
      return;
    }
    void embeddingInstalled().then((installed) => {
      if (installed) void startEmbedder();
      else setEmbeddingState('not-installed');
    });
  }, [semanticSearch]);

  useEffect(() => () => {
    running?.abort.abort();
    running = null;
  }, []);

  // Save the active tab's annotations whenever they change, once loaded.
  useEffect(() => useStore.subscribe((state, previous) => {
    if (state.highlights !== previous.highlights && state.activeDocumentTabId === previous.activeDocumentTabId) saveNotesSoon();
    for (const tabId of notesLoaded.keys()) {
      if (tabId !== state.activeDocumentTabId && !state.documentTabs.some((tab) => tab.id === tabId)) notesLoaded.delete(tabId);
    }
  }), []);

  return null;
}
