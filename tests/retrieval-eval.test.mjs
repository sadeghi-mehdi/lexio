import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildDocumentContext } from '../src/utils/document-context.ts';
import { createEmbedder, packVectors } from '../src/utils/embeddings.ts';
import { retrieveContext } from '../src/utils/retrieval.ts';
import { buildDocumentIndex, embeddingWindows } from '../src/utils/text-index.ts';
import { documents, evaluateRetriever } from './fixtures/retrieval-corpus.mjs';

// About four report pages. Small enough that retrieval has to choose.
const BUDGET = 8000;

// The retrieval used before the workspace chat: one document per chat, so a
// question can only reach the first document in its scope (the active tab).
function legacyRetriever(scope, question, budget) {
  const document = scope[0];
  const context = buildDocumentContext({
    pageTexts: document.pages,
    mode: 'relevant',
    query: question,
    maxChars: budget,
  });
  // The context text is a series of "--- Page N ---" blocks.
  return context.text.split(/^--- Page (\d+) ---$/m).slice(1).flatMap((part, index, parts) =>
    index % 2 === 0 ? [[document.id, Number(part), parts[index + 1]]] : []
  );
}

const indexes = new Map(documents.map((document) => [
  document.id,
  buildDocumentIndex({ key: document.id, name: document.name, pageTexts: document.pages }),
]));

function workspaceRetriever(vectors, queryVectors) {
  return (scope, question, budget) => {
    const result = retrieveContext({
      documents: scope.map((document, position) => ({
        label: `D${position + 1}`,
        index: indexes.get(document.id),
        vectors: vectors?.get(document.id)?.vectors,
        windowPassages: vectors?.get(document.id)?.passageOf,
      })),
      question,
      budgetTokens: Math.floor(budget / 3.5),
      queryVector: queryVectors?.get(question),
    });
    return result.blocks.map((block) => [block.key, block.page, block.text]);
  };
}

let legacyRecall = 0;

test('legacy retrieval baseline on the evaluation corpus', () => {
  const result = evaluateRetriever(legacyRetriever, BUDGET);
  legacyRecall = result.recall;
  console.log('legacy recall', result.recall.toFixed(2), JSON.stringify(result.kinds));
  assert.ok(result.recall > 0);
});

test('workspace retrieval with keyword search beats the legacy retrieval', () => {
  const result = evaluateRetriever(workspaceRetriever(), BUDGET);
  console.log('keyword recall', result.recall.toFixed(2), JSON.stringify(result.kinds));
  console.log('keyword misses', result.misses);
  assert.ok(result.recall > legacyRecall);
  // Paraphrases need meaning-based search, and questions in another language
  // than the document are a known limit. Everything else must be found.
  for (const [kind, score] of Object.entries(result.kinds)) {
    if (kind === 'paraphrase' || kind === 'crosslingual') continue;
    if (kind === 'multi') assert.ok(score.hit >= score.total - 1, kind);
    else assert.equal(score.hit, score.total, kind);
  }
});

// Runs only when a local copy of all-MiniLM-L6-v2 is available, for example
// LEXIO_EMBEDDING_DIR=/path/to/Xenova/all-MiniLM-L6-v2 npm test
const modelDirectory = process.env.LEXIO_EMBEDDING_DIR;
test('workspace retrieval with meaning-based search', { skip: !modelDirectory && 'LEXIO_EMBEDDING_DIR not set' }, async () => {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const embed = await createEmbedder(
    ort,
    new Uint8Array(fs.readFileSync(path.join(modelDirectory, 'onnx', 'model_quantized.onnx'))),
    fs.readFileSync(path.join(modelDirectory, 'tokenizer.json'), 'utf8')
  );
  const vectors = new Map();
  const started = performance.now();
  let passages = 0;
  for (const [id, index] of indexes) {
    const windows = embeddingWindows(index);
    const all = [];
    for (let start = 0; start < windows.texts.length; start += 8) {
      all.push(...await embed(windows.texts.slice(start, start + 8)));
    }
    passages += index.passages.length;
    vectors.set(id, { vectors: packVectors(all), passageOf: windows.passageOf });
  }
  console.log('embedding ms per passage', ((performance.now() - started) / passages).toFixed(1));
  const { questions } = await import('./fixtures/retrieval-corpus.mjs');
  const queryVectors = new Map();
  for (const question of questions) queryVectors.set(question.q, (await embed([question.q]))[0]);
  const result = evaluateRetriever(workspaceRetriever(vectors, queryVectors), BUDGET);
  console.log('hybrid recall', result.recall.toFixed(2), JSON.stringify(result.kinds));
  console.log('hybrid misses', result.misses);
  assert.ok(result.recall >= 0.9);
  for (const [kind, score] of Object.entries(result.kinds)) {
    if (kind === 'exact' || kind === 'reference' || kind === 'cjk') assert.equal(score.hit, score.total, kind);
  }
});
