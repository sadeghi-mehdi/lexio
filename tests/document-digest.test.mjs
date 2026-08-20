import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOCUMENT_DIGEST_VERSION,
  completeDigestPageIndex,
  consolidateDigestFragments,
  mergePageRanges,
  normalizeDigestFragment,
  parseJsonObject,
  retrieveDigestContext,
  validateDocumentDigest,
} from '../src/utils/document-digest.ts';

const digest = consolidateDigestFragments([
  {
    overview: 'A technical report with appendices and pavement findings.',
    sections: [
      {
        title: 'Main Findings',
        startPage: 20,
        endPage: 30,
        summary: 'Rutting and temperature findings from the main study.',
        keywords: ['rutting', 'temperature'],
        entities: ['ASU'],
        sectionType: 'chapter',
      },
      {
        title: 'Appendix F — Supporting Analysis',
        startPage: 214,
        endPage: 221,
        summary: 'Supporting sensitivity analysis, tables, and limitations.',
        keywords: ['appendix f', 'sensitivity', 'supporting analysis'],
        entities: [],
        sectionType: 'appendix',
      },
    ],
    topics: [{
      name: 'Sensitivity analysis',
      description: 'Supporting results are documented in Appendix F.',
      pageRanges: [{ startPage: 214, endPage: 221 }],
    }],
    pages: [
      {
        pageNumber: 24,
        headings: ['Methodology'],
        sectionTitle: 'Methodology',
        keywords: ['methods', 'specimens', 'testing'],
        description: 'Laboratory methods and testing procedures.',
      },
      {
        pageNumber: 214,
        headings: ['Appendix F — Supporting Analysis'],
        sectionTitle: 'Appendix F — Supporting Analysis',
        keywords: ['appendix f', 'sensitivity'],
        description: 'Beginning of Appendix F.',
      },
    ],
  },
], {
  fingerprint: 'a'.repeat(64),
  documentName: 'report.pdf',
  pageCount: 222,
  providerId: 'openaiCompatible',
  model: 'test-model',
});

const pageTexts = new Map(
  Array.from({ length: 222 }, (_, index) => [index + 1, `Original source text from page ${index + 1}.`])
);

test('digest retrieval maps Appendix F to its original contiguous page range', () => {
  const result = retrieveDigestContext({
    digest,
    pageTexts,
    query: 'Summarize Appendix F',
    maxChars: 100000,
    maxRanges: 4,
  });
  assert.deepEqual(result.ranges, [{ startPage: 214, endPage: 221 }]);
  assert.match(result.description, /214–221/);
  assert.match(result.text, /--- Page 214 ---/);
  assert.match(result.text, /--- Page 221 ---/);
  assert.doesNotMatch(result.text, /--- Page 30 ---/);
});

test('an unmatched query falls back to original pages instead of throwing an error', () => {
  const result = retrieveDigestContext({
    digest,
    pageTexts,
    query: 'quantum entanglement spectroscopy',
    maxChars: 100000,
    maxRanges: 4,
  });
  assert.ok(result.ranges.length > 0);
  assert.match(result.text, /Original source text/);
  assert.equal(result.confidence, 'low');
});

test('retrieval sends original page text without using digest descriptions as evidence', () => {
  const context = retrieveDigestContext({
    digest,
    pageTexts,
    query: 'What testing methods were used?',
    maxChars: 100000,
    maxRanges: 4,
  });
  assert.match(context.text, /Original source text/);
  assert.doesNotMatch(context.text, /Laboratory methods and testing procedures/);
});

test('page index completion adds deterministic entries for omitted pages', () => {
  const completed = completeDigestPageIndex(digest, new Map([
    [1, '1 INTRODUCTION\nProject purpose and background information.'],
    [2, '2 METHODS\nLaboratory specimens and testing procedures.'],
  ]));
  assert.deepEqual(completed.pages.map((page) => page.pageNumber), [1, 2]);
  assert.ok(completed.pages[1].keywords.length > 0);
  assert.ok(completed.pages[1].keywords.length <= 20);
});

test('digest cache schema version is bumped to invalidate summary-only caches', () => {
  assert.equal(DOCUMENT_DIGEST_VERSION, 2);
  assert.equal(validateDocumentDigest({ ...digest, version: 1 }), null);
});

test('overlapping and adjacent retrieved ranges are merged', () => {
  assert.deepEqual(mergePageRanges([
    { startPage: 10, endPage: 12 },
    { startPage: 13, endPage: 15 },
    { startPage: 30, endPage: 32 },
  ]), [
    { startPage: 10, endPage: 15 },
    { startPage: 30, endPage: 32 },
  ]);
});

test('cached digest validation rejects a changed fingerprint', () => {
  assert.ok(validateDocumentDigest(digest, 'a'.repeat(64), 222));
  assert.equal(validateDocumentDigest(digest, 'b'.repeat(64), 222), null);
});

test('digest fragments cannot assign page ranges outside their source chunk', () => {
  const fragment = normalizeDigestFragment({
    overview: 'Chunk overview',
    sections: [{
      title: 'Appendix F',
      startPage: 214,
      endPage: 221,
      summary: 'A table-of-contents mention must not escape this chunk.',
      keywords: ['appendix f'],
      entities: [],
      sectionType: 'appendix',
    }],
  }, 222, { startPage: 1, endPage: 10 });
  assert.equal(fragment.sections[0].startPage, 10);
  assert.equal(fragment.sections[0].endPage, 10);
});

test('major digest topics can retrieve their original page ranges', () => {
  const result = retrieveDigestContext({
    digest,
    pageTexts,
    query: 'Explain the sensitivity analysis',
    maxChars: 100000,
    maxRanges: 4,
  });
  assert.deepEqual(result.ranges, [{ startPage: 214, endPage: 221 }]);
});

test('JSON extraction tolerates model prose and markdown fences', () => {
  assert.deepEqual(parseJsonObject('Result:\n```json\n{"overview":"ok"}\n```'), { overview: 'ok' });
});
