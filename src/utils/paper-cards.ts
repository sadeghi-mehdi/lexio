import { parseJsonObject } from './json-extract.ts';

// A short structured summary of one document, made by the model during a
// cross-document analysis and cached by file hash and model. Comparison
// questions and the tools in deep mode reuse it instead of rereading the
// whole document.

export const CARD_VERSION = 1;

export interface PaperCard {
  version: number;
  model: string;
  generatedAt: number;
  title: string;
  authors: string;
  year: string;
  question: string;
  method: string;
  data: string;
  findings: Array<{ text: string; pages: number[] }>;
  limitations: string;
  futureWork: string;
}

export const CARD_SCHEMA = `{
  "title": "document title",
  "authors": "authors, as printed",
  "year": "publication year, or empty",
  "question": "research question or purpose",
  "method": "method or approach",
  "data": "data, sample or materials",
  "findings": [{"text": "one key finding with numbers", "pages": [3]}],
  "limitations": "limitations the authors state",
  "futureWork": "future work the authors state"
}`;

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// Validates a model's card JSON. Unknown or missing fields become empty;
// page numbers outside the document are dropped.
export function normalizeCard(raw: unknown, model: string, pageCount: number): PaperCard | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const source = raw as Record<string, unknown>;
  const findings = (Array.isArray(source.findings) ? source.findings : [])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      text: text(item.text, 600),
      pages: (Array.isArray(item.pages) ? item.pages : [])
        .map(Number)
        .filter((page) => Number.isInteger(page) && page >= 1 && page <= pageCount)
        .slice(0, 6),
    }))
    .filter((item) => item.text)
    .slice(0, 8);
  const card: PaperCard = {
    version: CARD_VERSION,
    model,
    generatedAt: Date.now(),
    title: text(source.title, 300),
    authors: text(source.authors, 300),
    year: text(source.year, 10),
    question: text(source.question, 800),
    method: text(source.method, 800),
    data: text(source.data, 600),
    findings,
    limitations: text(source.limitations, 800),
    futureWork: text(source.futureWork, 800),
  };
  return card.title || card.method || findings.length ? card : null;
}

// The per-document answer of an analysis: {"card": {...}, "answer": "..."}.
// If the model did not return JSON, its whole reply is the answer.
export function parseDocumentReply(reply: string, model: string, pageCount: number): { card: PaperCard | null; answer: string } {
  try {
    const parsed = parseJsonObject(reply) as Record<string, unknown>;
    const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
    return { card: normalizeCard(parsed.card, model, pageCount), answer: answer || reply.trim() };
  } catch {
    return { card: null, answer: reply.trim() };
  }
}

// Compact card text for a prompt, with page citations for findings.
export function cardText(card: PaperCard, label: string): string {
  const lines = [
    `${label}: ${card.title || '(untitled)'}${card.authors ? ` · ${card.authors}` : ''}${card.year ? ` (${card.year})` : ''}`,
    card.question && `  Question: ${card.question}`,
    card.method && `  Method: ${card.method}`,
    card.data && `  Data: ${card.data}`,
    ...card.findings.map((finding) => `  Finding: ${finding.text}${finding.pages.length ? ` [${finding.pages.map((page) => `${label} p.${page}`).join('; ')}]` : ''}`),
    card.limitations && `  Limitations (stated by the authors): ${card.limitations}`,
    card.futureWork && `  Future work (stated by the authors): ${card.futureWork}`,
  ];
  return lines.filter(Boolean).join('\n');
}
