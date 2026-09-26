import assert from 'node:assert/strict';
import test from 'node:test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  inspectForSaving,
  nearestColor,
  parsePdfDate,
  readPageAnnotations,
  writeAnnotations,
} from '../src/utils/pdf-annotations.ts';
import { edgeStylePdf, foxitStylePdf, textPdf } from './fixtures/annotated-pdfs.mjs';

// Reads every page's annotations the way DocumentIndexer does.
async function readAll(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const highlights = [];
  const allAnnotations = [];
  for (let number = 1; number <= doc.numPages; number++) {
    const page = await doc.getPage(number);
    const annotations = await page.getAnnotations();
    allAnnotations.push(...annotations);
    const content = await page.getTextContent();
    highlights.push(...readPageAnnotations(number, annotations, content.items, page.getViewport({ scale: 1 })));
  }
  return { doc, highlights, allAnnotations };
}

// The viewport rectangle of a phrase, relative to the page, as Lexio stores
// a selection.
async function phraseRect(doc, pageNumber, phrase) {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  for (const item of content.items) {
    const at = item.str.indexOf(phrase);
    if (at < 0) continue;
    const [a, , , d, e, f] = item.transform;
    const charWidth = item.width / item.str.length;
    const x0 = e + at * charWidth * Math.sign(a || 1);
    const x1 = x0 + phrase.length * charWidth;
    const [vx0, vy0, vx1, vy1] = viewport.convertToViewportRectangle([x0, f - 2, x1, f + Math.abs(d) * 0.9]);
    const left = Math.min(vx0, vx1);
    const top = Math.min(vy0, vy1);
    return {
      x: left / viewport.width,
      y: top / viewport.height,
      width: Math.abs(vx1 - vx0) / viewport.width,
      height: Math.abs(vy1 - vy0) / viewport.height,
    };
  }
  throw new Error(`phrase not found: ${phrase}`);
}

test('Edge / Acrobat Online style annotations are read with their text and comment', async () => {
  const { highlights } = await readAll(await edgeStylePdf());
  assert.equal(highlights.length, 2);
  const highlight = highlights.find((item) => item.type === 'highlight');
  assert.equal(highlight.text, 'from a fixed height of 672 mm.');
  assert.equal(highlight.comment, 'sample comment');
  assert.equal(highlight.author, undefined);
  assert.equal(highlight.source, 'file');
  assert.equal(highlight.color, 'orange');
  assert.match(highlight.pdfRef, /^\d+R$/);
  const underline = highlights.find((item) => item.type === 'underline');
  assert.equal(underline.text, 'Future work');
  assert.equal(underline.color, 'green');
});

test('Foxit style annotations keep author and replies', async () => {
  const { highlights } = await readAll(await foxitStylePdf());
  const highlight = highlights.find((item) => item.type === 'highlight');
  assert.equal(highlight.text, 'from a fixed height of 672 mm.');
  assert.equal(highlight.author, 'meesd');
  assert.equal(highlight.comment, 'Check the calibration');
  assert.deepEqual(highlight.replies.map((reply) => `${reply.author}: ${reply.text}`), ['coauthor: Agreed, it matters']);
  const strike = highlights.find((item) => item.type === 'strikeout');
  assert.equal(strike.text, 'Thin hairline cracks');
  // pdf.js hides a grouped caret's own text, so replace-text is not shown.
  assert.equal(strike.comment, undefined);
  assert.equal(highlights.find((item) => item.type === 'underline').text, 'Pavement cracks were');
  // Replies and the caret are attached, not listed separately.
  assert.equal(highlights.length, 3);
});

test('Lexio highlights round-trip on normal, rotated and cropped pages', async () => {
  const source = await (await textPdf({
    pages: [{}, { rotate: 90 }, { rotate: 180 }, { rotate: 270 }, { cropBox: [50, 100, 500, 650] }],
  })).save();
  const sourceDoc = await pdfjs.getDocument({ data: new Uint8Array(source), verbosity: 0 }).promise;
  const created = [];
  for (let page = 1; page <= 5; page++) {
    created.push({
      id: `h${page}`,
      page,
      rects: [await phraseRect(sourceDoc, page, 'fixed height of 672 mm')],
      text: 'fixed height of 672 mm',
      color: page % 2 ? 'yellow' : 'pink',
      type: page === 3 ? 'underline' : page === 4 ? 'strikeout' : 'highlight',
      comment: page === 1 ? 'Ünïcode comment ✓' : undefined,
      createdAt: Date.UTC(2026, 8, 25),
    });
  }
  const { bytes, added } = await writeAnnotations(source, created, { author: 'Tester' });
  assert.equal(added, 5);
  const { highlights, allAnnotations } = await readAll(bytes);
  assert.equal(highlights.length, 5);
  for (const original of created) {
    const read = highlights.find((item) => item.page === original.page);
    assert.ok(read, `annotation on page ${original.page} read back`);
    assert.equal(read.source, 'file');
    assert.equal(read.page, original.page);
    assert.equal(read.type, original.type);
    assert.equal(read.color, original.color);
    assert.equal(read.author, 'Tester');
    assert.equal(read.text.replace(/\.$/, ''), 'fixed height of 672 mm', `text on page ${original.page}`);
    for (const key of ['x', 'y', 'width', 'height']) {
      assert.ok(Math.abs(read.rects[0][key] - original.rects[0][key]) < 0.002, `${key} on page ${original.page}`);
    }
  }
  assert.equal(highlights.find((item) => item.page === 1).comment, 'Ünïcode comment ✓');
  // Every annotation has an appearance stream and the commented one a popup.
  assert.ok(allAnnotations.filter((item) => item.subtype !== 'Popup').every((item) => item.hasAppearance));
  assert.equal(allAnnotations.filter((item) => item.subtype === 'Popup').length, 1);
});

test('edits and deletions change only the annotations concerned', async () => {
  const original = await foxitStylePdf();
  const { highlights } = await readAll(original);
  const highlight = highlights.find((item) => item.type === 'highlight');
  const underline = highlights.find((item) => item.type === 'underline');
  // Edit the highlight's comment, delete the underline, keep the strikethrough.
  const kept = highlights
    .filter((item) => item !== underline)
    .map((item) => (item === highlight ? { ...item, comment: 'Calibration verified' } : item));
  const result = await writeAnnotations(original, kept, { author: 'Tester' });
  assert.equal(result.updated, 1);
  assert.equal(result.removed, 1);
  assert.equal(result.added, 0);
  const after = await readAll(result.bytes);
  assert.deepEqual(after.highlights.map((item) => item.type).sort(), ['highlight', 'strikeout']);
  const edited = after.highlights.find((item) => item.type === 'highlight');
  assert.equal(edited.comment, 'Calibration verified');
  assert.equal(edited.author, 'meesd');
  assert.equal(edited.pdfRef, highlight.pdfRef);
  assert.equal(edited.replies.length, 1);
  // The link and the other app's popups for kept annotations are untouched.
  assert.equal(after.allAnnotations.filter((item) => item.subtype === 'Link').length, 1);
  assert.equal(after.allAnnotations.filter((item) => item.subtype === 'Popup').length, 2);
});

test('an incrementally updated file keeps its annotations when saved again', async () => {
  const original = await edgeStylePdf();
  const { highlights } = await readAll(original);
  const extra = { ...highlights[0], id: 'new', pdfRef: undefined, pdfColor: undefined, source: undefined, comment: undefined, type: 'strikeout', color: 'blue' };
  const result = await writeAnnotations(original, [...highlights, extra], { author: '' });
  const after = await readAll(result.bytes);
  assert.equal(after.highlights.length, 3);
  assert.equal(after.allAnnotations.filter((item) => item.subtype === 'Link').length, 1);
  // No author was configured, so none is written.
  const added = after.highlights.find((item) => item.type === 'strikeout');
  assert.equal(added.author, undefined);
  assert.equal(added.color, 'blue');
});

test('flatten draws new markings into the page instead of adding annotations', async () => {
  const source = await (await textPdf()).save();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(source), verbosity: 0 }).promise;
  const result = await writeAnnotations(source, [{
    id: 'f', page: 1, rects: [await phraseRect(doc, 1, 'fixed height')], text: 'fixed height', color: 'yellow', type: 'highlight', createdAt: 1,
  }], { author: '', flatten: true });
  const after = await readAll(result.bytes);
  assert.equal(after.allAnnotations.length, 0);
  const pdf = await PDFDocument.load(result.bytes);
  assert.ok(pdf.getPages()[0].node.get(PDFName.of('Contents')));
});

test('signed and encrypted files are detected before saving', async () => {
  const doc = await textPdf();
  const signature = doc.context.register(doc.context.obj({ FT: 'Sig', V: doc.context.obj({ Type: 'Sig' }), T: 'Signature1' }));
  doc.catalog.set(PDFName.of('AcroForm'), doc.context.obj({ Fields: [signature], SigFlags: 3 }));
  assert.deepEqual(await inspectForSaving(await doc.save()), { encrypted: false, signed: true });
  assert.deepEqual(await inspectForSaving(await (await textPdf()).save()), { encrypted: false, signed: false });
});

test('colors map to the nearest Lexio color and PDF dates parse with time zones', () => {
  assert.equal(nearestColor([255, 237, 0]), 'yellow');
  assert.equal(nearestColor([6, 138, 28]), 'green');
  assert.equal(nearestColor([219, 52, 37]), 'pink');
  assert.equal(parsePdfDate("D:20260925132543-07'00'"), Date.UTC(2026, 8, 25, 20, 25, 43));
  assert.equal(parsePdfDate('D:20260925'), Date.UTC(2026, 8, 25));
});

test('saved notes merge with annotations another app added or deleted', async () => {
  const { mergeNotes } = await import('../src/utils/pdf-annotations.ts');
  const file = (ref, extra = {}) => ({ id: `file-${ref}`, pdfRef: ref, page: 1, rects: [], text: ref, color: 'yellow', type: 'highlight', createdAt: 1, source: 'file', ...extra });
  const lexio = { id: 'mine', page: 2, rects: [], text: 'mine', color: 'green', type: 'highlight', createdAt: 2 };
  const saved = { version: 1, importedRefs: ['1R', '2R'], highlights: [file('1R', { comment: 'edited in Lexio' }), file('2R'), lexio] };
  // Since the last save another app deleted 2R and added 3R.
  const merged = mergeNotes(saved, [file('1R'), file('3R')], [{ ...lexio, id: 'while-loading' }]);
  assert.deepEqual(merged.map((item) => item.id), ['file-1R', 'mine', 'file-3R', 'while-loading']);
  assert.equal(merged[0].comment, 'edited in Lexio');
  assert.deepEqual(mergeNotes(null, [file('1R')], []).map((item) => item.id), ['file-1R']);
});
