import assert from 'node:assert/strict';
import test from 'node:test';
import { findDocumentMatches } from '../src/utils/document-search.ts';

test('document search finds literal matches in page order without case sensitivity', () => {
  const matches = findDocumentMatches(new Map([
    [2, 'Method and METHOD'],
    [1, 'No method here'],
  ]), 'method');

  assert.deepEqual(matches, [
    { page: 1, occurrence: 0 },
    { page: 2, occurrence: 0 },
    { page: 2, occurrence: 1 },
  ]);
});

test('document search treats regex characters as literal text', () => {
  assert.deepEqual(
    findDocumentMatches(new Map([[3, 'Values (a+b) and a+b.']]), 'a+b'),
    [{ page: 3, occurrence: 0 }, { page: 3, occurrence: 1 }]
  );
});
