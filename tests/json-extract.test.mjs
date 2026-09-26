import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJsonObject } from '../src/utils/json-extract.ts';

test('JSON extraction tolerates model prose and markdown fences', () => {
  assert.deepEqual(parseJsonObject('Result:\n```json\n{"overview":"ok"}\n```'), { overview: 'ok' });
});

test('JSON extraction skips braces inside strings and earlier invalid objects', () => {
  assert.deepEqual(
    parseJsonObject('Draft {not json} then {"overview":"uses { and } inside","pages":[]} done'),
    { overview: 'uses { and } inside', pages: [] }
  );
});

test('JSON extraction stays fast on brace-heavy model output', () => {
  // Hundreds of unmatched braces made the old every-{-with-every-} search
  // run hundreds of thousands of JSON.parse calls.
  const noisy = `${'{ '.repeat(600)}${'x '.repeat(20000)}${'} '.repeat(600)} {"overview":"ok"}`;
  const started = performance.now();
  assert.deepEqual(parseJsonObject(noisy), { overview: 'ok' });
  assert.ok(performance.now() - started < 500);
});
