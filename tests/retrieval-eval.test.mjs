import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDocumentContext } from '../src/utils/document-context.ts';
import { evaluateRetriever } from './fixtures/retrieval-corpus.mjs';

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

test('legacy retrieval baseline on the evaluation corpus', () => {
  const result = evaluateRetriever(legacyRetriever, BUDGET);
  console.log('legacy recall', result.recall.toFixed(2), JSON.stringify(result.kinds));
  console.log('legacy misses', result.misses);
  assert.ok(result.recall > 0);
});
