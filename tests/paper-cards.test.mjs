import assert from 'node:assert/strict';
import test from 'node:test';
import { cardText, normalizeCard, parseDocumentReply } from '../src/utils/paper-cards.ts';
import { buildDocumentIndex } from '../src/utils/text-index.ts';
import { prepareAnalysis } from '../src/utils/workspace-chat.ts';
import { DEFAULT_PROVIDERS, DEFAULT_SETTINGS } from '../src/types.ts';

test('cards are validated and page numbers outside the document dropped', () => {
  const card = normalizeCard({
    title: 'SUT-Crack', authors: 'Sabouri, Sepidbar', year: 2023, method: 'Line-scan camera survey',
    findings: [{ text: '130 images at 672 mm', pages: [1, 3, 99, 'x'] }, { text: '' }],
  }, 'model-a', 8);
  assert.equal(card.year, '');
  assert.deepEqual(card.findings, [{ text: '130 images at 672 mm', pages: [1, 3] }]);
  assert.match(cardText(card, 'D2'), /Finding: 130 images at 672 mm \[D2 p\.1; D2 p\.3\]/);
  assert.equal(normalizeCard({}, 'm', 5), null);
});

test('a reply that is not JSON becomes the answer', () => {
  assert.deepEqual(parseDocumentReply('Plain answer [D1 p.2]', 'm', 5), { card: null, answer: 'Plain answer [D1 p.2]' });
  const parsed = parseDocumentReply('```json\n{"answer":"A","card":{"title":"T","method":"M"}}\n```', 'm', 5);
  assert.equal(parsed.answer, 'A');
  assert.equal(parsed.card.title, 'T');
});

test('analysis asks each document separately, keeps verified card pages and adds gap rules', async () => {
  const make = (key, name, fact) => {
    const pageTexts = new Map([[1, `${name} abstract.`], [2, fact], [3, 'Conclusions and limitations.']]);
    const index = buildDocumentIndex({ key, name, pageTexts });
    return { tabId: key, key, name, ready: true, tab: { pageTexts, highlights: [] }, index: () => index };
  };
  const documents = [make('a', 'first.pdf', 'Camera at 672 mm.'), make('b', 'second.pdf', 'Laser profiler at 2 m.')];
  const labels = [{ key: 'a', name: 'first.pdf', label: 'D1' }, { key: 'b', name: 'second.pdf', label: 'D2' }];
  const calls = [];
  const provider = {
    async chat(messages, system, config, signal, callbacks) {
      calls.push(system);
      const label = system.includes('first.pdf') ? 'D1' : 'D2';
      callbacks.onToken(JSON.stringify({
        answer: `${label} uses one sensor [${label} p.2].`,
        card: { title: `${label} title`, method: 'survey', findings: [{ text: 'sensor height', pages: [2, 3, 7] }] },
      }));
      callbacks.onDone();
    },
  };
  const saved = new Map();
  const result = await prepareAnalysis({
    question: 'What research gaps remain?',
    conversation: { id: 'c', title: '', createdAt: 1, messages: [{ id: 'u', role: 'user', content: 'What research gaps remain?', timestamp: 1 }] },
    documents,
    labels,
    settings: DEFAULT_SETTINGS,
    config: { ...DEFAULT_PROVIDERS.claude, enabled: true },
    provider,
    signal: new AbortController().signal,
    onProgress: () => {},
    loadCard: async (key) => saved.get(key) || null,
    saveCard: (key, card) => saved.set(key, card),
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('Camera at 672 mm.') && !calls[0].includes('Laser profiler'));
  // Page 7 does not exist; pages 2 and 3 were shown to the model.
  assert.deepEqual(saved.get('a').findings[0].pages, [2, 3]);
  assert.match(result.systemPrompt, /D1 uses one sensor \[D1 p\.2\]/);
  assert.match(result.systemPrompt, /not covered in these 2 documents/);
  assert.deepEqual([...new Set(result.sources.map((source) => source.label))], ['D1', 'D2']);
  assert.equal(result.history[result.history.length - 1].content, 'What research gaps remain?');

  // A second analysis reuses the cached cards and does not ask for new ones.
  calls.length = 0;
  await prepareAnalysis({
    question: 'Compare methods',
    conversation: { id: 'c', title: '', createdAt: 1, messages: [{ id: 'u2', role: 'user', content: 'Compare methods', timestamp: 2 }] },
    documents, labels, settings: DEFAULT_SETTINGS, config: { ...DEFAULT_PROVIDERS.claude, enabled: true }, provider,
    signal: new AbortController().signal, onProgress: () => {},
    loadCard: async (key) => saved.get(key) || null, saveCard: () => assert.fail('card should be cached'),
  });
  assert.equal(calls.length, 2);
});
