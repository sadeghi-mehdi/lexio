import * as ort from 'onnxruntime-web/wasm';
import { createEmbedder, packVectors } from '../utils/embeddings';

// Runs the embedding model off the main thread. Messages carry an id so the
// client can match answers to requests.
let embed: ((texts: string[]) => Promise<Float32Array[]>) | null = null;

self.onmessage = async (event: MessageEvent) => {
  const message = event.data as
    | { id: number; type: 'init'; wasmBase: string; model: Uint8Array; tokenizer: string }
    | { id: number; type: 'embed'; texts: string[] };
  try {
    if (message.type === 'init') {
      // The .wasm file ships with the app (see vite.config.ts). One thread:
      // several threads need cross-origin isolation, which Lexio does not use.
      // Only the .wasm file is given: the bundled runtime already contains its
      // JavaScript glue, and a folder path would make it fetch that glue too.
      ort.env.wasm.wasmPaths = { wasm: `${message.wasmBase}ort-wasm-simd-threaded.wasm` };
      ort.env.wasm.numThreads = 1;
      embed = await createEmbedder(ort as never, message.model, message.tokenizer);
      self.postMessage({ id: message.id, ok: true });
      return;
    }
    if (!embed) throw new Error('The embedding model is not loaded.');
    const vectors = packVectors(await embed(message.texts));
    (self as unknown as Worker).postMessage({ id: message.id, vectors }, [vectors.buffer]);
  } catch (error) {
    self.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
