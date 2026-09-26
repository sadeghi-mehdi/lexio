import { useStore } from '../stores/useStore';
import { EMBEDDING_DIMENSIONS } from './embeddings';

// Main-thread side of the embedding worker. The model files come from the
// main process, which downloads them once and checks their hashes.

let worker: Worker | null = null;
let ready: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

// Vectors for each document, keyed by document key: one vector per embedding
// window, stored end to end, the passage of each window, and a check of the
// window texts they were computed from.
export const documentVectors = new Map<string, { check: string; vectors: Float32Array; passageOf: number[] }>();

function call<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...message, id }, transfer);
  });
}

export function embeddingsAvailable(): boolean {
  return Boolean(window.electronAPI);
}

export async function embeddingInstalled(): Promise<boolean> {
  if (!window.electronAPI) return false;
  return (await window.electronAPI.embeddingStatus()).installed;
}

export async function downloadEmbeddingModel(onProgress: (fraction: number) => void): Promise<void> {
  if (!window.electronAPI) throw new Error('Meaning-based search needs the desktop app.');
  const unsubscribe = window.electronAPI.onEmbeddingProgress(({ received, total }) => {
    if (total > 0) onProgress(received / total);
  });
  try {
    await window.electronAPI.downloadEmbeddingModel();
  } finally {
    unsubscribe();
  }
}

// Starts the worker and loads the model once. Rejects when the model is not
// installed.
export function loadEmbedder(): Promise<void> {
  ready ??= (async () => {
    const files = await window.electronAPI?.loadEmbeddingModel();
    if (!files) throw new Error('The embedding model is not installed.');
    worker = new Worker(new URL('../workers/embed-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const { id, error, ...result } = event.data;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    };
    const wasmBase = new URL(import.meta.env.DEV ? '/node_modules/onnxruntime-web/dist/' : 'ort/', document.baseURI).href;
    await call({ type: 'init', wasmBase, model: files.model, tokenizer: files.tokenizer }, [files.model.buffer]);
  })().catch((error) => {
    ready = null;
    worker?.terminate();
    worker = null;
    throw error;
  });
  return ready;
}

export async function embedTexts(texts: string[]): Promise<Float32Array> {
  await loadEmbedder();
  const { vectors } = await call<{ vectors: Float32Array }>({ type: 'embed', texts });
  return vectors;
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  const { embeddingStatus, settings } = useStore.getState();
  if (!settings.semanticSearch || (embeddingStatus !== 'ready' && embeddingStatus !== 'indexing')) return null;
  try {
    return (await embedTexts([text])).subarray(0, EMBEDDING_DIMENSIONS);
  } catch {
    return null;
  }
}
