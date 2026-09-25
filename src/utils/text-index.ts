// Search index for extracted PDF text: one tokenizer for all ranking,
// passages of about 1,200 characters tagged with page and section, and
// BM25 keyword ranking that works across several documents at once.

export interface Passage {
  page: number;
  // Character offset of the passage in the page's dehyphenated text.
  start: number;
  section: string;
  text: string;
  terms: Map<string, number>;
  length: number;
}

export interface OutlineEntry {
  title: string;
  page: number;
  depth: number;
}

export interface DocumentIndex {
  key: string;
  name: string;
  pageCount: number;
  // Page text with line-break hyphens rejoined. This is the text the model sees.
  pages: Map<number, string>;
  outline: OutlineEntry[];
  passages: Passage[];
  // Number of passages containing each term, for BM25 across documents.
  documentFrequency: Map<string, number>;
  totalLength: number;
}

export interface SearchHit {
  index: DocumentIndex;
  passage: Passage;
  score: number;
}

const STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at', 'be',
  'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'doing', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her',
  'here', 'hers', 'him', 'his', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'may',
  'me', 'might', 'more', 'most', 'much', 'must', 'my', 'no', 'nor', 'not', 'of', 'off', 'on', 'once',
  'only', 'or', 'other', 'our', 'ours', 'out', 'over', 'own', 'please', 'same', 'she', 'should', 'so',
  'some', 'such', 'than', 'that', 'the', 'their', 'theirs', 'them', 'then', 'there', 'these', 'they',
  'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would', 'you',
  'your', 'yours', 'describe', 'discuss', 'explain', 'review', 'summarize', 'summary', 'tell', 'show',
  'shown', 'shows', 'give', 'list', 'mentioned', 'reported', 'paper', 'document', 'pdf', 'report',
]);

// Words for numbered parts of a document. "Table 3" or "Appendix F" becomes
// one extra token ("ref:table:3") so the number or letter decides the match,
// not just the common word "table".
const REFERENCE_WORDS: Record<string, string> = {
  table: 'table', tab: 'table', tables: 'table',
  figure: 'figure', fig: 'figure', figures: 'figure', figs: 'figure',
  appendix: 'appendix', appendices: 'appendix',
  section: 'section', sec: 'section', sections: 'section',
  chapter: 'chapter', ch: 'chapter',
  equation: 'equation', eq: 'equation', eqs: 'equation',
  step: 'step', stage: 'stage', phase: 'phase', part: 'part',
};

// Chinese, Japanese and Korean scripts have no spaces between words.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');

  for (const match of lower.matchAll(
    /\b(tables?|tab|figures?|figs?|fig|appendix|appendices|sections?|sec|chapter|ch|equations?|eqs?|step|stage|phase|part)\.?\s*(\d+(?:\.\d+)*[a-z]?|[a-z](?![a-z]))/gu
  )) {
    tokens.push(`ref:${REFERENCE_WORDS[match[1]]}:${match[2]}`);
  }

  // CJK runs become overlapping two-character pieces ("車輪荷重" gives
  // 車輪, 輪荷, 荷重), which match regardless of where words start.
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = [...match[0]];
    if (run.length === 1) tokens.push(run[0]);
    for (let index = 0; index + 1 < run.length; index++) tokens.push(run[index] + run[index + 1]);
  }

  // Latin and other spaced scripts. Hyphenated words give their parts and the
  // joined form, so "micro-surfacing" matches "micro surfacing" and
  // "microsurfacing". Decimals such as 0.873 stay whole.
  const spaced = lower.replace(CJK_RUN, ' ');
  for (const match of spaced.matchAll(/[\p{L}\p{N}]+(?:[.'][\p{N}]+)*(?:-[\p{L}\p{N}]+)*/gu)) {
    const word = match[0];
    const parts = word.includes('-') ? [...word.split('-'), word.replace(/-/g, '')] : [word];
    for (const part of parts) {
      const numeric = /^\p{N}/u.test(part);
      if (!numeric && part.length < 2) continue;
      if (STOP_WORDS.has(part)) continue;
      tokens.push(numeric ? part : stem(part));
    }
  }
  return tokens;
}

// Light suffix stripping so plurals and a few common forms match. Both the
// question and the documents go through it, so it only has to be consistent.
function stem(word: string): string {
  if (/^method(?:s|ology|ologies|ological)?$/.test(word)) return 'method';
  if (/^procedur(?:e|es|al)$/.test(word)) return 'method';
  if (/^experiment(?:s|al|ation)?$/.test(word)) return 'experiment';
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

// PDF text breaks words at line ends with a hyphen ("rehabili-\ntation").
// Rejoin only when the next line starts in lower case, so real compounds that
// happen to end a line ("pre-\nCambrian") keep their hyphen.
export function dehyphenate(text: string): string {
  return text.replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2');
}

interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
  transform?: number[];
}

// Page text and headings from pdf.js text content. The text matches what the
// viewer always extracted (items joined by spaces, line ends as newlines), so
// Find and existing offsets keep working. Headings are lines set in a larger
// font than the page's body text, or short numbered lines such as
// "2.3 Methodology".
export function pageTextFromItems(items: readonly unknown[]): { text: string; headings: string[] } {
  const lines: Array<{ text: string; size: number; chars: number }> = [];
  let current = { text: '', size: 0, chars: 0 };
  for (const raw of items) {
    const item = raw as TextItemLike;
    const str = item.str || '';
    const size = item.transform ? Math.hypot(item.transform[2], item.transform[3]) : 0;
    current.text += `${str}${item.hasEOL ? '' : ' '}`;
    if (str.trim()) {
      current.size = Math.max(current.size, size);
      current.chars += str.length;
    }
    if (item.hasEOL) {
      lines.push(current);
      current = { text: '', size: 0, chars: 0 };
    }
  }
  if (current.text.trim()) lines.push(current);

  const text = lines.map((line) => line.text).join('\n').replace(/[ \t]+\n/g, '\n').trim();

  // Body size is the font size that covers the most characters on the page.
  const charsBySize = new Map<number, number>();
  for (const line of lines) {
    const rounded = Math.round(line.size * 2) / 2;
    charsBySize.set(rounded, (charsBySize.get(rounded) || 0) + line.chars);
  }
  const bodySize = [...charsBySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
  const headings = lines
    .map((line) => ({ ...line, text: line.text.replace(/\s+/g, ' ').trim() }))
    .filter((line) => {
      if (line.text.length < 3 || line.text.length > 120 || !/\p{L}{2}/u.test(line.text)) return false;
      if (/[.,;:]$/.test(line.text) && !/^\d+(?:\.\d+)*\.?\s/.test(line.text)) return false;
      const larger = bodySize > 0 && line.size >= bodySize * 1.15;
      const numbered = /^(?:\d+(?:\.\d+)*\.?|[A-Z]\.|Appendix\s+[A-Z0-9]+[.:]?)\s+\p{Lu}/u.test(line.text) &&
        line.text.length <= 80;
      return larger || numbered;
    })
    .map((line) => line.text)
    .slice(0, 12);
  return { text, headings };
}

// Numbered or well-known heading lines in plain text, for pages whose font
// sizes are unknown (text restored from the cache before headings were saved).
function headingsFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length >= 3 && line.length <= 80 && (
      /^(?:\d+(?:\.\d+)*\.?|Appendix\s+[A-Z0-9]+[.:]?)\s+\p{Lu}[^.!?]*$/u.test(line) ||
      /^(?:abstract|introduction|background|methods?|methodology|results|discussion|conclusions?|references|acknowledg(?:e)?ments?)$/i.test(line)
    ))
    .slice(0, 12);
}

const TARGET_PASSAGE = 1200;
const MAX_PASSAGE = 1800;

export function buildDocumentIndex(options: {
  key: string;
  name: string;
  pageTexts: ReadonlyMap<number, string>;
  headings?: ReadonlyMap<number, string[]>;
  outline?: OutlineEntry[];
}): DocumentIndex {
  const pages = new Map<number, string>();
  const passages: Passage[] = [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  let section = '';
  const sortedPages = [...options.pageTexts.entries()].sort(([a], [b]) => a - b);

  // Section titles come from the PDF's own outline when it has one. Detected
  // headings are the fallback; lines repeated on three or more pages are
  // running headers ("D. Zhang et al. / Journal 57 (2017) 131"), not headings.
  const useOutline = (options.outline || []).length > 0;
  const headingKey = (line: string) => line.toLowerCase().replace(/[\d\s]+/g, ' ').trim();
  const headingCounts = new Map<string, number>();
  for (const [page, text] of sortedPages) {
    for (const line of options.headings?.get(page) ?? headingsFromText(text)) {
      headingCounts.set(headingKey(line), (headingCounts.get(headingKey(line)) || 0) + 1);
    }
  }

  for (const [page, rawText] of sortedPages) {
    const text = dehyphenate(rawText);
    pages.set(page, text);
    if (!text.trim()) continue;

    // Section starts on this page: outline entries first, then headings.
    const starts: Array<{ at: number; title: string }> = [];
    const titles = useOutline
      ? (options.outline || []).filter((entry) => entry.page === page).map((entry) => entry.title)
      : (options.headings?.get(page) ?? headingsFromText(text))
          .filter((line) => (headingCounts.get(headingKey(line)) || 0) < 3);
    for (const title of titles) {
      const at = text.indexOf(title);
      starts.push({ at: at >= 0 ? at : 0, title });
    }
    starts.sort((a, b) => a.at - b.at);

    // Pack sentences into passages. A passage never crosses a page, so every
    // passage cites exactly one page. Sentences longer than the maximum are
    // cut at the last space before it.
    // A sentence ends at . ! ? followed by whitespace (so decimals such as
    // 0.873 stay whole) or at a CJK full stop.
    const sentences = (text.match(/[\s\S]*?(?:[.!?]+["'”’)\]]*(?=\s)|[。！？]|$)\s*/gu) || [text])
      .filter((sentence) => sentence.length > 0);
    let passageStart = 0;
    let passageText = '';
    let offset = 0;
    const flush = () => {
      const trimmed = passageText.trim();
      if (trimmed) {
        for (const start of starts) if (start.at <= passageStart + 20) section = start.title;
        const terms = new Map<string, number>();
        const tokens = tokenize(`${trimmed}`);
        for (const token of tokens) terms.set(token, (terms.get(token) || 0) + 1);
        for (const term of terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
        passages.push({ page, start: passageStart, section, text: trimmed, terms, length: tokens.length });
        totalLength += tokens.length;
      }
      passageText = '';
    };
    for (let sentence of sentences) {
      while (sentence.length > MAX_PASSAGE) {
        const cut = sentence.lastIndexOf(' ', MAX_PASSAGE) > 0 ? sentence.lastIndexOf(' ', MAX_PASSAGE) : MAX_PASSAGE;
        if (passageText) flush();
        passageStart = offset;
        passageText = sentence.slice(0, cut);
        flush();
        offset += cut;
        sentence = sentence.slice(cut);
      }
      if (passageText && passageText.length + sentence.length > TARGET_PASSAGE) flush();
      if (!passageText) passageStart = offset;
      passageText += sentence;
      offset += sentence.length;
    }
    flush();
    // A section that starts late on the page applies to the following pages.
    if (starts.length > 0) section = starts[starts.length - 1].title;
  }

  return {
    key: options.key,
    name: options.name,
    pageCount: sortedPages.length ? sortedPages[sortedPages.length - 1][0] : 0,
    pages,
    outline: options.outline || [],
    passages,
    documentFrequency,
    totalLength,
  };
}

// BM25 over the passages of all given documents, as if they were one
// collection: term rarity and average passage length are computed across
// every document in scope, so scores from different PDFs are comparable.
export function searchPassages(indexes: readonly DocumentIndex[], query: string, limit = 60): SearchHit[] {
  const queryTerms = [...new Set(tokenize(query))];
  const passageCount = indexes.reduce((total, index) => total + index.passages.length, 0);
  if (queryTerms.length === 0 || passageCount === 0) return [];
  const averageLength = indexes.reduce((total, index) => total + index.totalLength, 0) / passageCount;
  const idf = new Map(queryTerms.map((term) => {
    const df = indexes.reduce((total, index) => total + (index.documentFrequency.get(term) || 0), 0);
    return [term, Math.log(1 + (passageCount - df + 0.5) / (df + 0.5))];
  }));

  const k1 = 1.2;
  const b = 0.75;
  const hits: SearchHit[] = [];
  for (const index of indexes) {
    for (const passage of index.passages) {
      let score = 0;
      for (const term of queryTerms) {
        const frequency = passage.terms.get(term);
        if (!frequency) continue;
        const norm = 1 - b + b * (passage.length / Math.max(1, averageLength));
        score += (idf.get(term) || 0) * ((frequency * (k1 + 1)) / (frequency + k1 * norm));
      }
      if (score > 0) hits.push({ index, passage, score });
    }
  }
  return hits.sort((a, b) => b.score - a.score || a.passage.page - b.passage.page).slice(0, limit);
}

// Indexes are rebuilt only when a document's page text, headings or outline
// change. The store replaces the page map on every change, so the map itself
// is the cache key.
const indexCache = new WeakMap<
  ReadonlyMap<number, string>,
  { index: DocumentIndex; headings: unknown; outline: unknown }
>();

export function getDocumentIndex(options: Parameters<typeof buildDocumentIndex>[0]): DocumentIndex {
  const cached = indexCache.get(options.pageTexts);
  if (
    cached &&
    cached.index.key === options.key &&
    cached.headings === options.headings &&
    cached.outline === options.outline
  ) {
    return cached.index;
  }
  const index = buildDocumentIndex(options);
  indexCache.set(options.pageTexts, { index, headings: options.headings, outline: options.outline });
  return index;
}
