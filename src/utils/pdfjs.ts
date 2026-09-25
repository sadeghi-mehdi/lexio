import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// The worker, character maps and standard fonts ship with the app. Nothing is
// fetched from a CDN at runtime, so PDFs open offline and no remote code runs
// in the renderer. In development Vite serves them straight from node_modules;
// the build copies them to dist/pdfjs (see vite.config.ts).
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = import.meta.env.DEV ? '/node_modules/pdfjs-dist/' : 'pdfjs/';

export function openPdfDocument(data: Uint8Array): Promise<pdfjsLib.PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    // pdf.js transfers the buffer to its worker, so give it a copy and keep
    // the store's bytes intact for saving and fingerprinting.
    data: data.slice(),
    cMapUrl: new URL(`${assetBase}cmaps/`, document.baseURI).href,
    cMapPacked: true,
    standardFontDataUrl: new URL(`${assetBase}standard_fonts/`, document.baseURI).href,
    // Never compile font programs with eval. This is also blocked by the CSP.
    isEvalSupported: false,
  }).promise;
}

export { pdfjsLib };
