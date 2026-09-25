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

// Extracts the text of every open PDF in the background, one tab at a time,
// active tab first. Text, headings and the outline are cached on disk by file
// hash, so reopening a PDF does not extract it again.

const TEXT_CACHE_VERSION = 1;
const BATCH = 10;

interface CachedText {
  version: number;
  pageCount: number;
  pages: Array<[number, string]>;
  headings: Array<[number, string[]]>;
  outline: OutlineEntry[];
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
      store.setExtractionProgress(cached.pageCount, true, tabId);
      return;
    }
  }

  const doc = await loadRegisteredDocument(tabId, () => openPdfDocument(pdfFile.data));
  if (signal.aborted) return;
  const outline = await resolveOutline(doc);
  if (signal.aborted) return;
  store.setDocumentOutline(outline, tabId);

  // Resume after the pages an interrupted run already committed.
  let batch: Array<[number, string]> = [];
  let headingBatch: Array<[number, string[]]> = [];
  for (let pageNumber = (tabState(tabId)?.extractedPageCount || 0) + 1; pageNumber <= doc.numPages; pageNumber++) {
    if (signal.aborted) return;
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    if (signal.aborted) return;
    const { text, headings } = pageTextFromItems(content.items);
    batch.push([pageNumber, text]);
    if (headings.length) headingBatch.push([pageNumber, headings]);
    if (batch.length >= BATCH || pageNumber === doc.numPages) {
      store.mergePageTexts(batch, tabId, headingBatch);
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
    } satisfies CachedText);
  }
  // A background tab does not need its parsed PDF until it is shown. The
  // viewer loads it again on activation.
  if (useStore.getState().activeDocumentTabId !== tabId) releaseRegisteredDocument(tabId);
}

type TabLike = Pick<DocumentTabSession, 'pdfFile' | 'pageTexts' | 'pageHeadings' | 'documentOutline'>;

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

  useEffect(() => {
    schedule();
    scheduleVectors();
  }, [signature]);

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

  return null;
}
