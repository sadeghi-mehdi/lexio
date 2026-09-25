import { estimateTokens } from './context-budget.ts';
import { isWholeDocumentRequest } from './document-context.ts';
import { EMBEDDING_DIMENSIONS, similarity } from './embeddings.ts';
import { searchPassages, type DocumentIndex } from './text-index.ts';

// Decides what document text a question sends to the model, for one or many
// PDFs, within a token budget.

export interface ScopeDocument {
  // Short label used in citations, such as "D1".
  label: string;
  index: DocumentIndex;
  // Embedding vectors end to end, one per window (see embeddingWindows), and
  // the passage each window belongs to.
  vectors?: Float32Array | null;
  windowPassages?: ArrayLike<number> | null;
}

// A passage by document label and position in that document's passages.
export interface PassageRef {
  label: string;
  passage: number;
}

export interface ContextBlock {
  label: string;
  key: string;
  page: number;
  section: string;
  text: string;
}

export type RetrievalStrategy = 'full' | 'search' | 'compare' | 'overview';

export interface RetrievalResult {
  strategy: RetrievalStrategy;
  // The labeled document text for the system prompt.
  text: string;
  // Every page block that was sent, for citation checks and the status line.
  blocks: ContextBlock[];
  description: string;
  // Labels of the documents the question was narrowed to (all in scope if none named).
  scope: string[];
  // True when a whole-document request did not fit; a single document can then
  // be summarized in several steps by the caller.
  wholeDocumentRequest: boolean;
}

export interface RetrievalOptions {
  documents: ScopeDocument[];
  question: string;
  budgetTokens: number;
  queryVector?: Float32Array | null;
  // Extra text for the keyword and meaning search, such as the previous
  // question when this one is a follow-up.
  searchContext?: string;
  // More rankings to merge, best first (for example passages the user marked).
  extraRankings?: PassageRef[][];
  // Passages that should be included first, up to reservedShare of the budget
  // (for example what the previous answer used).
  priority?: PassageRef[];
  reservedShare?: number;
  // Turns a block's text into what the model sees (for example with the
  // user's markings wrapped in tags).
  decorate?: (block: ContextBlock) => string;
}

const COMPARISON = /\b(?:compare|comparison|contrast|differ(?:s|ence|ences|ent)?|versus|vs\.?|each (?:paper|document|study|pdf|report|article)|all (?:the )?(?:papers|documents|studies|pdfs|reports|articles)|both|across (?:the )?(?:papers|documents|studies)|similarit(?:y|ies)|in common)\b/i;

// Characters of outline shown per document in the list of documents.
const OUTLINE_CHARS = 700;
// Share of the keyword score in the blend when meaning scores are available.
const KEYWORD_WEIGHT = 0.6;
// Largest bonus from an extra ranking (the top of that list).
const EXTRA_WEIGHT = 0.25;
// Passages below this blended score are not worth sending.
const MIN_SCORE = 0.05;

export function retrieveContext(options: RetrievalOptions): RetrievalResult {
  // A question can name documents by label ("D2", "@D2") or by file name.
  const question = options.question;
  const named = options.documents.filter((document) => {
    const label = new RegExp(`(?:^|[^\\w])@?${document.label}\\b`, 'i');
    const baseName = document.index.name.replace(/\.pdf$/i, '').toLowerCase();
    return label.test(question) || (baseName.length >= 4 && question.toLowerCase().includes(baseName));
  });
  const documents = named.length > 0 ? named : options.documents;
  const budget = Math.max(500, options.budgetTokens);
  const byLabel = new Map(documents.map((document) => [document.label, document]));

  const pageBlock = (document: ScopeDocument, page: number, text: string, section = ''): ContextBlock => ({
    label: document.label,
    key: document.index.key,
    page,
    section,
    text,
  });

  // 1. Everything fits: send the full text. Nothing can be missed, and the
  // text stays identical across turns, which lets providers cache it.
  const fullBlocks = documents.flatMap((document) =>
    [...document.index.pages.entries()]
      .filter(([, text]) => text.trim())
      .map(([page, text]) => pageBlock(document, page, text.trim()))
  );
  const fullTokens = fullBlocks.reduce((total, block) => total + estimateTokens(block.text) + 8, 0);
  if (fullTokens <= budget) {
    return finish('full', fullBlocks, false);
  }

  const wholeDocument = isWholeDocumentRequest(question);
  const comparison = documents.length > 1 && COMPARISON.test(question);

  // 2. Rank passages by a weighted blend of keyword and meaning scores.
  // Keyword (BM25) scores are divided by the best score. Meaning scores are
  // measured from the median passage: a passage no closer to the question
  // than a typical one scores 0, the closest scores 1. Averaging the two
  // keeps exact matches ("Table 3", names, numbers) on top while letting
  // paraphrases through; plain rank fusion let passages that were merely
  // decent in both lists outrank exact matches.
  const rank = (docs: ScopeDocument[]): PassageRef[] => {
    const scores = new Map<string, { ref: PassageRef; keyword: number; meaning: number; extra: number }>();
    const entry = (ref: PassageRef) => {
      const id = `${ref.label}:${ref.passage}`;
      let value = scores.get(id);
      if (!value) {
        value = { ref, keyword: 0, meaning: 0, extra: 0 };
        scores.set(id, value);
      }
      return value;
    };

    const labelOf = new Map(docs.map((document) => [document.index, document.label]));
    const passageNumber = new Map<object, number>();
    for (const document of docs) document.index.passages.forEach((passage, number) => passageNumber.set(passage, number));
    const hits = searchPassages(docs.map((document) => document.index), `${question}\n${options.searchContext || ''}`, 120);
    const bestKeyword = hits[0]?.score || 1;
    for (const hit of hits) {
      entry({ label: labelOf.get(hit.index)!, passage: passageNumber.get(hit.passage)! }).keyword = hit.score / bestKeyword;
    }

    let hasMeaning = false;
    if (options.queryVector) {
      // A passage's similarity is that of its best window.
      const all = new Map<string, { ref: PassageRef; score: number }>();
      for (const document of docs) {
        const windows = document.windowPassages;
        if (!document.vectors || !windows || document.vectors.length !== windows.length * EMBEDDING_DIMENSIONS) continue;
        for (let window = 0; window < windows.length; window++) {
          const score = similarity(options.queryVector, document.vectors, window * EMBEDDING_DIMENSIONS);
          const id = `${document.label}:${windows[window]}`;
          const current = all.get(id);
          if (!current || score > current.score) all.set(id, { ref: { label: document.label, passage: windows[window] }, score });
        }
      }
      if (all.size > 0) {
        hasMeaning = true;
        const sorted = [...all.values()].map((item) => item.score).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const best = sorted[sorted.length - 1];
        for (const item of all.values()) {
          const meaning = best > median ? (item.score - median) / (best - median) : 0;
          if (meaning > 0) entry(item.ref).meaning = meaning;
        }
      }
    }

    // Extra rankings (such as passages the user marked) add a bonus that
    // shrinks with their position in the list.
    const labels = new Set(docs.map((document) => document.label));
    for (const extra of options.extraRankings || []) {
      const list = extra.filter((ref) => labels.has(ref.label));
      list.forEach((ref, position) => {
        entry(ref).extra = Math.max(entry(ref).extra, EXTRA_WEIGHT * (1 - position / Math.max(1, list.length)));
      });
    }

    const keywordWeight = hasMeaning ? KEYWORD_WEIGHT : 1;
    return [...scores.values()]
      .map((value) => ({
        ref: value.ref,
        score: keywordWeight * value.keyword + (1 - keywordWeight) * value.meaning + value.extra,
      }))
      .filter((value) => value.score > MIN_SCORE)
      .sort((a, b) => b.score - a.score)
      .map((value) => value.ref);
  };

  // Section starts spread over the document, for whole-document questions
  // that match no particular passage.
  const overview = (document: ScopeDocument): PassageRef[] => {
    const refs: PassageRef[] = [];
    let lastSection: string | null = null;
    document.index.passages.forEach((passage, number) => {
      if (passage.section !== lastSection) refs.push({ label: document.label, passage: number });
      lastSection = passage.section;
    });
    if (refs.length < 3) {
      const step = Math.max(1, Math.floor(document.index.passages.length / 8));
      for (let number = 0; number < document.index.passages.length; number += step) refs.push({ label: document.label, passage: number });
    }
    return refs;
  };

  // 3. Pack passages best first until the budget is used, then add each
  // chosen passage's neighbors so sentences that continue across a passage
  // boundary are not cut off.
  const chosen = new Map<string, PassageRef>();
  let used = 0;
  const cost = (ref: PassageRef) => estimateTokens(byLabel.get(ref.label)!.index.passages[ref.passage].text) + 12;
  const add = (ref: PassageRef, limit: number) => {
    const id = `${ref.label}:${ref.passage}`;
    const passage = byLabel.get(ref.label)?.index.passages[ref.passage];
    if (!passage || chosen.has(id)) return false;
    const tokens = cost(ref);
    if (used + tokens > limit) return false;
    chosen.set(id, ref);
    used += tokens;
    return true;
  };

  const reserved = Math.floor(budget * (options.reservedShare ?? 0.3));
  for (const ref of options.priority || []) {
    if (byLabel.has(ref.label)) add(ref, reserved);
  }

  let strategy: RetrievalStrategy;
  if (comparison || (wholeDocument && documents.length > 1)) {
    // Equal shares, so every document is represented.
    strategy = comparison ? 'compare' : 'overview';
    const share = Math.floor((budget - used) / documents.length);
    for (const document of documents) {
      const start = used;
      const ranked = wholeDocument ? overview(document) : rank([document]);
      for (const ref of ranked.length ? ranked : overview(document)) add(ref, Math.min(budget, start + share));
    }
  } else if (wholeDocument) {
    strategy = 'overview';
    for (const ref of overview(documents[0])) add(ref, budget);
  } else {
    strategy = 'search';
    const ranked = rank(documents);
    // No document may take more than 70% of the budget while others also
    // match, so a long report cannot crowd out a short paper.
    const perDocument = new Map<string, number>();
    const matchedDocuments = new Set(ranked.slice(0, 10).map((ref) => ref.label));
    const cap = matchedDocuments.size > 1 ? budget * 0.7 : budget;
    for (const ref of ranked.length ? ranked : overview(documents[0])) {
      const cost0 = cost(ref);
      if ((perDocument.get(ref.label) || 0) + cost0 > cap) continue;
      if (add(ref, budget)) perDocument.set(ref.label, (perDocument.get(ref.label) || 0) + cost0);
    }
  }
  for (const ref of [...chosen.values()]) {
    for (const neighbor of [ref.passage + 1, ref.passage - 1]) add({ label: ref.label, passage: neighbor }, budget);
  }

  // Group by document in scope order, then by position, and merge passages
  // from the same page into one block.
  const blocks: ContextBlock[] = [];
  for (const document of documents) {
    const numbers = [...chosen.values()]
      .filter((ref) => ref.label === document.label)
      .map((ref) => ref.passage)
      .sort((a, b) => a - b);
    for (const number of numbers) {
      const passage = document.index.passages[number];
      const previous = blocks[blocks.length - 1];
      if (previous && previous.label === document.label && previous.page === passage.page) {
        previous.text += `\n${passage.text}`;
      } else {
        blocks.push(pageBlock(document, passage.page, passage.text, passage.section));
      }
    }
  }
  return finish(strategy, blocks, wholeDocument && documents.length === 1);

  function finish(chosenStrategy: RetrievalStrategy, finalBlocks: ContextBlock[], summarize: boolean): RetrievalResult {
    const header = ['Documents in scope:'];
    for (const document of documents) {
      header.push(`${document.label}: ${document.index.name} (${document.index.pageCount} pages)`);
      if (chosenStrategy !== 'full' && document.index.outline.length > 0) {
        let outline = '';
        for (const entry of document.index.outline) {
          const item = `${'  '.repeat(entry.depth)}${entry.title} (p.${entry.page})`;
          if (outline.length + item.length > OUTLINE_CHARS) break;
          outline += `\n  ${item}`;
        }
        header.push(`  Outline:${outline}`);
      }
    }
    const body: string[] = [];
    let currentLabel = '';
    for (const block of finalBlocks) {
      if (block.label !== currentLabel) {
        currentLabel = block.label;
        body.push(`=== ${block.label}: ${byLabel.get(block.label)!.index.name} ===`);
      }
      body.push(`[${block.label} p.${block.page}${block.section ? ` · ${block.section}` : ''}]\n${options.decorate ? options.decorate(block) : block.text}`);
    }
    const pagesByLabel = new Map<string, number[]>();
    for (const block of finalBlocks) {
      const pages = pagesByLabel.get(block.label) || [];
      if (!pages.includes(block.page)) pages.push(block.page);
      pagesByLabel.set(block.label, pages);
    }
    const describePages = (pages: number[]) => {
      const sorted = [...pages].sort((a, b) => a - b);
      const ranges: string[] = [];
      for (let index = 0; index < sorted.length; index++) {
        let end = index;
        while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
        ranges.push(end > index ? `${sorted[index]}-${sorted[end]}` : `${sorted[index]}`);
        index = end;
      }
      return `${sorted.length === 1 ? 'p.' : 'pp.'} ${ranges.join(', ')}`;
    };
    const description = chosenStrategy === 'full'
      ? `the full text of ${documents.map((document) => document.label).join(', ')}`
      : [...pagesByLabel.entries()].map(([label, pages]) => `${label} ${describePages(pages)}`).join('; ');
    return {
      strategy: chosenStrategy,
      text: `${header.join('\n')}\n\n${body.join('\n\n')}`,
      blocks: finalBlocks,
      description,
      scope: documents.map((document) => document.label),
      wholeDocumentRequest: summarize,
    };
  }
}
