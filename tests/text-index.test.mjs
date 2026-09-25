import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDocumentIndex,
  dehyphenate,
  pageTextFromItems,
  searchPassages,
  tokenize,
} from '../src/utils/text-index.ts';

test('table, figure and appendix references become exact tokens', () => {
  const tokens = tokenize('See Table 3, Fig. 2 and Appendix F.');
  assert.ok(tokens.includes('ref:table:3'));
  assert.ok(tokens.includes('ref:figure:2'));
  assert.ok(tokens.includes('ref:appendix:f'));
});

test('numbers, short acronyms and decimals are kept', () => {
  const tokens = tokenize('The AI model reached an F1 of 0.873 on 4,820 images.');
  for (const token of ['ai', 'f1', '0.873', '4820']) assert.ok(tokens.includes(token), token);
  assert.ok(tokens.includes(tokenize('image')[0]));
});

test('hyphenated words give their parts and the joined form', () => {
  const tokens = tokenize('micro-surfacing');
  assert.deepEqual(tokens, ['micro', tokenize('surfacing')[0], tokenize('microsurfacing')[0]]);
});

test('plural, -ing and -ed forms meet at one stem', () => {
  assert.equal(tokenize('rutting')[0], tokenize('rut')[0]);
  assert.equal(tokenize('cracks')[0], tokenize('cracking')[0]);
  assert.equal(tokenize('measured')[0], tokenize('measure')[0]);
  assert.equal(tokenize('studies')[0], tokenize('study')[0]);
});

test('Chinese and Japanese text is split into two-character pieces', () => {
  assert.deepEqual(tokenize('車輪荷重'), ['車輪', '輪荷', '荷重']);
});

test('line-break hyphens are rejoined only before lower case', () => {
  assert.equal(dehyphenate('rehabili-\ntation'), 'rehabilitation');
  assert.equal(dehyphenate('pre-\nCambrian'), 'pre-\nCambrian');
});

test('page text from pdf.js items matches the viewer format and finds headings', () => {
  const item = (str, size, hasEOL = true) => ({ str, hasEOL, transform: [size, 0, 0, size, 0, 0] });
  const { text, headings } = pageTextFromItems([
    item('2.3 Methodology', 14),
    item('The index was computed', 10, false),
    item('using sample units.', 10),
    item('Results were stable.', 10),
  ]);
  assert.equal(text, '2.3 Methodology\nThe index was computed using sample units.\nResults were stable.');
  assert.deepEqual(headings, ['2.3 Methodology']);
});

test('passages never cross pages and carry their section', () => {
  const pageTexts = new Map([
    [1, '1 Introduction\nPavement cracks matter. '.repeat(3)],
    [2, '2 Methods\nWe used a camera. '.repeat(200)],
  ]);
  const index = buildDocumentIndex({ key: 'doc', name: 'doc.pdf', pageTexts });
  assert.ok(index.passages.every((passage) => passage.text.length <= 1800));
  assert.ok(index.passages.filter((passage) => passage.page === 2).length > 1);
  assert.equal(index.passages.find((passage) => passage.page === 2).section, '2 Methods');
});

test('search ranks across documents with shared term statistics', () => {
  const first = buildDocumentIndex({
    key: 'a',
    name: 'a.pdf',
    pageTexts: new Map([[1, 'Table 1 lists traffic.'], [2, 'Table 3 lists the modulus of mixture B.']]),
  });
  const second = buildDocumentIndex({
    key: 'b',
    name: 'b.pdf',
    pageTexts: new Map([[1, 'Table 3 shows rut depth.'], [2, 'Figure 2 plots fatigue.']]),
  });
  const hits = searchPassages([first, second], 'What does Table 3 show?');
  assert.deepEqual(
    hits.slice(0, 2).map((hit) => `${hit.index.key}:${hit.passage.page}`).sort(),
    ['a:2', 'b:1']
  );
});
