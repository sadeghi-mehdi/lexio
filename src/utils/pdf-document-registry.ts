// One parsed PDF per document tab, shared by the viewer and the thumbnail
// sidebar and kept across tab switches. The store releases an entry when its
// tab closes. This module does not import pdf.js so the store stays testable
// in Node.

interface Destroyable {
  destroy(): Promise<void>;
}

const documents = new Map<string, Promise<Destroyable>>();

export function loadRegisteredDocument<T extends Destroyable>(
  tabId: string,
  load: () => Promise<T>
): Promise<T> {
  let entry = documents.get(tabId);
  if (!entry) {
    const created = load();
    entry = created;
    documents.set(tabId, created);
    created.catch(() => {
      if (documents.get(tabId) === created) documents.delete(tabId);
    });
  }
  return entry as Promise<T>;
}

export function releaseRegisteredDocument(tabId: string): void {
  const entry = documents.get(tabId);
  if (!entry) return;
  documents.delete(tabId);
  void entry.then((document) => document.destroy()).catch(() => {});
}
