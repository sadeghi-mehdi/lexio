import assert from 'node:assert/strict';
import test from 'node:test';
import { isScannedDocument, needsOcr, ocrText, ocrTextContent, wordsFromTesseract } from '../src/utils/ocr.ts';
import { buildDocumentIndex } from '../src/utils/text-index.ts';
import { retrieveContext } from '../src/utils/retrieval.ts';
import { chatWithImage } from '../src/providers/tool-providers.ts';
import { DEFAULT_PROVIDERS } from '../src/types.ts';

test('pages with almost no text need OCR', () => {
  assert.equal(needsOcr(''), true);
  assert.equal(needsOcr('  12 \n'), true);
  assert.equal(needsOcr('This page has a real text layer with words.'), false);
  assert.equal(isScannedDocument(new Map([[1, ''], [2, ' '], [3, 'Real text on this page is long enough.']])), true);
  assert.equal(isScannedDocument(new Map([[1, 'Real text on this page is long enough.'], [2, '']])), true);
  assert.equal(isScannedDocument(new Map([[1, 'Real text on this page is long enough.'], [2, 'And here too, there is plenty of real text.'], [3, '']])), false);
});

const tesseract = {
  blocks: [{ paragraphs: [{ lines: [
    { words: [
      { text: 'Rut', confidence: 90, bbox: { x0: 100, y0: 200, x1: 160, y1: 230 } },
      { text: 'depth', confidence: 80, bbox: { x0: 170, y0: 200, x1: 260, y1: 230 } },
    ] },
    { words: [{ text: '12mm', confidence: 40, bbox: { x0: 100, y0: 250, x1: 190, y1: 280 } }] },
  ] }] }],
};

test('Tesseract output becomes relative word boxes and page text', () => {
  const { words, confidence } = wordsFromTesseract(tesseract, 1000, 1400);
  assert.equal(words.length, 3);
  assert.deepEqual(words[0], { text: 'Rut', x: 0.1, y: 200 / 1400, width: 0.06, height: 30 / 1400, lineEnd: undefined });
  assert.equal(words[1].lineEnd, true);
  assert.equal(Math.round(confidence), 70);
  assert.equal(ocrText(words), 'Rut depth\n12mm');
});

test('OCR words become text items placed in PDF space', () => {
  const { words, confidence } = wordsFromTesseract(tesseract, 1000, 1400);
  // Viewport at scale 1 of a 612 x 792 page: PDF y grows upward.
  const viewport = { width: 612, height: 792, convertToPdfPoint: (x, y) => [x, 792 - y] };
  const content = ocrTextContent({ text: ocrText(words), confidence, words, engine: 'tesseract' }, viewport);
  const [first] = content.items;
  assert.equal(first.str, 'Rut');
  assert.ok(Math.abs(first.transform[4] - 61.2) < 0.01);
  assert.ok(Math.abs(first.width - 0.06 * 612) < 0.01);
  assert.ok(first.transform[5] > 792 - (230 / 1400) * 792 && first.transform[5] < 792 - (200 / 1400) * 792);
  assert.equal(content.items[1].hasEOL, true);
  assert.ok(content.styles['lexio-ocr']);
});

test('text from OCR is labeled as such for the AI', () => {
  const pageTexts = new Map([[1, 'Rut depth\n12mm measured on the scanned page.'], [2, 'Normal text page with a real text layer.']]);
  const index = buildDocumentIndex({ key: 'k', name: 'scan.pdf', pageTexts, ocrPages: new Set([1]) });
  const result = retrieveContext({ documents: [{ label: 'D1', index }], question: 'rut depth', budgetTokens: 5000 });
  assert.match(result.text, /\[D1 p\.1 · OCR text, may contain recognition errors\]/);
  assert.match(result.text, /\[D1 p\.2\]\n/);
});

test('page images go to vision models in each provider format', async () => {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push({ url: String(url), body: JSON.parse(init.body) });
    const line = String(url).includes('anthropic')
      ? `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Page text' } })}\n`
      : String(url).includes('googleapis')
        ? `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Page text' }] } }] })}\n`
        : String(url).includes('/api/chat')
          ? `${JSON.stringify({ message: { content: 'Page text' } })}\n`
          : `data: ${JSON.stringify({ choices: [{ delta: { content: 'Page text' } }] })}\ndata: [DONE]\n`;
    return new Response(line);
  };
  try {
    for (const id of ['claude', 'openai', 'gemini', 'ollama']) {
      assert.equal(await chatWithImage(id, 'Transcribe', 'QUJD', { ...DEFAULT_PROVIDERS[id], apiKey: 'k' }, new AbortController().signal), 'Page text');
    }
    assert.deepEqual(bodies[0].body.messages[0].content[0].source, { type: 'base64', media_type: 'image/png', data: 'QUJD' });
    assert.equal(bodies[1].body.messages[0].content[1].image_url.url, 'data:image/png;base64,QUJD');
    assert.deepEqual(bodies[2].body.contents[0].parts[0], { inline_data: { mime_type: 'image/png', data: 'QUJD' } });
    assert.deepEqual(bodies[3].body.messages[0].images, ['QUJD']);
  } finally {
    globalThis.fetch = original;
  }
});
