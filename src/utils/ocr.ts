import type { OcrPage, OcrWord } from '../types.ts';

// Text recognition for scanned pages. Tesseract (English) runs in a web
// worker; its worker script, WebAssembly core and language data ship with
// the app and are never fetched from a CDN (see vite.config.ts).

// A page whose extracted text has fewer visible characters than this is
// treated as scanned (an image of text).
const MIN_TEXT_CHARS = 25;

export function needsOcr(text: string | undefined): boolean {
  return (text || '').replace(/\s/g, '').length < MIN_TEXT_CHARS;
}

// Most pages scanned means the whole document is a scan.
export function isScannedDocument(pageTexts: ReadonlyMap<number, string>): boolean {
  const pages = [...pageTexts.values()];
  return pages.length > 0 && pages.filter(needsOcr).length / pages.length >= 0.5;
}

// Words (in reading order, with line ends) to page text: words joined by
// spaces, lines by newlines, as the viewer extracts real PDF text.
export function ocrText(words: readonly OcrWord[]): string {
  let text = '';
  words.forEach((word, index) => {
    text += word.text;
    if (index < words.length - 1) text += word.lineEnd ? '\n' : ' ';
  });
  return text.trim();
}

interface ViewportLike {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
}

// OCR words as pdf.js text content, so the viewer's text layer, character
// boxes (selection, highlights, Ask AI) and Find work on scanned pages.
// Each word becomes a text item whose transform places its baseline at the
// word box's bottom-left in PDF space, sized to the box height.
export function ocrTextContent(ocr: OcrPage, viewport: ViewportLike): { items: unknown[]; styles: Record<string, unknown> } {
  const items = ocr.words.map((word, index) => {
    const [x, y] = viewport.convertToPdfPoint(word.x * viewport.width, (word.y + word.height) * viewport.height);
    const [x2] = viewport.convertToPdfPoint((word.x + word.width) * viewport.width, (word.y + word.height) * viewport.height);
    const size = word.height * viewport.height;
    return {
      str: word.text,
      dir: 'ltr',
      width: Math.abs(x2 - x),
      height: size,
      transform: [size, 0, 0, size, x, y + size * 0.2],
      fontName: 'lexio-ocr',
      hasEOL: Boolean(word.lineEnd) || index === ocr.words.length - 1,
    };
  });
  return {
    items,
    styles: { 'lexio-ocr': { fontFamily: 'sans-serif', ascent: 0.8, descent: -0.2, vertical: false } },
  };
}

// Tesseract's result (blocks > paragraphs > lines > words, pixel boxes)
// as relative word boxes.
export function wordsFromTesseract(
  data: { blocks?: Array<{ paragraphs?: Array<{ lines?: Array<{ words?: Array<{ text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } }> }> }> }> | null },
  imageWidth: number,
  imageHeight: number
): { words: OcrWord[]; confidence: number } {
  const words: OcrWord[] = [];
  let confidenceSum = 0;
  for (const block of data.blocks || []) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        const lineWords = (line.words || []).filter((word) => word.text.trim());
        lineWords.forEach((word, index) => {
          confidenceSum += word.confidence;
          words.push({
            text: word.text.trim(),
            x: word.bbox.x0 / imageWidth,
            y: word.bbox.y0 / imageHeight,
            width: (word.bbox.x1 - word.bbox.x0) / imageWidth,
            height: (word.bbox.y1 - word.bbox.y0) / imageHeight,
            lineEnd: index === lineWords.length - 1 || undefined,
          });
        });
      }
    }
  }
  return { words, confidence: words.length ? confidenceSum / words.length : 0 };
}

// ─── Browser: rendering and recognition ───

type TesseractWorker = {
  recognize: (image: HTMLCanvasElement, options?: object, output?: object) => Promise<{ data: any }>;
  terminate: () => Promise<unknown>;
};

let workerPromise: Promise<TesseractWorker> | null = null;

function tesseractWorker(): Promise<TesseractWorker> {
  workerPromise ??= (async () => {
    const { createWorker, OEM } = await import('tesseract.js');
    const base = new URL(import.meta.env.DEV ? '/node_modules/' : 'ocr/', document.baseURI).href;
    return createWorker('eng', OEM.LSTM_ONLY, {
      workerPath: import.meta.env.DEV ? `${base}tesseract.js/dist/worker.min.js` : `${base}worker.min.js`,
      corePath: import.meta.env.DEV ? `${base}tesseract.js-core/` : base,
      langPath: import.meta.env.DEV ? `${base}@tesseract.js-data/eng/4.0.0_best_int/` : base,
      gzip: true,
      // No IndexedDB copy of the language data; it ships with the app.
      cacheMethod: 'none',
      // Load the worker script directly (a blob wrapper cannot import from
      // file:// in the packaged app).
      workerBlobURL: false,
    }) as unknown as TesseractWorker;
  })().catch((error) => {
    workerPromise = null;
    throw error;
  });
  return workerPromise;
}

// Renders a pdf.js page to a canvas at about 200 DPI (A4 about 1650 px wide),
// which is where Tesseract works well without very large images.
export async function renderPageImage(page: {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: object) => { promise: Promise<void> };
}): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, Math.max(1.5, 1650 / Math.max(1, base.width)));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

export async function recognizePage(canvas: HTMLCanvasElement): Promise<OcrPage> {
  const worker = await tesseractWorker();
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
  const { words, confidence } = wordsFromTesseract(data, canvas.width, canvas.height);
  return { text: ocrText(words), confidence, words, engine: 'tesseract' };
}
