import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../stores/useStore';
import { openPdfDocument, type pdfjsLib } from '../utils/pdfjs';
import { loadRegisteredDocument, releaseRegisteredDocument } from '../utils/pdf-document-registry';
import { pageTextFromItems, type OutlineEntry } from '../utils/text-index';
import { loadLibrary, saveLibrary } from '../utils/library-store';

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

  useEffect(() => {
    schedule();
  }, [signature]);

  useEffect(() => () => {
    running?.abort.abort();
    running = null;
  }, []);

  return null;
}
