import { PDFDocument, rgb } from 'pdf-lib';
import type { Highlight, HighlightColor, PdfFileData } from '../types';

// Color mapping for PDF annotations
const PDF_COLORS: Record<HighlightColor, { r: number; g: number; b: number }> = {
  yellow: { r: 1, g: 0.92, b: 0.23 },
  green: { r: 0.3, g: 0.69, b: 0.31 },
  blue: { r: 0.13, g: 0.59, b: 0.95 },
  pink: { r: 0.91, g: 0.12, b: 0.39 },
  orange: { r: 1, g: 0.6, b: 0 },
};

// Always called with the bytes the document was opened with. The store never
// replaces them with a saved copy, so saving twice does not draw the same
// highlights twice, and deleted highlights disappear from the next save.
export async function savePdfWithAnnotations(
  originalBytes: Uint8Array<ArrayBuffer>,
  highlights: Highlight[]
): Promise<Uint8Array<ArrayBuffer>> {
  const pdfDoc = await PDFDocument.load(originalBytes);
  const pages = pdfDoc.getPages();

  // Group highlights by page
  const highlightsByPage = new Map<number, Highlight[]>();
  for (const h of highlights) {
    const arr = highlightsByPage.get(h.page) || [];
    arr.push(h);
    highlightsByPage.set(h.page, arr);
  }

  // Add annotations to each page
  for (const [pageNum, pageHighlights] of highlightsByPage) {
    const pageIndex = pageNum - 1; // PDF pages are 0-indexed
    if (pageIndex < 0 || pageIndex >= pages.length) continue;

    const page = pages[pageIndex];
    const { width, height } = page.getSize();

    for (const highlight of pageHighlights) {
      const color = PDF_COLORS[highlight.color] || PDF_COLORS.yellow;

      for (const rect of highlight.rects) {
        // Convert relative coordinates to PDF coordinates
        // Note: PDF coordinates have origin at bottom-left
        const x = rect.x * width;
        const y = height - (rect.y + rect.height) * height; // Flip Y axis
        const w = rect.width * width;
        const h = rect.height * height;

        if (highlight.type === 'highlight') {
          // Draw highlight rectangle
          page.drawRectangle({
            x,
            y,
            width: w,
            height: h,
            color: rgb(color.r, color.g, color.b),
            opacity: 0.35,
          });
        } else if (highlight.type === 'underline') {
          // Draw underline
          page.drawLine({
            start: { x, y },
            end: { x: x + w, y },
            thickness: 1.5,
            color: rgb(color.r, color.g, color.b),
            opacity: 0.8,
          });
        } else if (highlight.type === 'strikeout') {
          // Draw strikethrough
          page.drawLine({
            start: { x, y: y + h / 2 },
            end: { x: x + w, y: y + h / 2 },
            thickness: 1.5,
            color: rgb(color.r, color.g, color.b),
            opacity: 0.8,
          });
        }
      }

      // If there's a comment, add a note annotation
      if (highlight.comment && highlight.rects.length > 0) {
        const firstRect = highlight.rects[0];
        const noteX = firstRect.x * width + firstRect.width * width;
        const noteY = height - firstRect.y * height;

        // Add a small comment indicator
        page.drawCircle({
          x: Math.min(noteX + 5, width - 10),
          y: Math.min(noteY, height - 10),
          size: 6,
          color: rgb(color.r, color.g, color.b),
          opacity: 0.9,
        });
      }
    }
  }

  return (await pdfDoc.save()) as Uint8Array<ArrayBuffer>;
}

export function annotatedFileName(name: string): string {
  return /\.pdf$/i.test(name) ? name.replace(/\.pdf$/i, '-annotated.pdf') : `${name}-annotated.pdf`;
}

// Save As: a native dialog in Electron, a download in browser mode.
export async function savePdfCopy(pdfFile: PdfFileData, highlights: Highlight[]): Promise<void> {
  const bytes = await savePdfWithAnnotations(pdfFile.data, highlights);
  if (window.electronAPI) {
    await window.electronAPI.savePdf(annotatedFileName(pdfFile.name), bytes);
    return;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = annotatedFileName(pdfFile.name);
  a.click();
  URL.revokeObjectURL(url);
}

// Browser-mode fallback for opening a File (file picker or a drop without a
// filesystem path). Such files cannot be saved in place.
export async function readPdfFile(file: File): Promise<PdfFileData> {
  const data = new Uint8Array(await file.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return {
    id: `${file.name}::${file.size}::${file.lastModified}`,
    name: file.name,
    data,
    fingerprint: [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
    canSaveInPlace: false,
  };
}
