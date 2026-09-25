import type { ChatMessage, Highlight, HighlightColor } from '../types.ts';
import { estimateTokens } from './context-budget.ts';
import type { ContextBlock, PassageRef } from './retrieval.ts';
import { tokenize, type DocumentIndex } from './text-index.ts';

// Conversation memory and the user's markings as context for the model.

// ─── Follow-up questions ───

const CONNECTOR = /^(?:and|but|so|also|then|what about|how about|why|why not|how come|elaborate|more|explain (?:that|this|it|why)|continue|go on|what else|can you|could you|and what|what if)\b/i;
const REFERENCE = /\b(?:it|its|this|that|these|those|they|them|their|there|he|she|his|her|the (?:first|second|third|last|former|latter|same|above|previous|other) (?:one|ones|point|method|paper|study|result|table|figure|approach)?|above|previous|earlier)\b/i;

// A question that only makes sense with the previous turn: short, starting
// with a connector ("and why?", "what about the second one?"), or pointing
// back with a pronoun ("how does it compare?").
export function isFollowUp(question: string, hasHistory: boolean): boolean {
  if (!hasHistory) return false;
  const text = question.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 4) return true;
  if (CONNECTOR.test(text)) return true;
  return words <= 15 && REFERENCE.test(text);
}

// ─── History ───

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Oldest answers are cut to this length when the history is long.
const OLD_ANSWER_CHARS = 1500;

// Builds the conversation history sent with a request:
// - error, stopped and progress messages are left out;
// - a question about a selected passage carries that passage and its page,
//   so a later "explain this" still knows what "this" was;
// - user and assistant turns alternate (some APIs reject two in a row);
// - the newest turns are kept word for word; older ones are shortened or
//   dropped when the history budget is used up.
export function buildHistory(
  messages: readonly ChatMessage[],
  budgetTokens: number,
  labelOf: (key: string | undefined) => string | undefined = () => undefined
): HistoryMessage[] {
  const usable = messages.filter((message) =>
    message.role !== 'system' &&
    message.content.trim() &&
    (message.role === 'user' || !message.status || message.status === 'done')
  );

  const turns: HistoryMessage[] = [];
  for (const message of usable) {
    let content = message.content;
    if (message.role === 'user' && message.selectedText) {
      const label = labelOf(message.documentKey);
      const pages = message.pageNumber
        ? message.pageEndNumber && message.pageEndNumber !== message.pageNumber
          ? `pp.${message.pageNumber}-${message.pageEndNumber}`
          : `p.${message.pageNumber}`
        : '';
      const where = [label, pages].filter(Boolean).join(' ');
      content = `Selected passage${where ? ` (${where})` : ''}:\n"${message.selectedText.trim()}"\n\n${content}`;
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const previous = turns[turns.length - 1];
    if (previous && previous.role === role) previous.content += `\n\n${content}`;
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();

  // Walk back from the newest turn. The last turn (the question being asked)
  // is always kept.
  const kept: HistoryMessage[] = [];
  let used = 0;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = { ...turns[index] };
    const isNewest = index === turns.length - 1;
    let tokens = estimateTokens(turn.content);
    if (!isNewest && used + tokens > budgetTokens && turn.role === 'assistant' && turn.content.length > OLD_ANSWER_CHARS) {
      turn.content = `${turn.content.slice(0, OLD_ANSWER_CHARS)}… [answer shortened]`;
      tokens = estimateTokens(turn.content);
    }
    if (!isNewest && used + tokens > budgetTokens) break;
    kept.unshift(turn);
    used += tokens;
  }
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept;
}

// ─── Markings (highlights, underlines, strikethroughs, comments) ───

export const DEFAULT_COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: 'important',
  green: 'use in my work',
  blue: 'method or definition',
  pink: 'disagree or question',
  orange: 'follow up',
};

export interface LocatedMark {
  // Short id for this request, such as "N3". Citations of notes use it.
  ref: string;
  highlight: Highlight;
  label: string;
  documentKey: string;
  page: number;
  // Position of the marked text in the index's page text, when found.
  start: number;
  end: number;
  passage: number;
}

// Text with whitespace and hyphens removed, and for each remaining character
// its position in the original. PDF text, the index (hyphens rejoined,
// spaces collapsed) and a selection (line breaks as \n) differ only in
// these characters, so the compact forms can be compared directly.
function compact(text: string): { chars: string; positions: number[] } {
  let chars = '';
  const positions: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (/[\s\-‐‑­]/.test(char)) continue;
    chars += char.toLowerCase();
    positions.push(index);
  }
  return { chars, positions };
}

// Finds each marking in its document's page text and the passage it falls
// in. Marks are numbered N1, N2, ... in document and page order.
export function locateMarks(
  documents: ReadonlyArray<{ label: string; index: DocumentIndex; highlights: readonly Highlight[] }>
): LocatedMark[] {
  const marks: LocatedMark[] = [];
  for (const document of documents) {
    const sorted = [...document.highlights].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
    for (const highlight of sorted) {
      const pageText = document.index.pages.get(highlight.page) || '';
      const haystack = compact(pageText);
      const needle = compact(highlight.text).chars;
      let start = -1;
      let end = -1;
      const at = needle ? haystack.chars.indexOf(needle) : -1;
      if (at >= 0) {
        start = haystack.positions[at];
        end = haystack.positions[at + needle.length - 1] + 1;
      }
      // The passage containing the start of the mark (or the page's first).
      const onPage = document.index.passages
        .map((passage, number) => ({ passage, number }))
        .filter(({ passage }) => passage.page === highlight.page);
      const containing = onPage.filter(({ passage }) => start >= 0 && passage.start <= start).pop() || onPage[0];
      marks.push({
        ref: '',
        highlight,
        label: document.label,
        documentKey: document.index.key,
        page: highlight.page,
        start,
        end,
        passage: containing ? containing.number : -1,
      });
    }
  }
  marks.forEach((mark, index) => { mark.ref = `N${index + 1}`; });
  return marks;
}

// How much a marking should lift its passage. Strikethrough means the user
// considered the text wrong or irrelevant, so it gets no boost.
function markWeight(mark: LocatedMark): number {
  if (mark.highlight.type === 'strikeout') return 0;
  if (mark.highlight.type === 'highlight' || mark.highlight.type === 'underline') return mark.highlight.comment ? 3 : 2;
  return 1;
}

// Passages with markings, most relevant to the question first, for the
// retrieval's extra ranking. Relevance is the number of question terms in
// the marked text and its comment, then the marking's weight.
export function markRanking(marks: readonly LocatedMark[], question: string): { ranking: PassageRef[]; relevant: PassageRef[] } {
  const terms = new Set(tokenize(question));
  const scored = marks
    .filter((mark) => mark.passage >= 0 && markWeight(mark) > 0)
    .map((mark) => {
      const words = tokenize(`${mark.highlight.text} ${mark.highlight.comment || ''}`);
      const overlap = words.filter((word) => terms.has(word)).length;
      return { ref: { label: mark.label, passage: mark.passage }, overlap, weight: markWeight(mark) };
    })
    .sort((a, b) => b.overlap - a.overlap || b.weight - a.weight);
  const seen = new Set<string>();
  const unique = scored.filter((item) => {
    const id = `${item.ref.label}:${item.ref.passage}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    ranking: unique.map((item) => item.ref),
    relevant: unique.filter((item) => item.overlap > 0).map((item) => item.ref),
  };
}

const escapeAttribute = (text: string) => text.replace(/"/g, "'").replace(/[<>]/g, '');

// Wraps marked text inside a block sent to the model:
//   <mark id="N3" color="yellow" label="important">...</mark>
//   <note for="N3" by="you">comment</note>
// Underlines use <u>, strikethroughs <del>. Marks whose text cannot be found
// in this block are listed in the markings index only.
export function decorateBlock(
  block: ContextBlock,
  marks: readonly LocatedMark[],
  colorLabels: Record<HighlightColor, string> = DEFAULT_COLOR_LABELS
): string {
  const onPage = marks.filter((mark) => mark.label === block.label && mark.page === block.page);
  if (onPage.length === 0) return block.text;
  const haystack = compact(block.text);
  const spans: Array<{ start: number; end: number; mark: LocatedMark }> = [];
  for (const mark of onPage) {
    const needle = compact(mark.highlight.text).chars;
    const at = needle ? haystack.chars.indexOf(needle) : -1;
    if (at < 0) continue;
    const start = haystack.positions[at];
    const end = haystack.positions[at + needle.length - 1] + 1;
    if (spans.some((span) => start < span.end && end > span.start)) continue;
    spans.push({ start, end, mark });
  }
  spans.sort((a, b) => b.start - a.start);
  let text = block.text;
  for (const { start, end, mark } of spans) {
    const { highlight } = mark;
    const tag = highlight.type === 'strikeout' ? 'del' : highlight.type === 'underline' ? 'u' : 'mark';
    const label = colorLabels[highlight.color];
    const attributes = `id="${mark.ref}" color="${highlight.color}"${label ? ` label="${escapeAttribute(label)}"` : ''}`;
    const note = highlight.comment?.trim()
      ? `<note for="${mark.ref}" by="${escapeAttribute(highlight.author || 'you')}">${highlight.comment.trim()}</note>`
      : '';
    text = `${text.slice(0, start)}<${tag} ${attributes}>${text.slice(start, end)}</${tag}>${note}${text.slice(end)}`;
  }
  return text;
}

// Compact list of all markings in scope, most relevant first, within a
// character budget. It tells the model what the user marked even where the
// surrounding text was not sent.
export function markingsIndex(
  marks: readonly LocatedMark[],
  question: string,
  budgetChars: number,
  colorLabels: Record<HighlightColor, string> = DEFAULT_COLOR_LABELS
): { text: string; refs: LocatedMark[] } {
  if (marks.length === 0 || budgetChars < 200) return { text: '', refs: [] };
  const terms = new Set(tokenize(question));
  const ordered = [...marks].sort((a, b) => {
    const score = (mark: LocatedMark) =>
      tokenize(`${mark.highlight.text} ${mark.highlight.comment || ''}`).filter((word) => terms.has(word)).length;
    return score(b) - score(a) || a.label.localeCompare(b.label) || a.page - b.page;
  });
  const lines: string[] = [];
  const refs: LocatedMark[] = [];
  let used = 0;
  for (const mark of ordered) {
    const { highlight } = mark;
    const kind = highlight.type === 'strikeout' ? 'struck through' : highlight.type === 'underline' ? 'underlined' : 'highlighted';
    const label = colorLabels[highlight.color];
    const quote = highlight.text.replace(/\s+/g, ' ').trim();
    const line = `${mark.ref} ${mark.label} p.${mark.page} ${kind} (${highlight.color}${label ? `: ${label}` : ''}): "${quote.length > 240 ? `${quote.slice(0, 240)}…` : quote}"${
      highlight.comment?.trim() ? ` · note by ${highlight.author || 'you'}: "${highlight.comment.trim()}"` : ''
    }`;
    if (used + line.length > budgetChars) break;
    lines.push(line);
    refs.push(mark);
    used += line.length + 1;
  }
  return { text: lines.join('\n'), refs };
}

// ─── System prompt ───

export function buildWorkspacePrompt(options: {
  contextText: string;
  description: string;
  markings: string;
  selection?: { text: string; where: string } | null;
  customInstructions: string;
}): string {
  const instructions = options.customInstructions.trim();
  const custom = instructions
    ? `\n\n──── USER CUSTOM INSTRUCTIONS ────\n${instructions}\n──── END USER CUSTOM INSTRUCTIONS ────`
    : '';
  const selection = options.selection
    ? `\n\n──── SELECTED PASSAGE (${options.selection.where}) ────\n${options.selection.text}\n──── END SELECTED PASSAGE ────`
    : '';
  const markings = options.markings
    ? `\n\n──── USER'S MARKINGS ────\n${options.markings}\n──── END USER'S MARKINGS ────`
    : '';
  return `You are Lexio, a reading assistant for the user's open PDF documents. The documents are labeled D1, D2, and so on.

The document context below contains ${options.description}. Answer only from it, the selected passage and the conversation. If they do not support an answer, say what is missing instead of guessing.

Citations: cite every claim taken from a document as [D1 p.3], or [D1 pp.3-4] for a range, using only the labels and page numbers shown in the context. Cite the user's markings as [D2 N4]. Never cite a page that is not in the context.

The user's markings: text in <mark> is what the user highlighted as important; prefer it when it is relevant and point it out. <u> is underlined by the user. <del> is text the user struck through as wrong, outdated or irrelevant; it is still the authors' text. <note> is the user's own comment: treat it as the user's opinion and never attribute it to the authors. A color label (for example label="disagree or question") says what the user meant by that color.

Format answers with readable markdown. Use a table when comparing documents.${custom}${selection}${markings}

──── DOCUMENT CONTEXT ────
${options.contextText}
──── END DOCUMENT CONTEXT ────`;
}
