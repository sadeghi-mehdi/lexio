import type { ChatMessage, ConversationDocument } from '../types.ts';

// Turns citations in an answer ([D1 p.3], [D1 pp.3-4], [D2 N4],
// [D1 p.3; D2 p.7]) into clickable chips. A chip is marked unverified when
// the cited page or note was not in the text sent for that answer, which
// catches citations the model made up.

interface Citation {
  label: string;
  page?: number;
  endPage?: number;
  note?: string;
}

function parseCitation(inner: string): Citation[] | null {
  const citations: Citation[] = [];
  let label = '';
  for (const raw of inner.split(/\s*[;,]\s*/)) {
    const part = raw.trim();
    if (!part) continue;
    const match = part.match(/^(?:(D\d+)\s*)?(?:(?:pp?\.|pages?)\s*(\d+)(?:\s*[-–]\s*(\d+))?|(N\d+))$/i);
    if (!match) return null;
    label = match[1]?.toUpperCase() || label;
    if (!label) return null;
    citations.push({
      label,
      page: match[2] ? Number(match[2]) : undefined,
      endPage: match[3] ? Number(match[3]) : undefined,
      note: match[4]?.toUpperCase(),
    });
  }
  return citations.length ? citations : null;
}

export function isCitationValid(citation: Citation, message: ChatMessage): boolean {
  if (citation.note) {
    return Boolean(message.notes?.some((note) => note.ref === citation.note && note.label === citation.label));
  }
  const pages = new Set((message.sources || []).filter((source) => source.label === citation.label).map((source) => source.page));
  const last = citation.endPage && citation.endPage >= (citation.page || 0) ? citation.endPage : citation.page;
  for (let page = citation.page || 0; page <= (last || 0); page++) if (pages.has(page)) return true;
  return false;
}

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Runs on already escaped HTML, so the only markup it adds is its own.
export function renderCitations(
  html: string,
  message: ChatMessage,
  documents: readonly ConversationDocument[]
): string {
  if (message.role !== 'assistant') return html;
  return html.replace(/\[((?:D\d+)[^\][\n]{0,120})\]/g, (whole, inner: string) => {
    const citations = parseCitation(inner);
    if (!citations) return whole;
    return citations.map((citation) => {
      const valid = isCitationValid(citation, message);
      const document = documents.find((item) => item.label === citation.label);
      const where = citation.note
        ? citation.note
        : citation.endPage && citation.endPage !== citation.page
          ? `pp.${citation.page}-${citation.endPage}`
          : `p.${citation.page}`;
      const title = `${document ? document.name : citation.label} · ${where}${valid ? '' : ' · not in the text sent to the model'}`;
      return `<button type="button" class="lexio-cite${valid ? '' : ' lexio-cite-unverified'}" data-label="${citation.label}"${
        citation.page ? ` data-page="${citation.page}"` : ''
      }${citation.note ? ` data-note="${citation.note}"` : ''} title="${escape(title)}">${citation.label} ${where}</button>`;
    }).join(' ');
  });
}
