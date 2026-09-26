import type { AIProviderInterface } from '../providers/ai-providers.ts';
import type { DocumentTabSession } from '../stores/useStore.ts';
import type {
  AppSettings,
  ChatConversation,
  ChatMessage,
  ContextSource,
  ConversationDocument,
  NoteReference,
  ProviderConfig,
} from '../types.ts';
import {
  buildHistory,
  buildWorkspacePrompt,
  decorateBlock,
  isFollowUp,
  locateMarks,
  markingsIndex,
  markRanking,
} from './chat-memory.ts';
import { requestBudget } from './context-budget.ts';
import { chunkDocument, groupTextsWithinBudget } from './document-context.ts';
import { requestProviderText } from './provider-request.ts';
import { retrieveContext, type PassageRef, type ScopeDocument } from './retrieval.ts';
import { CARD_SCHEMA, cardText, parseDocumentReply, type PaperCard } from './paper-cards.ts';
import type { DocumentIndex } from './text-index.ts';

// Everything a chat request needs to know about one open PDF.
export interface OpenDocument {
  tabId: string;
  key: string;
  name: string;
  ready: boolean;
  tab: Pick<DocumentTabSession, 'pageTexts' | 'highlights'>;
  index: () => DocumentIndex;
  vectors?: { vectors: Float32Array; passageOf: number[] } | null;
}

// The open documents a conversation searches: the most recently viewed ones
// ("all") or the ones the user picked ("custom"), up to the Settings limit.
// The document of a selected passage is always included.
export function documentsInScope(
  conversation: Pick<ChatConversation, 'scope'> | undefined,
  open: readonly OpenDocument[],
  maxDocuments: number,
  requiredKey?: string
): OpenDocument[] {
  const scope = conversation?.scope || { mode: 'all', keys: [] };
  let chosen = scope.mode === 'custom' ? open.filter((document) => scope.keys.includes(document.key)) : [...open];
  chosen = chosen.slice(0, Math.max(1, maxDocuments));
  if (requiredKey && !chosen.some((document) => document.key === requiredKey)) {
    const required = open.find((document) => document.key === requiredKey);
    if (required) chosen = [required, ...chosen].slice(0, Math.max(1, maxDocuments));
  }
  return chosen;
}

// Gives each new document the next free label (D1, D2, ...). Labels never
// change within a conversation, so earlier citations stay correct.
export function assignLabels(
  existing: readonly ConversationDocument[],
  documents: ReadonlyArray<{ key: string; name: string }>
): ConversationDocument[] {
  const result = [...existing];
  for (const document of documents) {
    if (result.some((item) => item.key === document.key)) continue;
    result.push({ key: document.key, name: document.name, label: `D${result.length + 1}` });
  }
  return result;
}

async function summarizeHierarchically(options: {
  pageTexts: ReadonlyMap<number, string>;
  maxChars: number;
  provider: AIProviderInterface;
  config: ProviderConfig;
  signal: AbortSignal;
  onProgress: (status: string) => void;
}): Promise<string> {
  // Map: summarize chunks of pages. Reduce: merge summaries until they fit.
  const chunks = chunkDocument(options.pageTexts, options.maxChars);
  let summaries: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    options.onProgress(`Summarizing section ${index + 1} of ${chunks.length} (pages ${chunk.startPage}-${chunk.endPage})…`);
    const summary = await requestProviderText(
      options.provider,
      [{
        id: `summary-${index}`,
        role: 'user',
        content: 'Summarize these pages faithfully. Keep methods, findings, numbers, limitations, recommendations and page numbers. Add nothing unsupported.',
        timestamp: Date.now(),
      }],
      `You summarize parts of a PDF. Pages are marked "--- Page N ---".\n\n${chunk.text}`,
      options.config,
      options.signal
    );
    summaries.push(`--- Summary of pages ${chunk.startPage}-${chunk.endPage} ---\n${summary}`);
  }
  for (let pass = 1; summaries.join('\n\n').length > Math.floor(options.maxChars * 0.8) && pass <= 6; pass++) {
    const groups = groupTextsWithinBudget(summaries, options.maxChars);
    const reduced: string[] = [];
    for (let index = 0; index < groups.length; index++) {
      options.onProgress(`Combining summaries ${index + 1} of ${groups.length}…`);
      reduced.push(await requestProviderText(
        options.provider,
        [{
          id: `reduce-${pass}-${index}`,
          role: 'user',
          content: 'Combine these summaries without losing major findings, numbers, limitations, recommendations or page numbers.',
          timestamp: Date.now(),
        }],
        groups[index].join('\n\n'),
        options.config,
        options.signal
      ));
    }
    summaries = reduced;
  }
  return summaries.join('\n\n').slice(0, options.maxChars);
}

// Builds the system prompt and history for one question. Returns what was
// sent so the answer's citations can be checked later.
export async function prepareRequest(options: {
  question: string;
  selection: { text: string; key: string; label: string; page: number; endPage: number } | null;
  conversation: ChatConversation;
  documents: readonly OpenDocument[];
  labels: readonly ConversationDocument[];
  settings: AppSettings;
  config: ProviderConfig;
  provider: AIProviderInterface;
  queryVector: (text: string) => Promise<Float32Array | null>;
  signal: AbortSignal;
  onProgress: (status: string) => void;
  // Cached paper cards, added to comparisons and overviews across documents.
  loadCard?: (key: string, model: string) => Promise<PaperCard | null>;
}): Promise<{
  systemPrompt: string;
  history: ChatMessage[];
  sources: ContextSource[];
  notes: NoteReference[];
  description: string;
}> {
  const { settings, question } = options;
  const labelOf = (key: string | undefined) => options.labels.find((item) => item.key === key)?.label;
  const budget = requestBudget(options.config, settings.maxContextChars);

  // The conversation so far, including the new question (its last message).
  const history = buildHistory(options.conversation.messages, budget.historyTokens, labelOf)
    .map((turn, index): ChatMessage => ({ id: `history-${index}`, role: turn.role, content: turn.content, timestamp: 0 }));

  const earlier = options.conversation.messages.slice(0, -1);
  const previousQuestion = [...earlier].reverse().find((message) => message.role === 'user');
  const previousAnswer = [...earlier].reverse().find((message) => message.role === 'assistant' && message.status === 'done');
  const followUp = isFollowUp(question, Boolean(previousQuestion));

  // A follow-up to a question about a selected passage keeps that passage.
  let selection = options.selection;
  if (!selection && followUp && previousQuestion?.selectedText) {
    selection = {
      text: previousQuestion.selectedText,
      key: previousQuestion.documentKey || '',
      label: labelOf(previousQuestion.documentKey) || '',
      page: previousQuestion.pageNumber || 0,
      endPage: previousQuestion.pageEndNumber || previousQuestion.pageNumber || 0,
    };
  }
  const selectionWhere = selection
    ? `${selection.label ? `${selection.label} ` : ''}${selection.endPage && selection.endPage !== selection.page ? `pp.${selection.page}-${selection.endPage}` : `p.${selection.page}`}`
    : '';

  const ready = options.documents.filter((document) => document.ready);
  const scope: Array<ScopeDocument & { key: string; highlights: OpenDocument['tab']['highlights'] }> = ready.map((document) => ({
    label: labelOf(document.key) || '?',
    key: document.key,
    index: document.index(),
    vectors: document.vectors?.vectors,
    windowPassages: document.vectors?.passageOf,
    highlights: document.tab.highlights,
  }));

  const marks = settings.includeNotes ? locateMarks(scope) : [];
  const ranking = settings.highlightWeight ? markRanking(marks, question) : { ranking: [], relevant: [] };

  let contextText = '';
  let description = '';
  let sources: ContextSource[] = [];

  if (options.selection) {
    // Ask AI on a selection sends only that passage (and the markings).
    description = `only the selected passage from ${selectionWhere}`;
    for (let page = options.selection.page; page <= (options.selection.endPage || options.selection.page); page++) {
      sources.push({ label: options.selection.label, key: options.selection.key, page });
    }
  } else if (scope.length > 0) {
    // What the previous answer used comes first for a follow-up, then
    // highlighted passages that match the question.
    const priority: PassageRef[] = [];
    if (followUp && previousAnswer?.sources) {
      for (const source of previousAnswer.sources) {
        const document = scope.find((item) => item.label === source.label);
        if (!document) continue;
        document.index.passages.forEach((passage, number) => {
          if (passage.page === source.page) priority.push({ label: document.label, passage: number });
        });
      }
    }
    if (selection) {
      const document = scope.find((item) => item.key === selection.key);
      document?.index.passages.forEach((passage, number) => {
        if (passage.page >= selection.page && passage.page <= (selection.endPage || selection.page)) {
          priority.unshift({ label: document.label, passage: number });
        }
      });
    }
    priority.push(...ranking.relevant.slice(0, 8));

    const searchContext = followUp && previousQuestion ? previousQuestion.content : '';
    const retrieval = retrieveContext({
      documents: scope,
      question,
      budgetTokens: Math.floor(budget.documentTokens * (marks.length ? 0.9 : 1)),
      queryVector: await options.queryVector(searchContext ? `${searchContext}\n${question}` : question),
      searchContext,
      extraRankings: ranking.ranking.length ? [ranking.ranking] : [],
      priority,
      reservedShare: 0.3,
      decorate: (block) => decorateBlock(block, marks, settings.colorLabels),
    });
    const onlyDocument = scope.find((document) => document.label === retrieval.scope[0]);
    const summarize = retrieval.strategy !== 'full' && retrieval.scope.length === 1 && onlyDocument &&
      (retrieval.wholeDocumentRequest || settings.contextMode === 'rawEntire');
    if (summarize) {
      const open = ready.find((document) => document.key === onlyDocument.key)!;
      description = `summaries of the whole ${open.tab.pageTexts.size}-page document ${onlyDocument.label}, made in several steps`;
      contextText = `Documents in scope:\n${onlyDocument.label}: ${onlyDocument.index.name}\n\n${await summarizeHierarchically({
        pageTexts: open.tab.pageTexts,
        maxChars: Math.floor(budget.documentTokens * 3.5),
        provider: options.provider,
        config: options.config,
        signal: options.signal,
        onProgress: options.onProgress,
      })}`;
      sources = [...open.tab.pageTexts.keys()].map((page) => ({ label: onlyDocument.label, key: onlyDocument.key, page }));
    } else {
      contextText = retrieval.text;
      description = retrieval.description;
      sources = retrieval.blocks.map((block) => ({ label: block.label, key: block.key, page: block.page }));
      if ((retrieval.strategy === 'compare' || retrieval.strategy === 'overview') && retrieval.scope.length > 1 && options.loadCard) {
        const cardBlocks: string[] = [];
        for (const label of retrieval.scope) {
          const document = scope.find((item) => item.label === label);
          const card = document ? await options.loadCard(document.key, options.config.model) : null;
          if (!card || !document) continue;
          cardBlocks.push(cardText(card, label));
          for (const finding of card.findings) {
            for (const page of finding.pages) sources.push({ label, key: document.key, page });
          }
        }
        if (cardBlocks.length) {
          contextText = `Paper cards (summaries made earlier from these documents):\n${cardBlocks.join('\n\n')}\n\n${contextText}`;
          description += ` and ${cardBlocks.length} paper cards`;
        }
      }
    }
  }

  // Markings: the list of all markings in scope (most relevant first), plus
  // every marking whose page was sent (those appear inline in the text).
  const markingBudget = Math.min(6000, Math.floor(budget.documentTokens * 3.5 * 0.1));
  const markingList = markingsIndex(marks, question, markingBudget, settings.colorLabels);
  const sentPages = new Set(sources.map((source) => `${source.label}:${source.page}`));
  const sentMarks = marks.filter((mark) => markingList.refs.includes(mark) || sentPages.has(`${mark.label}:${mark.page}`));
  const notes: NoteReference[] = sentMarks.map((mark) => ({
    ref: mark.ref,
    label: mark.label,
    key: mark.documentKey,
    page: mark.page,
    highlightId: mark.highlight.id,
  }));

  const systemPrompt = buildWorkspacePrompt({
    contextText: contextText || '(No document text for this question beyond the selected passage.)',
    description: description || 'no document text',
    markings: markingList.text,
    selection: selection ? { text: selection.text, where: selectionWhere } : null,
    customInstructions: settings.customInstructions,
  });
  return { systemPrompt, history, sources, notes, description };
}

// ─── Cross-document analysis ───

const ANALYSIS_DEFAULT_QUESTION =
  'Compare these documents: research question, method, data, main findings and limitations. Use a table, then note where they agree and differ.';

// Asks every document in scope the question on its own (each call can use
// the whole budget for one document), then builds the prompt that combines
// the per-document answers. Each per-document call also returns a paper card,
// which is cached. Costs one request per document plus the final one.
export async function prepareAnalysis(options: {
  question: string;
  conversation: ChatConversation;
  documents: readonly OpenDocument[];
  labels: readonly ConversationDocument[];
  settings: AppSettings;
  config: ProviderConfig;
  provider: AIProviderInterface;
  signal: AbortSignal;
  onProgress: (status: string) => void;
  loadCard: (key: string, model: string) => Promise<PaperCard | null>;
  saveCard: (key: string, card: PaperCard) => void;
}): Promise<{
  systemPrompt: string;
  history: ChatMessage[];
  sources: ContextSource[];
  notes: NoteReference[];
  description: string;
}> {
  const { settings, config } = options;
  const question = options.question.trim() || ANALYSIS_DEFAULT_QUESTION;
  const labelOf = (key: string | undefined) => options.labels.find((item) => item.key === key)?.label;
  const budget = requestBudget(config, settings.maxContextChars);
  const ready = options.documents.filter((document) => document.ready);
  const sources: ContextSource[] = [];
  const notes: NoteReference[] = [];
  const perDocument: string[] = [];
  const cards: string[] = [];

  for (let position = 0; position < ready.length; position++) {
    const open = ready[position];
    const label = labelOf(open.key) || `D${position + 1}`;
    options.onProgress(`Reading ${label} (${position + 1} of ${ready.length}): ${open.name}`);
    const document = { label, key: open.key, index: open.index(), vectors: open.vectors?.vectors, windowPassages: open.vectors?.passageOf };
    const marks = settings.includeNotes ? locateMarks([{ ...document, highlights: open.tab.highlights }]) : [];
    const ranking = settings.highlightWeight ? markRanking(marks, question) : { ranking: [], relevant: [] };
    const retrieval = retrieveContext({
      documents: [document],
      question,
      budgetTokens: Math.floor(budget.documentTokens * 0.9),
      extraRankings: ranking.ranking.length ? [ranking.ranking] : [],
      priority: ranking.relevant.slice(0, 8),
      decorate: (block) => decorateBlock(block, marks, settings.colorLabels),
    });
    const markingList = markingsIndex(marks, question, 3000, settings.colorLabels);
    const cached = await options.loadCard(open.key, config.model);
    const reply = await requestProviderText(
      options.provider,
      [{
        id: `analysis-${label}`,
        role: 'user',
        content: `Question for this document: ${question}\n\nReturn JSON only:\n{\n  "answer": "the answer for this document alone, citing pages as [${label} p.N] and the user's markings as [${label} N1]; say plainly when the document does not address the question",\n  "card": ${cached ? 'null' : CARD_SCHEMA}\n}`,
        timestamp: Date.now(),
      }],
      buildWorkspacePrompt({
        contextText: retrieval.text,
        description: retrieval.description,
        markings: markingList.text,
        customInstructions: settings.customInstructions,
      }),
      config,
      options.signal
    );
    const parsed = parseDocumentReply(reply, config.model, document.index.pageCount);
    const sentPages = new Set(retrieval.blocks.map((block) => block.page));
    if (!cached && parsed.card) {
      // A new card keeps only page references to pages this call was shown,
      // so its citations are checked once, when it is made.
      for (const finding of parsed.card.findings) finding.pages = finding.pages.filter((page) => sentPages.has(page));
      options.saveCard(open.key, parsed.card);
    }
    const card = cached || parsed.card;
    if (card) cards.push(cardText(card, label));
    perDocument.push(`──── ${label}: ${open.name} ────\n${parsed.answer}`);
    sources.push(...retrieval.blocks.map((block) => ({ label, key: open.key, page: block.page })));
    for (const finding of card?.findings || []) {
      for (const page of finding.pages) if (!sentPages.has(page)) sources.push({ label, key: open.key, page });
    }
    notes.push(...marks.map((mark) => ({ ref: mark.ref, label, key: open.key, page: mark.page, highlightId: mark.highlight.id })));
  }

  options.onProgress(`Combining ${ready.length} documents…`);
  const history = buildHistory(options.conversation.messages, budget.historyTokens, labelOf)
    .map((turn, index): ChatMessage => ({ id: `history-${index}`, role: turn.role, content: turn.content, timestamp: 0 }));
  // The final question replaces an empty one with the default comparison.
  if (history.length && history[history.length - 1].role === 'user' && !options.question.trim()) {
    history[history.length - 1] = { ...history[history.length - 1], content: question };
  }
  const instructions = settings.customInstructions.trim();
  const systemPrompt = `You are Lexio, a reading assistant. You are combining separate analyses of ${ready.length} documents (labeled D1, D2, ...) into one answer to the user's question.

Use only the per-document analyses and paper cards below. Keep their citations ([D1 p.3], [D2 N4]) exactly as given and cite every claim. Do not invent citations.
Compare the documents directly: where they agree, where they differ, and why (method, data, setting). Use a markdown table when comparing several documents on the same aspects.
If the question asks about research gaps, separate two kinds and label them:
1. Limitations and future work the authors state, with citations.
2. Topics that none of these ${ready.length} documents cover, marked "not covered in these ${ready.length} documents". Never present these as gaps in the whole field; the user has only loaded these documents.
The user's own notes (quoted as notes by "you") are the user's opinions, never the authors' claims.${instructions ? `\n\n──── USER CUSTOM INSTRUCTIONS ────\n${instructions}\n──── END USER CUSTOM INSTRUCTIONS ────` : ''}

──── PAPER CARDS ────
${cards.join('\n\n') || '(none)'}
──── END PAPER CARDS ────

──── PER-DOCUMENT ANALYSES ────
${perDocument.join('\n\n')}
──── END PER-DOCUMENT ANALYSES ────`;
  return {
    systemPrompt,
    history,
    sources,
    notes,
    description: `a separate reading of each of ${ready.length} documents (${ready.map((document) => labelOf(document.key)).join(', ')})`,
  };
}
