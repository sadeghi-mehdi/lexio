// Meaning-based search with a small English sentence embedding model
// (all-MiniLM-L6-v2, 384 dimensions). This file holds the parts that do not
// depend on the browser: the BERT WordPiece tokenizer, running the ONNX model
// through an injected runtime, and vector search.

export const EMBEDDING_MODEL_ID = 'all-MiniLM-L6-v2';
export const EMBEDDING_DIMENSIONS = 384;
// all-MiniLM-L6-v2 was trained on inputs up to 256 tokens.
const MAX_TOKENS = 256;

export interface WordPieceTokenizer {
  vocab: Map<string, number>;
  unk: number;
  cls: number;
  sep: number;
}

export function loadTokenizer(tokenizerJson: string): WordPieceTokenizer {
  const parsed = JSON.parse(tokenizerJson) as { model: { vocab: Record<string, number> } };
  const vocab = new Map(Object.entries(parsed.model.vocab));
  const id = (token: string) => {
    const value = vocab.get(token);
    if (value === undefined) throw new Error(`Tokenizer is missing ${token}`);
    return value;
  };
  return { vocab, unk: id('[UNK]'), cls: id('[CLS]'), sep: id('[SEP]') };
}

const isPunctuation = (char: string) => {
  const code = char.codePointAt(0) || 0;
  return (code >= 33 && code <= 47) || (code >= 58 && code <= 64) || (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126) || /\p{P}/u.test(char);
};
const isChinese = (code: number) =>
  (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x20000 && code <= 0x2a6df) || (code >= 0x2a700 && code <= 0x2b73f) ||
  (code >= 0x2b740 && code <= 0x2b81f) || (code >= 0x2b820 && code <= 0x2ceaf) ||
  (code >= 0xf900 && code <= 0xfaff) || (code >= 0x2f800 && code <= 0x2fa1f);

// BERT uncased tokenization, as configured in the model's tokenizer.json:
// clean control characters, space out Chinese characters, lower-case and
// strip accents, split on whitespace and punctuation, then split each word
// into the longest vocabulary pieces ("##" marks a piece inside a word).
export function encode(tokenizer: WordPieceTokenizer, text: string, maxTokens = MAX_TOKENS): number[] {
  let cleaned = '';
  for (const char of text) {
    const code = char.codePointAt(0) || 0;
    if (code === 0 || code === 0xfffd || (/\p{Cc}/u.test(char) && !/\s/.test(char))) continue;
    cleaned += isChinese(code) ? ` ${char} ` : /\s/.test(char) ? ' ' : char;
  }
  const normalized = cleaned.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');

  const ids = [tokenizer.cls];
  const limit = maxTokens - 1;
  for (const chunk of normalized.split(' ')) {
    if (!chunk) continue;
    const words: string[] = [];
    let word = '';
    for (const char of chunk) {
      if (isPunctuation(char)) {
        if (word) words.push(word);
        words.push(char);
        word = '';
      } else {
        word += char;
      }
    }
    if (word) words.push(word);

    for (const current of words) {
      if (ids.length >= limit) break;
      const chars = [...current];
      if (chars.length > 100) {
        ids.push(tokenizer.unk);
        continue;
      }
      const pieces: number[] = [];
      let start = 0;
      let failed = false;
      while (start < chars.length) {
        let end = chars.length;
        let found: number | undefined;
        while (start < end) {
          const piece = (start > 0 ? '##' : '') + chars.slice(start, end).join('');
          found = tokenizer.vocab.get(piece);
          if (found !== undefined) break;
          end--;
        }
        if (found === undefined) {
          failed = true;
          break;
        }
        pieces.push(found);
        start = end;
      }
      ids.push(...(failed ? [tokenizer.unk] : pieces));
    }
    if (ids.length >= limit) break;
  }
  ids.length = Math.min(ids.length, limit);
  ids.push(tokenizer.sep);
  return ids;
}

// The subset of onnxruntime-web used here, so tests can pass the Node build.
interface OrtLike {
  Tensor: new (type: 'int64', data: BigInt64Array, dims: number[]) => unknown;
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<OrtSession> };
}
interface OrtSession {
  inputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

export async function createEmbedder(ort: OrtLike, model: Uint8Array, tokenizerJson: string) {
  const tokenizer = loadTokenizer(tokenizerJson);
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });

  // Embeds a batch of texts. Texts are padded to the longest in the batch;
  // the output is the mean of the token vectors (ignoring padding), scaled to
  // length 1 so a dot product equals cosine similarity.
  return async (texts: string[]): Promise<Float32Array[]> => {
    const encoded = texts.map((text) => encode(tokenizer, text));
    const length = Math.max(...encoded.map((ids) => ids.length));
    const size = texts.length * length;
    const inputIds = new BigInt64Array(size);
    const attention = new BigInt64Array(size);
    encoded.forEach((ids, row) => ids.forEach((id, column) => {
      inputIds[row * length + column] = BigInt(id);
      attention[row * length + column] = 1n;
    }));
    const feeds: Record<string, unknown> = {
      input_ids: new ort.Tensor('int64', inputIds, [texts.length, length]),
      attention_mask: new ort.Tensor('int64', attention, [texts.length, length]),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(size), [texts.length, length]);
    }
    const output = await session.run(feeds);
    const hidden = (output.last_hidden_state || Object.values(output)[0]).data;
    return encoded.map((ids, row) => {
      const vector = new Float32Array(EMBEDDING_DIMENSIONS);
      for (let token = 0; token < ids.length; token++) {
        const offset = (row * length + token) * EMBEDDING_DIMENSIONS;
        for (let dim = 0; dim < EMBEDDING_DIMENSIONS; dim++) vector[dim] += hidden[offset + dim];
      }
      let norm = 0;
      for (let dim = 0; dim < EMBEDDING_DIMENSIONS; dim++) norm += vector[dim] * vector[dim];
      norm = Math.sqrt(norm) || 1;
      for (let dim = 0; dim < EMBEDDING_DIMENSIONS; dim++) vector[dim] /= norm;
      return vector;
    });
  };
}

// Dot product of unit vectors (cosine similarity).
export function similarity(a: Float32Array, b: Float32Array, offset = 0): number {
  let sum = 0;
  for (let dim = 0; dim < a.length; dim++) sum += a[dim] * b[offset + dim];
  return sum;
}

// Vectors for all passages of a document are stored end to end in one array.
export function packVectors(vectors: Float32Array[]): Float32Array {
  const packed = new Float32Array(vectors.length * EMBEDDING_DIMENSIONS);
  vectors.forEach((vector, index) => packed.set(vector, index * EMBEDDING_DIMENSIONS));
  return packed;
}

export function vectorsToBase64(vectors: Float32Array): string {
  const bytes = new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function vectorsFromBase64(encoded: string): Float32Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Float32Array(bytes.buffer);
}
