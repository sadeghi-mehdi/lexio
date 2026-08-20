export type ResolvedContextMode = 'selection' | 'relevant' | 'entire';

export interface DocumentContextResult {
  mode: ResolvedContextMode;
  text: string;
  pages: number[];
  description: string;
  documentCharacterCount: number;
  truncated: boolean;
  requiresHierarchicalSummary: boolean;
}

export interface DocumentChunk {
  startPage: number;
  endPage: number;
  text: string;
}

interface BuildContextOptions {
  pageTexts: ReadonlyMap<number, string>;
  mode: ResolvedContextMode;
  query: string;
  maxChars: number;
  selectedPage?: number;
  selectedEndPage?: number;
  selectedText?: string;
  currentPage?: number;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'because', 'been', 'before', 'being',
  'between', 'but', 'can', 'could', 'did', 'does', 'each', 'for', 'from', 'had', 'has',
  'have', 'how', 'into', 'its', 'may', 'more', 'most', 'not', 'of', 'on', 'or', 'our',
  'please', 'should', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'was', 'were', 'what', 'when', 'where', 'which',
  'who', 'why', 'will', 'with', 'would', 'you', 'your',
  'describe', 'discuss', 'explain', 'review', 'summarize', 'summary',
]);

function getPages(pageTexts: ReadonlyMap<number, string>): Array<[number, string]> {
  return [...pageTexts.entries()]
    .filter(([, text]) => text.trim().length > 0)
    .sort(([a], [b]) => a - b);
}

function canonicalToken(token: string): string {
  if (/^method(?:s|ology|ologies|ological)?$/.test(token)) return 'method';
  if (/^procedur(?:e|es|al)$/.test(token)) return 'method';
  if (/^experiment(?:s|al|ation)?$/.test(token)) return 'experiment';
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) || [])
    .filter((token) => !STOP_WORDS.has(token))
    .map(canonicalToken);
}

function formatPage(page: number, text: string): string {
  return `--- Page ${page} ---\n${text.trim()}`;
}

function documentCharacterCount(pages: Array<[number, string]>): number {
  return pages.reduce((total, [page, text]) => total + formatPage(page, text).length + 2, 0);
}

export function isWholeDocumentRequest(query: string): boolean {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/\bliterature\b/.test(normalized)) return true;
  return [
    /summari[sz]e (?:the |this )?(?:entire|whole|full) (?:pdf|document|report|paper)/,
    /summari[sz]e (?:the |this )?(?:pdf|document|report|paper)\b/,
    /(?:overall|complete) summary/,
    /executive summary/,
    /overview of (?:the |this )?(?:pdf|document|report|paper)/,
    /main (?:findings|conclusions|points) (?:of|from) (?:the |this )?(?:pdf|document|report|paper)/,
    /^what are the main (?:findings|conclusions|points)\??$/,
    /review (?:the |this )?(?:entire|whole|full) (?:pdf|document|report|paper)/,
  ].some((pattern) => pattern.test(normalized));
}

export type DocumentAwareStrategy =
  | 'entire-original'
  | 'hierarchical-summary'
  | 'indexed-retrieval'
  | 'direct-retrieval';

export function chooseDocumentAwareStrategy(
  query: string,
  completeDocumentExceedsBudget: boolean,
  pageIndexReady: boolean
): DocumentAwareStrategy {
  if (isWholeDocumentRequest(query)) {
    return completeDocumentExceedsBudget ? 'hierarchical-summary' : 'entire-original';
  }
  return pageIndexReady ? 'indexed-retrieval' : 'direct-retrieval';
}

export function rankRelevantPages(
  pageTexts: ReadonlyMap<number, string>,
  query: string
): Array<{ page: number; score: number }> {
  const pages = getPages(pageTexts);
  const queryTerms = [...new Set(tokenize(query))];
  if (pages.length === 0 || queryTerms.length === 0) return [];

  const documents = pages.map(([page, text]) => {
    const terms = tokenize(text);
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) || 0) + 1);
    return { page, terms, frequencies };
  });
  const averageLength =
    documents.reduce((total, document) => total + document.terms.length, 0) /
    Math.max(1, documents.length);
  const documentFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    documentFrequency.set(
      term,
      documents.reduce((count, document) => count + (document.frequencies.has(term) ? 1 : 0), 0)
    );
  }

  const k1 = 1.5;
  const b = 0.75;
  return documents
    .map((document) => {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = document.frequencies.get(term) || 0;
        if (frequency === 0) continue;
        const df = documentFrequency.get(term) || 0;
        const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
        const lengthRatio = document.terms.length / Math.max(1, averageLength);
        score +=
          idf *
          ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * lengthRatio)));
      }
      return { page: document.page, score };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.page - b.page);
}

function addPageWithinBudget(
  selected: Map<number, string>,
  pageTexts: ReadonlyMap<number, string>,
  page: number,
  maxChars: number
): void {
  if (selected.has(page)) return;
  const text = pageTexts.get(page)?.trim();
  if (!text) return;

  const used = [...selected.entries()].reduce(
    (total, [number, value]) => total + formatPage(number, value).length + 2,
    0
  );
  const remaining = maxChars - used;
  const labelLength = formatPage(page, '').length;
  if (remaining <= labelLength + 1) return;

  const allowedTextLength = remaining - labelLength;
  selected.set(page, text.slice(0, allowedTextLength));
}

export function buildDocumentContext(options: BuildContextOptions): DocumentContextResult {
  const pages = getPages(options.pageTexts);
  const maxChars = Math.max(1000, Math.round(options.maxChars));
  const totalChars = documentCharacterCount(pages);

  if (options.mode === 'selection') {
    const selectedText = (options.selectedText || '').trim();
    const startPage = options.selectedPage;
    const endPage = options.selectedEndPage || startPage;
    const pageDescription = startPage
      ? endPage && endPage !== startPage
        ? `pages ${Math.min(startPage, endPage)}–${Math.max(startPage, endPage)}`
        : `page ${startPage}`
      : 'the document';
    const contextText = selectedText.slice(0, maxChars);

    return {
      mode: 'selection',
      text: contextText,
      pages: startPage
        ? Array.from(
            { length: Math.max(1, (endPage || startPage) - startPage + 1) },
            (_, index) => startPage + index
          )
        : [],
      description: `only the selected passage from ${pageDescription}`,
      documentCharacterCount: totalChars,
      truncated: selectedText.length > contextText.length,
      requiresHierarchicalSummary: false,
    };
  }

  if (options.mode === 'entire') {
    if (totalChars > maxChars) {
      return {
        mode: 'entire',
        text: '',
        pages: pages.map(([page]) => page),
        description: `the entire ${pages.length}-page document`,
        documentCharacterCount: totalChars,
        truncated: false,
        requiresHierarchicalSummary: true,
      };
    }
    return {
      mode: 'entire',
      text: pages.map(([page, text]) => formatPage(page, text)).join('\n\n'),
      pages: pages.map(([page]) => page),
      description: `the entire ${pages.length}-page document`,
      documentCharacterCount: totalChars,
      truncated: false,
      requiresHierarchicalSummary: false,
    };
  }

  const selected = new Map<number, string>();
  const query = `${options.query}\n${(options.selectedText || '').slice(0, 4000)}`;
  const ranked = rankRelevantPages(options.pageTexts, query);
  const selectedPage = options.selectedPage && options.pageTexts.has(options.selectedPage)
    ? options.selectedPage
    : undefined;
  const currentPage = options.currentPage && options.pageTexts.has(options.currentPage)
    ? options.currentPage
    : undefined;

  const priorityPages: number[] = [];
  for (const result of ranked.slice(0, 8)) priorityPages.push(result.page);
  if (priorityPages.length === 0 && selectedPage) priorityPages.push(selectedPage);
  if (priorityPages.length === 0 && currentPage) priorityPages.push(currentPage);
  if (priorityPages.length === 0 && pages.length > 0) priorityPages.push(pages[0][0]);

  for (const page of priorityPages) {
    addPageWithinBudget(selected, options.pageTexts, page, maxChars);
  }

  const chosenPages = [...selected.keys()].sort((a, b) => a - b);
  const text = chosenPages.map((page) => formatPage(page, selected.get(page) || '')).join('\n\n');
  const modeDescription = `${chosenPages.length} relevant page${chosenPages.length === 1 ? '' : 's'} (${chosenPages.join(', ')})`;

  return {
    mode: options.mode,
    text,
    pages: chosenPages,
    description: modeDescription,
    documentCharacterCount: totalChars,
    truncated: text.length >= maxChars - 10,
    requiresHierarchicalSummary: false,
  };
}

export function chunkDocument(
  pageTexts: ReadonlyMap<number, string>,
  maxChars: number
): DocumentChunk[] {
  const pages = getPages(pageTexts);
  const chunkLimit = Math.max(2000, Math.floor(maxChars * 0.8));
  const chunks: DocumentChunk[] = [];
  let currentParts: string[] = [];
  let currentLength = 0;
  let startPage = 0;
  let endPage = 0;

  const flush = () => {
    if (currentParts.length === 0) return;
    chunks.push({ startPage, endPage, text: currentParts.join('\n\n') });
    currentParts = [];
    currentLength = 0;
    startPage = 0;
    endPage = 0;
  };

  for (const [page, text] of pages) {
    const formatted = formatPage(page, text);
    if (formatted.length <= chunkLimit) {
      if (currentLength > 0 && currentLength + formatted.length + 2 > chunkLimit) flush();
      if (currentParts.length === 0) startPage = page;
      currentParts.push(formatted);
      currentLength += formatted.length + 2;
      endPage = page;
      continue;
    }

    flush();
    const labelReserve = 40;
    const sliceSize = Math.max(1000, chunkLimit - labelReserve);
    const partCount = Math.ceil(text.length / sliceSize);
    for (let index = 0; index < partCount; index++) {
      const part = text.slice(index * sliceSize, (index + 1) * sliceSize);
      chunks.push({
        startPage: page,
        endPage: page,
        text: `--- Page ${page} (part ${index + 1} of ${partCount}) ---\n${part}`,
      });
    }
  }
  flush();
  return chunks;
}

export function groupTextsWithinBudget(texts: string[], maxChars: number): string[][] {
  const limit = Math.max(2000, Math.floor(maxChars * 0.8));
  const groups: string[][] = [];
  let group: string[] = [];
  let length = 0;

  for (const text of texts) {
    if (group.length > 0 && length + text.length + 2 > limit) {
      groups.push(group);
      group = [];
      length = 0;
    }
    group.push(text.slice(0, limit));
    length += Math.min(text.length, limit) + 2;
  }
  if (group.length > 0) groups.push(group);
  return groups;
}

export function buildContextSystemPrompt(
  contextText: string,
  description: string,
  customInstructions: string = ''
): string {
  const instructions = customInstructions.trim();
  const customSection = instructions
    ? `\n\n──── USER CUSTOM INSTRUCTIONS ────\n${instructions}\n──── END USER CUSTOM INSTRUCTIONS ────`
    : '';
  return `You are Lexio, an intelligent PDF reading assistant. You help users understand the currently open document.

The document context below contains ${description}. Answer only from the supplied context and the conversation. When relevant, cite the page numbers shown in the context. If the supplied context does not support an answer, say what information is missing instead of guessing or hallucinating. Format responses with readable markdown.${customSection}

──── DOCUMENT CONTEXT ────
${contextText}
──── END DOCUMENT CONTEXT ────`;
}
