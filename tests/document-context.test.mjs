import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDocumentContext,
  buildContextSystemPrompt,
  chunkDocument,
  chooseDocumentAwareStrategy,
  isWholeDocumentRequest,
  rankRelevantPages,
} from '../src/utils/document-context.ts';

const pages = new Map([
  [1, 'Introduction and project background.'],
  [2, 'Laboratory specimens and asphalt mixture preparation.'],
  [3, 'Rutting performance increased with pavement temperature and heavy axle loading.'],
  [4, 'The rut depth results and uncertainty are discussed here.'],
  [5, 'Conclusions and recommendations for future pavement monitoring.'],
]);

test('ranks pages that contain the important query terms', () => {
  const ranked = rankRelevantPages(pages, 'How did temperature affect rutting performance?');
  assert.equal(ranked[0]?.page, 3);
});

test('focused questions use retrieval even when the complete PDF fits', () => {
  assert.equal(
    chooseDocumentAwareStrategy('What methodology was used?', false, true),
    'indexed-retrieval'
  );
  assert.equal(
    chooseDocumentAwareStrategy('Summarize the entire document', false, true),
    'entire-original'
  );
});

test('normalizes methodology questions to method and procedure wording', () => {
  const methodPages = new Map([
    [1, 'Project background and objectives.'],
    [2, 'The laboratory procedures included specimen conditioning and repeated testing.'],
  ]);
  const ranked = rankRelevantPages(methodPages, 'What are the methodologies?');
  assert.equal(ranked[0]?.page, 2);
});

test('Ask AI context includes only the selected passage', () => {
  const context = buildDocumentContext({
    pageTexts: pages,
    mode: 'selection',
    query: 'Explain this result',
    selectedPage: 3,
    selectedEndPage: 4,
    selectedText: 'Rutting performance increased with temperature.',
    maxChars: 10000,
  });
  assert.deepEqual(context.pages, [3, 4]);
  assert.equal(context.text, 'Rutting performance increased with temperature.');
  assert.doesNotMatch(context.text, /Laboratory specimens|uncertainty|--- Page/);
  assert.equal(context.description, 'only the selected passage from pages 3–4');
  assert.equal(context.requiresHierarchicalSummary, false);
});

test('typed questions prioritize relevant pages over the current page', () => {
  const context = buildDocumentContext({
    pageTexts: pages,
    mode: 'relevant',
    query: 'temperature rutting axle',
    currentPage: 1,
    maxChars: 120,
  });
  assert.deepEqual(context.pages, [3]);
});

test('detects explicit whole-document summary requests', () => {
  assert.equal(isWholeDocumentRequest('Please summarize the entire PDF.'), true);
  assert.equal(isWholeDocumentRequest('Summarize this document'), true);
  assert.equal(isWholeDocumentRequest('Review the literature and identify research gaps.'), true);
  assert.equal(isWholeDocumentRequest('What does the rutting result mean?'), false);
});

test('adds custom instructions to the system prompt', () => {
  const prompt = buildContextSystemPrompt(
    '--- Page 1 ---\nDocument text',
    'the full document',
    'Use formal technical language and include page citations.'
  );

  assert.match(prompt, /USER CUSTOM INSTRUCTIONS/);
  assert.match(prompt, /Use formal technical language and include page citations\./);
  assert.ok(prompt.indexOf('USER CUSTOM INSTRUCTIONS') < prompt.indexOf('DOCUMENT CONTEXT'));

  const promptWithoutCustomInstructions = buildContextSystemPrompt(
    '--- Page 1 ---\nDocument text',
    'the full document'
  );
  assert.doesNotMatch(promptWithoutCustomInstructions, /USER CUSTOM INSTRUCTIONS/);
});

test('requires hierarchical summarization when the full document exceeds the budget', () => {
  const largePages = new Map([
    [1, 'a'.repeat(4000)],
    [2, 'b'.repeat(4000)],
    [3, 'c'.repeat(4000)],
  ]);
  const context = buildDocumentContext({
    pageTexts: largePages,
    mode: 'entire',
    query: 'Summarize the entire PDF',
    maxChars: 5000,
  });
  assert.equal(context.requiresHierarchicalSummary, true);
  assert.equal(context.text, '');
  const chunks = chunkDocument(largePages, 5000);
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.some((chunk) => chunk.text.includes('--- Page 3')));
});

test('a small document returns its complete original text within the budget', () => {
  const context = buildDocumentContext({
    pageTexts: pages,
    mode: 'entire',
    query: 'What are the methodologies?',
    maxChars: 10000,
  });
  assert.equal(context.requiresHierarchicalSummary, false);
  assert.deepEqual(context.pages, [1, 2, 3, 4, 5]);
  assert.match(context.text, /--- Page 1 ---/);
  assert.match(context.text, /--- Page 5 ---/);
});
