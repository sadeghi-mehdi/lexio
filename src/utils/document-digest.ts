import type {
  AIProvider,
  DigestPageEntry,
  DigestSection,
  DigestTopic,
  DocumentDigest,
  PageRange,
} from '../types';
import { rankRelevantPages } from './document-context.ts';

export const DOCUMENT_DIGEST_VERSION = 2;

export interface DigestFragment {
  overview: string;
  sections: Omit<DigestSection, 'id'>[];
  topics: DigestTopic[];
  pages: DigestPageEntry[];
}

export interface DigestRetrievalResult {
  text: string;
  description: string;
  ranges: PageRange[];
  confidence: 'high' | 'medium' | 'low';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampPage(value: unknown, pageCount: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(pageCount, Math.round(parsed)));
}

function stringArray(value: unknown, maximum = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  )].slice(0, maximum);
}

function normalizeType(value: unknown): DigestSection['sectionType'] {
  return ['chapter', 'appendix', 'references', 'body', 'other'].includes(String(value))
    ? (value as DigestSection['sectionType'])
    : 'other';
}

export async function fingerprintPdf(base64Data: string): Promise<string> {
  const bytes = Uint8Array.from(atob(base64Data), (character) => character.charCodeAt(0));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function parseJsonObject(text: string): unknown {
  const cleaned = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    for (let start = cleaned.indexOf('{'); start >= 0; start = cleaned.indexOf('{', start + 1)) {
      for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
        try {
          return JSON.parse(cleaned.slice(start, end + 1));
        } catch {
          // Try the next balanced-looking candidate.
        }
      }
    }
  }
  throw new Error('The digest model did not return a valid JSON object.');
}

export function normalizeDigestFragment(
  raw: unknown,
  pageCount: number,
  fallbackRange: PageRange
): DigestFragment {
  const source = isRecord(raw) ? raw : {};
  const rawSections = Array.isArray(source.sections) ? source.sections : [];
  const clampToFragment = (value: unknown, fallback: number) => {
    const page = clampPage(value, pageCount, fallback);
    return Math.max(fallbackRange.startPage, Math.min(fallbackRange.endPage, page));
  };
  const sections = rawSections
    .filter(isRecord)
    .map((section) => {
      const startPage = clampToFragment(section.startPage, fallbackRange.startPage);
      const endPage = Math.max(
        startPage,
        clampToFragment(section.endPage, fallbackRange.endPage)
      );
      return {
        title: typeof section.title === 'string' && section.title.trim()
          ? section.title.trim().slice(0, 200)
          : `Pages ${startPage}–${endPage}`,
        startPage,
        endPage,
        summary: typeof section.summary === 'string' ? section.summary.trim().slice(0, 6000) : '',
        keywords: stringArray(section.keywords),
        entities: stringArray(section.entities),
        sectionType: normalizeType(section.sectionType),
      };
    })
    .filter((section) => section.summary.length > 0);

  if (sections.length === 0) {
    sections.push({
      title: `Pages ${fallbackRange.startPage}–${fallbackRange.endPage}`,
      ...fallbackRange,
      summary: typeof source.overview === 'string' ? source.overview.trim().slice(0, 6000) : '',
      keywords: [],
      entities: [],
      sectionType: 'body',
    });
  }

  const topics = (Array.isArray(source.topics) ? source.topics : [])
    .filter(isRecord)
    .map((topic) => ({
      name: typeof topic.name === 'string' ? topic.name.trim().slice(0, 160) : '',
      description: typeof topic.description === 'string'
        ? topic.description.trim().slice(0, 1000)
        : '',
      pageRanges: (Array.isArray(topic.pageRanges) ? topic.pageRanges : [])
        .filter(isRecord)
        .map((range) => {
          const startPage = clampToFragment(range.startPage, fallbackRange.startPage);
          return {
            startPage,
            endPage: Math.max(startPage, clampToFragment(range.endPage, startPage)),
          };
        }),
    }))
    .filter((topic) => topic.name && topic.pageRanges.length > 0)
    .slice(0, 30);

  const pages = (Array.isArray(source.pages) ? source.pages : [])
    .filter(isRecord)
    .map((page): DigestPageEntry => ({
      pageNumber: clampToFragment(page.pageNumber, fallbackRange.startPage),
      headings: stringArray(page.headings, 12),
      sectionTitle: typeof page.sectionTitle === 'string' ? page.sectionTitle.trim().slice(0, 200) : '',
      keywords: stringArray(page.keywords, 20),
      description: typeof page.description === 'string' ? page.description.trim().slice(0, 600) : '',
    }))
    .filter((page) => page.headings.length > 0 || page.sectionTitle || page.keywords.length > 0 || page.description)
    .filter((page, index, all) => all.findIndex((candidate) => candidate.pageNumber === page.pageNumber) === index)
    .sort((a, b) => a.pageNumber - b.pageNumber);

  return {
    overview: typeof source.overview === 'string' ? source.overview.trim().slice(0, 6000) : '',
    sections,
    topics,
    pages,
  };
}

function normalizedLabel(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function consolidateDigestFragments(
  fragments: DigestFragment[],
  metadata: {
    fingerprint: string;
    documentName: string;
    pageCount: number;
    providerId: AIProvider;
    model: string;
    overview?: string;
  }
): DocumentDigest {
  const ordered = fragments.flatMap((fragment) => fragment.sections).sort(
    (a, b) => a.startPage - b.startPage || a.endPage - b.endPage
  );
  const sections: DigestSection[] = [];

  for (const section of ordered) {
    const previous = sections[sections.length - 1];
    const sameTitle = previous && normalizedLabel(previous.title) === normalizedLabel(section.title);
    if (previous && sameTitle && section.startPage <= previous.endPage + 1) {
      previous.endPage = Math.max(previous.endPage, section.endPage);
      if (!previous.summary.includes(section.summary)) previous.summary += ` ${section.summary}`;
      previous.keywords = [...new Set([...previous.keywords, ...section.keywords])].slice(0, 30);
      previous.entities = [...new Set([...previous.entities, ...section.entities])].slice(0, 30);
      continue;
    }
    sections.push({
      ...section,
      id: `section-${sections.length + 1}-${section.startPage}-${section.endPage}`,
    });
  }

  const topicMap = new Map<string, DigestTopic>();
  for (const topic of fragments.flatMap((fragment) => fragment.topics)) {
    const key = normalizedLabel(topic.name);
    const existing = topicMap.get(key);
    if (existing) {
      existing.pageRanges = mergePageRanges([...existing.pageRanges, ...topic.pageRanges]);
      if (topic.description.length > existing.description.length) existing.description = topic.description;
    } else {
      topicMap.set(key, { ...topic, pageRanges: mergePageRanges(topic.pageRanges) });
    }
  }

  const pageMap = new Map<number, DigestPageEntry>();
  for (const page of fragments.flatMap((fragment) => fragment.pages)) {
    const existing = pageMap.get(page.pageNumber);
    if (!existing) {
      pageMap.set(page.pageNumber, { ...page });
      continue;
    }
    existing.headings = [...new Set([...existing.headings, ...page.headings])].slice(0, 12);
    existing.keywords = [...new Set([...existing.keywords, ...page.keywords])].slice(0, 20);
    if (page.sectionTitle.length > existing.sectionTitle.length) existing.sectionTitle = page.sectionTitle;
    if (page.description.length > existing.description.length) existing.description = page.description;
  }

  return {
    version: DOCUMENT_DIGEST_VERSION,
    documentFingerprint: metadata.fingerprint,
    documentName: metadata.documentName,
    pageCount: metadata.pageCount,
    generatedAt: Date.now(),
    providerId: metadata.providerId,
    model: metadata.model,
    overview: (metadata.overview || fragments.map((fragment) => fragment.overview).filter(Boolean).join(' ')).slice(0, 12000),
    majorTopics: [...topicMap.values()].slice(0, 50),
    sections,
    pages: [...pageMap.values()].sort((a, b) => a.pageNumber - b.pageNumber),
  };
}

export function validateDocumentDigest(
  raw: unknown,
  fingerprint?: string,
  pageCount?: number
): DocumentDigest | null {
  if (!isRecord(raw) || raw.version !== DOCUMENT_DIGEST_VERSION) return null;
  if (typeof raw.documentFingerprint !== 'string' || typeof raw.documentName !== 'string') return null;
  if (fingerprint && raw.documentFingerprint !== fingerprint) return null;
  if (pageCount && Number(raw.pageCount) !== pageCount) return null;
  const storedPageCount = Number(raw.pageCount);
  if (!Number.isInteger(storedPageCount) || storedPageCount < 1) return null;
  if (!Array.isArray(raw.sections) || typeof raw.overview !== 'string') return null;
  const validSection = (section: unknown) => {
    if (!isRecord(section)) return false;
    const startPage = Number(section.startPage);
    const endPage = Number(section.endPage);
    return typeof section.id === 'string' &&
      typeof section.title === 'string' &&
      typeof section.summary === 'string' &&
      Number.isInteger(startPage) &&
      Number.isInteger(endPage) &&
      startPage >= 1 &&
      endPage >= startPage &&
      endPage <= storedPageCount &&
      Array.isArray(section.keywords) &&
      Array.isArray(section.entities);
  };
  if (!raw.sections.every(validSection)) return null;
  if (!Array.isArray(raw.majorTopics) || !Array.isArray(raw.pages)) return null;
  const validPage = (page: unknown) => {
    if (!isRecord(page)) return false;
    const pageNumber = Number(page.pageNumber);
    return Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= storedPageCount &&
      Array.isArray(page.headings) && Array.isArray(page.keywords) &&
      typeof page.sectionTitle === 'string' && typeof page.description === 'string';
  };
  if (!raw.pages.every(validPage)) return null;
  return raw as unknown as DocumentDigest;
}

const INDEX_STOP_WORDS = new Set([
  'about', 'after', 'also', 'and', 'are', 'been', 'being', 'but', 'can', 'could',
  'does', 'for', 'from', 'have', 'into', 'more', 'not', 'only', 'page', 'pages',
  'that', 'the', 'their', 'these', 'this', 'those', 'was', 'were', 'what', 'when',
  'where', 'which', 'with', 'would', 'your',
]);

function fallbackPageEntry(pageNumber: number, text: string): DigestPageEntry {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headings = lines.filter((line) =>
    line.length <= 160 && (/[A-Z]{3}/.test(line) || /^\d+(?:\.\d+)*\s+/.test(line))
  ).slice(0, 8);
  const frequencies = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (token.length < 4 || INDEX_STOP_WORDS.has(token)) continue;
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }
  const keywords = [...frequencies.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([token]) => token);
  return {
    pageNumber,
    headings,
    sectionTitle: '',
    keywords,
    description: lines.join(' ').slice(0, 360),
  };
}

export function completeDigestPageIndex(
  digest: DocumentDigest,
  pageTexts: ReadonlyMap<number, string>
): DocumentDigest {
  const generated = new Map(digest.pages.map((page) => [page.pageNumber, page]));
  const pages: DigestPageEntry[] = [];
  for (const [pageNumber, text] of [...pageTexts.entries()].sort(([a], [b]) => a - b)) {
    if (!text.trim()) continue;
    const fallback = fallbackPageEntry(pageNumber, text);
    const existing = generated.get(pageNumber);
    const containingSection = digest.sections.find(
      (section) => pageNumber >= section.startPage && pageNumber <= section.endPage
    );
    pages.push({
      pageNumber,
      headings: existing?.headings.length ? existing.headings : fallback.headings,
      sectionTitle: existing?.sectionTitle || containingSection?.title || '',
      keywords: existing?.keywords.length ? existing.keywords.slice(0, 20) : fallback.keywords,
      description: existing?.description || fallback.description,
    });
  }
  return { ...digest, pages };
}

export function mergePageRanges(ranges: PageRange[]): PageRange[] {
  const sorted = ranges
    .map((range) => ({
      startPage: Math.min(range.startPage, range.endPage),
      endPage: Math.max(range.startPage, range.endPage),
    }))
    .sort((a, b) => a.startPage - b.startPage || a.endPage - b.endPage);
  const merged: PageRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startPage <= previous.endPage + 1) {
      previous.endPage = Math.max(previous.endPage, range.endPage);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [];
}

function scoreSection(section: DigestSection, query: string): number {
  const normalizedQuery = normalizedLabel(query);
  const title = normalizedLabel(section.title);
  const queryTerms = [...new Set(tokenize(query))];
  let score = 0;
  if (title && normalizedQuery.includes(title)) score += 30;
  if (normalizedQuery && title.includes(normalizedQuery)) score += 20;
  const fields = [
    { text: title, weight: 6 },
    { text: normalizedLabel(section.keywords.join(' ')), weight: 4 },
    { text: normalizedLabel(section.entities.join(' ')), weight: 3 },
    { text: normalizedLabel(section.summary), weight: 1 },
  ];
  for (const term of queryTerms) {
    for (const field of fields) {
      if (field.text.split(' ').includes(term)) score += field.weight;
      else if (term.length >= 4 && field.text.includes(term)) score += field.weight * 0.4;
    }
  }
  return score;
}

function scoreTopic(topic: DigestTopic, query: string): number {
  const normalizedQuery = normalizedLabel(query);
  const name = normalizedLabel(topic.name);
  const description = normalizedLabel(topic.description);
  const queryTerms = [...new Set(tokenize(query))];
  let score = 0;
  if (name && normalizedQuery.includes(name)) score += 24;
  if (normalizedQuery && name.includes(normalizedQuery)) score += 16;
  for (const term of queryTerms) {
    if (name.split(' ').includes(term)) score += 6;
    else if (term.length >= 4 && name.includes(term)) score += 2;
    if (description.split(' ').includes(term)) score += 2;
    else if (term.length >= 4 && description.includes(term)) score += 0.5;
  }
  return score;
}

function scorePage(page: DigestPageEntry, query: string): number {
  const normalizedQuery = normalizedLabel(query);
  const headings = normalizedLabel(page.headings.join(' '));
  const sectionTitle = normalizedLabel(page.sectionTitle);
  const keywords = normalizedLabel(page.keywords.join(' '));
  const description = normalizedLabel(page.description);
  const queryTerms = [...new Set(tokenize(query))];
  let score = 0;
  if (sectionTitle && normalizedQuery.includes(sectionTitle)) score += 28;
  if (headings && page.headings.some((heading) => normalizedQuery.includes(normalizedLabel(heading)))) score += 24;
  for (const term of queryTerms) {
    if (sectionTitle.split(' ').includes(term)) score += 8;
    if (headings.split(' ').includes(term)) score += 7;
    if (keywords.split(' ').includes(term)) score += 5;
    if (description.split(' ').includes(term)) score += 2;
  }
  return score;
}

function formatRange(range: PageRange): string {
  return range.startPage === range.endPage
    ? `${range.startPage}`
    : `${range.startPage}–${range.endPage}`;
}

function formatOriginalPages(
  pageTexts: ReadonlyMap<number, string>,
  ranges: PageRange[],
  budget: number
): string {
  let text = '';
  for (const range of ranges) {
    for (let page = range.startPage; page <= range.endPage; page++) {
      const pageText = pageTexts.get(page)?.trim();
      if (!pageText) continue;
      const formatted = `--- Page ${page} ---\n${pageText}\n\n`;
      if (text.length + formatted.length > budget) {
        const remaining = budget - text.length;
        if (remaining > 100) text += formatted.slice(0, remaining);
        return text.trim();
      }
      text += formatted;
    }
  }
  return text.trim();
}

export function retrieveDigestContext(options: {
  digest: DocumentDigest;
  pageTexts: ReadonlyMap<number, string>;
  query: string;
  maxChars: number;
  maxRanges: number;
}): DigestRetrievalResult {
  const indexMatches = [
    ...options.digest.sections.map((section) => ({
      label: section.title,
      summary: section.summary,
      ranges: [{ startPage: section.startPage, endPage: section.endPage }],
      score: scoreSection(section, options.query),
    })),
    ...options.digest.majorTopics.map((topic) => ({
      label: topic.name,
      summary: topic.description,
      ranges: topic.pageRanges,
      score: scoreTopic(topic, options.query),
    })),
    ...options.digest.pages.map((page) => ({
      label: page.sectionTitle || page.headings[0] || `Page ${page.pageNumber}`,
      summary: page.description,
      ranges: [{ startPage: page.pageNumber, endPage: page.pageNumber }],
      score: scorePage(page, options.query),
    })),
  ].filter((item) => item.ranges.length > 0)
    .sort((a, b) => b.score - a.score || a.ranges[0].startPage - b.ranges[0].startPage);

  const candidates = new Map<number, number>();
  const addCandidate = (page: number, score: number) => {
    candidates.set(page, Math.max(candidates.get(page) || 0, score));
  };
  for (const item of indexMatches.filter((item) => item.score > 0).slice(0, options.maxRanges * 2)) {
    for (const range of item.ranges) {
      for (let page = range.startPage; page <= range.endPage; page++) addCandidate(page, item.score);
    }
  }

  const rawMatches = rankRelevantPages(options.pageTexts, options.query);
  rawMatches.slice(0, Math.max(4, options.maxRanges * 2)).forEach((match, index) => {
    addCandidate(match.page, Math.max(2, 12 - index));
  });

  if (candidates.size === 0) {
    const firstPage = [...options.pageTexts.entries()]
      .sort(([a], [b]) => a - b)
      .find(([, text]) => text.trim())?.[0];
    if (firstPage) addCandidate(firstPage, 1);
  }

  const selectedPages = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, Math.max(1, options.maxRanges))
    .map(([page]) => page);
  const expanded = new Set<number>();
  for (const page of selectedPages) {
    const section = options.digest.sections.find(
      (candidate) => page >= candidate.startPage && page <= candidate.endPage && candidate.sectionType !== 'body'
    );
    if (section) {
      for (let current = section.startPage; current <= section.endPage; current++) expanded.add(current);
    } else {
      for (const current of [page - 1, page, page + 1]) {
        if (options.pageTexts.has(current)) expanded.add(current);
      }
    }
  }
  const ranges = mergePageRanges([...expanded].sort((a, b) => a - b).map((page) => ({
    startPage: page,
    endPage: page,
  }))).slice(0, options.maxRanges);
  const originals = formatOriginalPages(options.pageTexts, ranges, options.maxChars);
  const best = Math.max(0, ...candidates.values());
  const confidence = best >= 20 ? 'high' : best >= 5 ? 'medium' : 'low';

  return {
    text: originals,
    description: `index-guided original pages ${ranges.map(formatRange).join(', ')} (${confidence} confidence)`,
    ranges,
    confidence,
  };
}

export async function loadCachedDigest(fingerprint: string): Promise<DocumentDigest | null> {
  if (window.electronAPI) {
    return validateDocumentDigest(await window.electronAPI.loadDigest(fingerprint), fingerprint);
  }
  try {
    return validateDocumentDigest(JSON.parse(localStorage.getItem(`lexio-digest-${fingerprint}`) || 'null'), fingerprint);
  } catch {
    return null;
  }
}

export async function saveCachedDigest(digest: DocumentDigest): Promise<void> {
  if (window.electronAPI) {
    await window.electronAPI.saveDigest(digest.documentFingerprint, digest);
    return;
  }
  localStorage.setItem(`lexio-digest-${digest.documentFingerprint}`, JSON.stringify(digest));
}

export async function deleteCachedDigest(fingerprint: string): Promise<void> {
  if (!fingerprint) return;
  if (window.electronAPI) {
    await window.electronAPI.deleteDigest(fingerprint);
    return;
  }
  localStorage.removeItem(`lexio-digest-${fingerprint}`);
}
