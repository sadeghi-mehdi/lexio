import type { LibraryKind } from '../types.ts';

// Per-document data saved on disk by the main process (see library:* in
// electron/main.ts). In browser mode it falls back to localStorage, which
// may refuse large entries; callers treat a failed save as "not cached".
export async function loadLibrary<T>(kind: LibraryKind, key: string): Promise<T | null> {
  if (!/^[a-f0-9]{64}$/i.test(key)) return null;
  try {
    if (window.electronAPI) return (await window.electronAPI.loadLibrary(kind, key)) as T | null;
    return JSON.parse(localStorage.getItem(`lexio-${kind}-${key}`) || 'null') as T | null;
  } catch {
    return null;
  }
}

export async function saveLibrary(kind: LibraryKind, key: string, data: unknown): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/i.test(key)) return false;
  try {
    if (window.electronAPI) await window.electronAPI.saveLibrary(kind, key, data);
    else localStorage.setItem(`lexio-${kind}-${key}`, JSON.stringify(data));
    return true;
  } catch (error) {
    console.warn(`Could not save ${kind} data:`, error);
    return false;
  }
}

export async function deleteLibrary(kind: LibraryKind, key: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(key)) return;
  try {
    if (window.electronAPI) await window.electronAPI.deleteLibrary(kind, key);
    else localStorage.removeItem(`lexio-${kind}-${key}`);
  } catch {}
}
