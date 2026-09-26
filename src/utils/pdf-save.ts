import type { AppSettings, Highlight, PdfFileData } from '../types';
import { inspectForSaving, writeAnnotations } from './pdf-annotations';

// Author written into new annotations: the name set in Settings, or the
// computer's user name.
async function annotationAuthor(settings: AppSettings): Promise<string> {
  if (settings.authorName.trim()) return settings.authorName.trim();
  try {
    return (await window.electronAPI?.userName()) || '';
  } catch {
    return '';
  }
}

// PDF bytes with the current annotations, always built from the bytes the
// file was opened with: annotations already in the file are updated or
// removed in place and new ones are added, so saving twice never duplicates
// anything. Returns null when the user cancels or the file cannot be written.
export async function annotatedPdfBytes(
  pdfFile: PdfFileData,
  highlights: readonly Highlight[],
  settings: AppSettings
): Promise<Uint8Array<ArrayBuffer> | null> {
  const check = await inspectForSaving(pdfFile.data);
  if (check.encrypted) {
    window.alert('This PDF is encrypted, so Lexio cannot write annotations into it. Your highlights and notes are still kept in Lexio.');
    return null;
  }
  if (check.signed && !window.confirm('This PDF is digitally signed. Saving annotations rewrites the file and the signature will no longer be valid. Save anyway?')) {
    return null;
  }
  const result = await writeAnnotations(pdfFile.data, highlights, {
    author: await annotationAuthor(settings),
    flatten: settings.flattenOnSave,
  });
  return result.bytes;
}

export function annotatedFileName(name: string): string {
  return /\.pdf$/i.test(name) ? name.replace(/\.pdf$/i, '-annotated.pdf') : `${name}-annotated.pdf`;
}

// Save As: a native dialog in Electron, a download in browser mode.
export async function savePdfCopy(pdfFile: PdfFileData, highlights: readonly Highlight[], settings: AppSettings): Promise<void> {
  const bytes = await annotatedPdfBytes(pdfFile, highlights, settings);
  if (!bytes) return;
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
