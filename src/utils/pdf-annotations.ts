import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  rgb,
  type PDFPage,
} from 'pdf-lib';
import type { Highlight, HighlightColor, RelativeRect } from '../types.ts';

// Reads and writes standard PDF annotations (ISO 32000 text markup and
// text annotations), so notes made in Lexio show up in Acrobat, Preview,
// Edge, Foxit, Zotero and others, and theirs show up in Lexio.

export const LEXIO_COLORS: Record<HighlightColor, [number, number, number]> = {
  yellow: [1, 0.92, 0.23],
  green: [0.3, 0.69, 0.31],
  blue: [0.13, 0.59, 0.95],
  pink: [0.91, 0.12, 0.39],
  orange: [1, 0.6, 0],
};

const MARKUP_TYPES: Record<string, Highlight['type']> = {
  Highlight: 'highlight',
  Underline: 'underline',
  Squiggly: 'underline',
  StrikeOut: 'strikeout',
};
// Annotations with comments that are listed and kept but drawn by pdf.js.
const NOTE_TYPES = new Set(['Text', 'FreeText']);
const READ_ONLY_TYPES = new Set(['Ink', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Stamp', 'FileAttachment', 'Caret']);

// Lexio writes /NM "lexio-<highlight id>" for other tools. pdf.js does not
// expose /NM, so annotations read back from a file are all treated alike.

export function nearestColor(color: ArrayLike<number> | null | undefined): HighlightColor {
  if (!color || color.length < 3) return 'yellow';
  const scale = Math.max(color[0], color[1], color[2]) > 1 ? 255 : 1;
  const [r, g, b] = [color[0] / scale, color[1] / scale, color[2] / scale];
  let best: HighlightColor = 'yellow';
  let bestDistance = Infinity;
  for (const [name, [cr, cg, cb]] of Object.entries(LEXIO_COLORS) as Array<[HighlightColor, [number, number, number]]>) {
    const distance = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (distance < bestDistance) {
      best = name;
      bestDistance = distance;
    }
  }
  return best;
}

// "D:20260925132543-07'00'" -> milliseconds, or undefined.
export function parsePdfDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/);
  if (!match) return undefined;
  const [, year, month = '01', day = '01', hour = '00', minute = '00', second = '00', sign, offsetHours = '00', offsetMinutes = '00'] = match;
  let time = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  if (sign === '+' || sign === '-') {
    const offset = (+offsetHours * 60 + +offsetMinutes) * 60000;
    time += sign === '+' ? -offset : offset;
  }
  return Number.isFinite(time) ? time : undefined;
}

export function pdfDate(time = Date.now()): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}'${pad(Math.abs(offset) % 60)}'`;
}

// ─── Reading ───

// The subset of pdf.js page, viewport and annotation data used here.
interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
}
interface AnnotationLike {
  id: string;
  subtype: string;
  rect: number[];
  quadPoints?: ArrayLike<number> | null;
  color?: ArrayLike<number> | null;
  contentsObj?: { str?: string };
  titleObj?: { str?: string };
  creationDate?: string | null;
  modificationDate?: string | null;
  inReplyTo?: string;
  replyType?: string;
}
interface TextItemLike {
  str?: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}

// Characters of the page with an approximate center point in PDF space.
// pdf.js gives each text run's start, direction and total width; characters
// are spread evenly along it. Good enough to tell which words a highlight
// covers once partial words are snapped (see markedText).
function pageCharacters(items: readonly unknown[]): Array<{ char: string; x: number; y: number; word: number }> {
  const chars: Array<{ char: string; x: number; y: number; word: number }> = [];
  let word = 0;
  for (const raw of items) {
    const item = raw as TextItemLike;
    const text = item.str || '';
    if (!text || !item.transform) {
      word++;
      continue;
    }
    const [a, b, c, d, e, f] = item.transform;
    const scale = Math.hypot(a, b) || 1;
    const ux = a / scale;
    const uy = b / scale;
    const height = Math.hypot(c, d);
    const characters = [...text];
    const step = (item.width || 0) / Math.max(1, characters.length);
    characters.forEach((char, index) => {
      if (/\s/.test(char)) word++;
      const along = (index + 0.5) * step;
      chars.push({
        char,
        x: e + ux * along - uy * height * 0.35,
        y: f + uy * along + ux * height * 0.35,
        word,
      });
    });
    word++;
    chars.push({ char: item.hasEOL ? '\n' : ' ', x: NaN, y: NaN, word });
    word++;
  }
  return chars;
}

// Text under a markup annotation's QuadPoints. A word counts when at least
// half of its characters are inside, which hides the small position errors
// of the even character spacing above.
export function markedText(items: readonly unknown[], quadPoints: ArrayLike<number>): string {
  const boxes: Array<[number, number, number, number]> = [];
  for (let index = 0; index + 7 < quadPoints.length; index += 8) {
    const xs = [quadPoints[index], quadPoints[index + 2], quadPoints[index + 4], quadPoints[index + 6]];
    const ys = [quadPoints[index + 1], quadPoints[index + 3], quadPoints[index + 5], quadPoints[index + 7]];
    boxes.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }
  const chars = pageCharacters(items);
  const inside = chars.map((char) => boxes.some(([x0, y0, x1, y1]) => char.x >= x0 && char.x <= x1 && char.y >= y0 && char.y <= y1));
  const wordShare = new Map<number, { inside: number; total: number }>();
  chars.forEach((char, index) => {
    if (/\s/.test(char.char)) return;
    const share = wordShare.get(char.word) || { inside: 0, total: 0 };
    share.total++;
    if (inside[index]) share.inside++;
    wordShare.set(char.word, share);
  });
  let text = '';
  let pendingSpace = false;
  chars.forEach((char) => {
    if (/\s/.test(char.char)) {
      if (text) pendingSpace = true;
      return;
    }
    const share = wordShare.get(char.word)!;
    if (share.inside * 2 < share.total) {
      if (text) pendingSpace = true;
      return;
    }
    if (pendingSpace) text += ' ';
    pendingSpace = false;
    text += char.char;
  });
  return text.trim();
}

function relativeRect(viewport: ViewportLike, points: number[][]): RelativeRect {
  const converted = points.map(([x, y]) => viewport.convertToViewportPoint(x, y));
  const xs = converted.map((point) => point[0]);
  const ys = converted.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return {
    x: left / viewport.width,
    y: top / viewport.height,
    width: (Math.max(...xs) - left) / viewport.width,
    height: (Math.max(...ys) - top) / viewport.height,
  };
}

// Converts one page's annotations (from pdf.js getAnnotations) into
// Lexio's highlight list. Replies are attached to the annotation they answer.
// Grouped annotations (such as Acrobat's "replace text" caret) are skipped:
// pdf.js gives them the parent's text instead of their own.
export function readPageAnnotations(
  pageNumber: number,
  annotations: readonly AnnotationLike[],
  textItems: readonly unknown[],
  viewport: ViewportLike
): Highlight[] {
  const result = new Map<string, Highlight>();
  const replies: AnnotationLike[] = [];
  for (const annotation of annotations) {
    if (annotation.inReplyTo) {
      replies.push(annotation);
      continue;
    }
    const markup = MARKUP_TYPES[annotation.subtype];
    const note = NOTE_TYPES.has(annotation.subtype);
    const readOnly = READ_ONLY_TYPES.has(annotation.subtype);
    if (!markup && !note && !readOnly) continue;
    const comment = annotation.contentsObj?.str?.trim() || '';
    if (readOnly && !comment) continue;

    const quads = annotation.quadPoints && annotation.quadPoints.length >= 8 ? annotation.quadPoints : null;
    const rects: RelativeRect[] = [];
    if (markup && quads) {
      for (let index = 0; index + 7 < quads.length; index += 8) {
        rects.push(relativeRect(viewport, [0, 2, 4, 6].map((offset) => [quads[index + offset], quads[index + offset + 1]])));
      }
    } else {
      const [x0, y0, x1, y1] = annotation.rect;
      rects.push(relativeRect(viewport, [[x0, y0], [x1, y1]]));
    }
    const color = annotation.color && annotation.color.length >= 3
      ? [annotation.color[0] / 255, annotation.color[1] / 255, annotation.color[2] / 255] as [number, number, number]
      : undefined;
    const created = parsePdfDate(annotation.creationDate) ?? parsePdfDate(annotation.modificationDate) ?? 0;
    result.set(annotation.id, {
      id: `file-${annotation.id}`,
      page: pageNumber,
      rects,
      text: markup && quads ? markedText(textItems, quads) : '',
      color: nearestColor(color),
      type: markup || 'note',
      comment: comment || undefined,
      createdAt: created,
      modifiedAt: parsePdfDate(annotation.modificationDate),
      author: annotation.titleObj?.str?.trim() || undefined,
      source: 'file',
      pdfRef: annotation.id,
      pdfSubtype: annotation.subtype,
      pdfColor: color,
      readOnly: readOnly || undefined,
    });
  }
  for (const reply of replies) {
    const parent = result.get(reply.inReplyTo!);
    const text = reply.contentsObj?.str?.trim();
    if (!parent || !text || reply.replyType === 'Group') continue;
    parent.replies = [...(parent.replies || []), {
      author: reply.titleObj?.str?.trim() || '',
      text,
      date: parsePdfDate(reply.modificationDate) ?? parsePdfDate(reply.creationDate),
    }];
  }
  return [...result.values()];
}

// ─── Saved notes ───

// Lexio saves a document's annotations by file hash, with the ids of the
// annotations the file contained at the time.
export const NOTES_VERSION = 1;

export interface SavedNotes {
  version: number;
  highlights: Highlight[];
  importedRefs: string[];
}

// Combines saved notes with the annotations now in the file and any made
// while the file was loading. Annotations another app added or deleted since
// the last save are taken over.
export function mergeNotes(saved: SavedNotes | null, fromFile: readonly Highlight[], current: readonly Highlight[]): Highlight[] {
  let merged: Highlight[];
  if (saved?.version === NOTES_VERSION && Array.isArray(saved.highlights)) {
    const inFile = new Set(fromFile.map((highlight) => highlight.pdfRef));
    const known = new Set(saved.importedRefs);
    merged = [
      // Saved notes, minus file annotations another app has since deleted.
      ...saved.highlights.filter((highlight) => !highlight.pdfRef || inFile.has(highlight.pdfRef)),
      // File annotations added by another app since the last save.
      ...fromFile.filter((highlight) => !known.has(highlight.pdfRef!)),
    ];
  } else {
    merged = [...fromFile];
  }
  // Keep anything the user marked while the file was still loading.
  const ids = new Set(merged.map((highlight) => highlight.id));
  return [...merged, ...current.filter((highlight) => !ids.has(highlight.id))];
}


// ─── Writing ───

// pdf.js names annotations by object number ("722R", or "722R3" for a
// non-zero generation). The same name identifies them in pdf-lib.
export function refName(ref: PDFRef): string {
  return `${ref.objectNumber}R${ref.generationNumber ? ref.generationNumber : ''}`;
}

const text = (value: string) => PDFHexString.fromText(value);
const stringOf = (dict: PDFDict, key: string): string => {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
};

// Maps a point in pdf.js viewport space (scale 1, top-left origin, page
// rotation applied) back to PDF user space. This inverts pdf.js
// PageViewport for each /Rotate value, with the CropBox as the view box.
function toPdfPoint(page: PDFPage, vx: number, vy: number): [number, number] {
  const box = page.getCropBox();
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  switch (((page.getRotation().angle % 360) + 360) % 360) {
    case 90: return [x0 + vy, y0 + vx];
    case 180: return [x1 - vx, y0 + vy];
    case 270: return [x1 - vy, y1 - vx];
    default: return [x0 + vx, y1 - vy];
  }
}

function viewportSize(page: PDFPage): { width: number; height: number } {
  const box = page.getCropBox();
  const rotated = [90, 270].includes(((page.getRotation().angle % 360) + 360) % 360);
  return rotated ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

// One quad per line rectangle, corners in the order readers use: top-left,
// top-right, bottom-left, bottom-right, following the text direction.
function quadsFor(page: PDFPage, rects: readonly RelativeRect[]): number[][] {
  const { width, height } = viewportSize(page);
  return rects.map((rect) => {
    const left = rect.x * width;
    const top = rect.y * height;
    const right = left + rect.width * width;
    const bottom = top + rect.height * height;
    return [
      ...toPdfPoint(page, left, top),
      ...toPdfPoint(page, right, top),
      ...toPdfPoint(page, left, bottom),
      ...toPdfPoint(page, right, bottom),
    ];
  });
}

const round = (value: number) => Math.round(value * 1000) / 1000;

// Appearance stream: what every reader draws for the annotation, so it looks
// the same in Acrobat, Preview, PDFium and pdf.js. Highlights use the
// Multiply blend mode (as Acrobat does) so the text stays readable.
function appearance(
  doc: PDFDocument,
  type: Highlight['type'],
  quads: number[][],
  bbox: number[],
  color: [number, number, number],
  opacity: number
): PDFRef {
  const [r, g, b] = color.map(round);
  let operators = `/GS0 gs\n`;
  for (const q of quads) {
    const [tlx, tly, trx, try_, blx, bly, brx, bry] = q.map(round);
    if (type === 'highlight') {
      operators += `${r} ${g} ${b} rg\n${tlx} ${tly} m ${trx} ${try_} l ${brx} ${bry} l ${blx} ${bly} l h f\n`;
    } else {
      // Line thickness scales with the line height; underline sits just
      // above the bottom edge, strikethrough in the middle.
      const lineHeight = Math.hypot(tlx - blx, tly - bly);
      const width = round(Math.max(0.5, lineHeight * 0.07));
      const t = type === 'strikeout' ? 0.5 : 0.08;
      const sx = round(blx + (tlx - blx) * t);
      const sy = round(bly + (tly - bly) * t);
      const ex = round(brx + (trx - brx) * t);
      const ey = round(bry + (try_ - bry) * t);
      operators += `${r} ${g} ${b} RG ${width} w\n${sx} ${sy} m ${ex} ${ey} l S\n`;
    }
  }
  const graphicsState = doc.context.obj({
    Type: 'ExtGState',
    CA: opacity,
    ca: opacity,
    ...(type === 'highlight' ? { BM: 'Multiply' } : {}),
  });
  const stream = doc.context.flateStream(operators, {
    Type: 'XObject',
    Subtype: 'Form',
    FormType: 1,
    BBox: bbox,
    Resources: { ExtGState: { GS0: graphicsState } },
  });
  return doc.context.register(stream);
}

export interface WriteResult {
  bytes: Uint8Array<ArrayBuffer>;
  added: number;
  updated: number;
  removed: number;
}

// Applies Lexio's annotation list to the PDF it was opened from:
// - annotations read from the file (pdfRef) are updated when their comment
//   changed, and removed (with their popups and replies) when deleted;
// - new highlights, underlines and strikethroughs become standard
//   annotations with an appearance stream and, if commented, a popup;
// - everything else in the file (links, forms, drawings) is left untouched.
// With flatten, new markings are drawn into the page instead.
export async function writeAnnotations(
  original: Uint8Array,
  highlights: readonly Highlight[],
  options: { author: string; flatten?: boolean; now?: number }
): Promise<WriteResult> {
  const doc = await PDFDocument.load(original, { updateMetadata: false });
  const pages = doc.getPages();
  const now = options.now ?? Date.now();
  const byRef = new Map(highlights.filter((highlight) => highlight.pdfRef).map((highlight) => [highlight.pdfRef!, highlight]));
  let added = 0;
  let updated = 0;
  let removed = 0;

  pages.forEach((page) => {
    const annots = page.node.Annots();
    if (!annots) return;
    // Collect first: removing while iterating would shift indexes.
    const entries: Array<{ ref: PDFRef; dict: PDFDict }> = [];
    for (let index = 0; index < annots.size(); index++) {
      const ref = annots.get(index);
      const dict = annots.lookup(index);
      if (ref instanceof PDFRef && dict instanceof PDFDict) entries.push({ ref, dict });
    }
    const toRemove = new Set<PDFRef>();
    for (const { ref, dict } of entries) {
      const subtype = dict.lookup(PDFName.of('Subtype'))?.toString().slice(1) || '';
      if (dict.has(PDFName.of('IRT'))) continue;
      const imported = MARKUP_TYPES[subtype] || NOTE_TYPES.has(subtype);
      if (!imported) continue;
      const highlight = byRef.get(refName(ref));
      if (!highlight) {
        // Deleted in Lexio: remove it, its popup and its replies.
        toRemove.add(ref);
        removed++;
        const popup = dict.get(PDFName.of('Popup'));
        if (popup instanceof PDFRef) toRemove.add(popup);
        for (const other of entries) {
          const irt = other.dict.get(PDFName.of('IRT'));
          if (irt instanceof PDFRef && irt.objectNumber === ref.objectNumber) {
            toRemove.add(other.ref);
            const replyPopup = other.dict.get(PDFName.of('Popup'));
            if (replyPopup instanceof PDFRef) toRemove.add(replyPopup);
          }
        }
        continue;
      }
      const comment = highlight.comment?.trim() || '';
      if (comment !== stringOf(dict, 'Contents').trim()) {
        dict.set(PDFName.of('Contents'), text(comment));
        dict.set(PDFName.of('M'), PDFString.of(pdfDate(now)));
        const popup = dict.lookup(PDFName.of('Popup'));
        if (popup instanceof PDFDict) popup.set(PDFName.of('Contents'), text(comment));
        updated++;
      }
    }
    for (let index = annots.size() - 1; index >= 0; index--) {
      const ref = annots.get(index);
      if (ref instanceof PDFRef && [...toRemove].some((item) => item.objectNumber === ref.objectNumber && item.generationNumber === ref.generationNumber)) {
        annots.remove(index);
      }
    }
  });

  for (const highlight of highlights) {
    if (highlight.pdfRef || highlight.type === 'note' || highlight.readOnly) continue;
    const page = pages[highlight.page - 1];
    if (!page || highlight.rects.length === 0) continue;
    const color = highlight.pdfColor || LEXIO_COLORS[highlight.color] || LEXIO_COLORS.yellow;

    if (options.flatten) {
      // Drawn into the page content; no annotation object.
      for (const q of quadsFor(page, highlight.rects)) {
        const [tlx, tly, trx, try_, blx, bly, brx, bry] = q;
        if (highlight.type === 'highlight') {
          page.drawSvgPath(`M ${tlx} ${-tly} L ${trx} ${-try_} L ${brx} ${-bry} L ${blx} ${-bly} Z`, {
            x: 0, y: 0, color: rgb(...color), opacity: 0.35, borderWidth: 0,
          });
        } else {
          const t = highlight.type === 'strikeout' ? 0.5 : 0.08;
          page.drawLine({
            start: { x: blx + (tlx - blx) * t, y: bly + (tly - bly) * t },
            end: { x: brx + (trx - brx) * t, y: bry + (try_ - bry) * t },
            thickness: Math.max(0.5, Math.hypot(tlx - blx, tly - bly) * 0.07),
            color: rgb(...color),
          });
        }
      }
      added++;
      continue;
    }

    const quads = quadsFor(page, highlight.rects);
    const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
    const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
    const margin = highlight.type === 'highlight' ? 0 : 1;
    const bbox = [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin].map(round);
    const opacity = highlight.type === 'highlight' ? 0.4 : 1;
    const subtype = highlight.type === 'highlight' ? 'Highlight' : highlight.type === 'underline' ? 'Underline' : 'StrikeOut';
    const comment = highlight.comment?.trim() || '';
    const author = highlight.author || options.author;

    const annotation = doc.context.obj({
      Type: 'Annot',
      Subtype: subtype,
      Rect: bbox,
      QuadPoints: quads.flat().map(round),
      C: color.map(round),
      CA: opacity,
      F: 4,
      P: page.ref,
      AP: { N: appearance(doc, highlight.type, quads, bbox, color, opacity) },
    });
    annotation.set(PDFName.of('NM'), PDFString.of(`lexio-${highlight.id}`));
    annotation.set(PDFName.of('M'), PDFString.of(pdfDate(highlight.modifiedAt || highlight.createdAt || now)));
    annotation.set(PDFName.of('CreationDate'), PDFString.of(pdfDate(highlight.createdAt || now)));
    if (author) annotation.set(PDFName.of('T'), text(author));
    annotation.set(PDFName.of('Subj'), PDFString.of(subtype === 'StrikeOut' ? 'Strikethrough' : subtype));
    if (comment) annotation.set(PDFName.of('Contents'), text(comment));
    const annotationRef = doc.context.register(annotation);
    page.node.addAnnot(annotationRef);

    if (comment) {
      // Readers that show comments in a popup window use this one.
      const cropBox = page.getCropBox();
      const right = Math.min(cropBox.x + cropBox.width, bbox[2] + 200);
      const popup = doc.context.obj({
        Type: 'Annot',
        Subtype: 'Popup',
        Rect: [round(right - 200), round(bbox[3] - 120), round(right), round(bbox[3])],
        Parent: annotationRef,
        Open: false,
        F: 28,
      });
      const popupRef = doc.context.register(popup);
      annotation.set(PDFName.of('Popup'), popupRef);
      page.node.addAnnot(popupRef);
    }
    added++;
  }

  const bytes = (await doc.save()) as Uint8Array<ArrayBuffer>;
  return { bytes, added, updated, removed };
}

// Checks done before saving. pdf-lib cannot write encrypted files, and it
// rewrites the whole file, which invalidates digital signatures.
export async function inspectForSaving(original: Uint8Array): Promise<{ encrypted: boolean; signed: boolean }> {
  try {
    const doc = await PDFDocument.load(original, { updateMetadata: false });
    const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'));
    let signed = false;
    if (acroForm instanceof PDFDict) {
      const flags = acroForm.lookup(PDFName.of('SigFlags'));
      signed = flags instanceof PDFNumber && (flags.asNumber() & 1) === 1;
      const fields = acroForm.lookup(PDFName.of('Fields'));
      if (!signed && fields instanceof PDFArray) {
        for (let index = 0; index < fields.size(); index++) {
          const field = fields.lookup(index);
          if (field instanceof PDFDict && field.lookup(PDFName.of('FT'))?.toString() === '/Sig' && field.has(PDFName.of('V'))) {
            signed = true;
          }
        }
      }
    }
    return { encrypted: false, signed };
  } catch (error: any) {
    if (/encrypt/i.test(String(error?.message || error?.name))) return { encrypted: true, signed: false };
    throw error;
  }
}
