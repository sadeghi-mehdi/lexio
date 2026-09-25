import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildHistory,
  decorateBlock,
  isFollowUp,
  locateMarks,
  markingsIndex,
  markRanking,
} from '../src/utils/chat-memory.ts';
import { renderCitations } from '../src/utils/citations.ts';
import { formatMarkdown } from '../src/utils/markdown.ts';
import { buildDocumentIndex } from '../src/utils/text-index.ts';
import { assignLabels, documentsInScope, prepareRequest } from '../src/utils/workspace-chat.ts';
import { DEFAULT_SETTINGS, DEFAULT_PROVIDERS } from '../src/types.ts';

const message = (role, content, extra = {}) => ({ id: `${role}-${content}`, role, content, timestamp: 1, ...extra });

test('follow-up questions are recognized only when there is history', () => {
  assert.equal(isFollowUp('Why?', true), true);
  assert.equal(isFollowUp('What about the second method?', true), true);
  assert.equal(isFollowUp('How does it compare with the baseline?', true), true);
  assert.equal(isFollowUp('What sample size did the crack detection study use for training?', true), false);
  assert.equal(isFollowUp('Why?', false), false);
});

test('history drops failed answers, keeps selections and alternates roles', () => {
  const history = buildHistory([
    message('user', 'Explain this', { selectedText: 'Rut depth doubled.', documentKey: 'k1', pageNumber: 3 }),
    message('assistant', 'It doubled because…', { status: 'done' }),
    message('user', 'And the cause?'),
    message('assistant', '⚠️ Error: timeout', { status: 'error' }),
    message('user', 'Try again: and the cause?'),
  ], 10000, (key) => (key === 'k1' ? 'D1' : undefined));
  assert.deepEqual(history.map((turn) => turn.role), ['user', 'assistant', 'user']);
  assert.match(history[0].content, /Selected passage \(D1 p\.3\):\n"Rut depth doubled\."/);
  assert.match(history[2].content, /And the cause\?\n\nTry again/);
  assert.ok(!history.some((turn) => turn.content.includes('Error')));
});

test('history keeps the newest turns when the budget is small', () => {
  const long = 'x'.repeat(4000);
  const history = buildHistory([
    message('user', 'first question'),
    message('assistant', long, { status: 'done' }),
    message('user', 'second question'),
    message('assistant', 'short answer', { status: 'done' }),
    message('user', 'third question'),
  ], 50);
  assert.equal(history[history.length - 1].content, 'third question');
  assert.equal(history[0].role, 'user');
  assert.ok(!history.some((turn) => turn.content === 'first question'));
});

const pageTexts = new Map([
  [1, 'Introduction. Pavement cracks reduce service life.'],
  [2, 'Results. The rut depth doubled above 45 °C in all\nmixtures. Other text follows here.'],
  [3, 'Earlier work reported no temper-\nature effect on rutting.'],
]);
const index = buildDocumentIndex({ key: 'k1', name: 'paper.pdf', pageTexts });
const highlight = (id, page, text, type = 'highlight', extra = {}) => ({
  id, page, text, type, color: 'yellow', rects: [], createdAt: page, ...extra,
});

test('markings are found in page text despite line breaks and hyphens', () => {
  const marks = locateMarks([{
    label: 'D1',
    index,
    highlights: [
      highlight('h1', 2, 'rut depth doubled above 45 °C in all mixtures', 'highlight', { comment: 'Check binder' }),
      highlight('h2', 3, 'no temperature effect', 'strikeout'),
    ],
  }]);
  assert.deepEqual(marks.map((mark) => mark.ref), ['N1', 'N2']);
  assert.ok(marks.every((mark) => mark.start >= 0));
  const block = { label: 'D1', key: 'k1', page: 2, section: '', text: index.pages.get(2) };
  const decorated = decorateBlock(block, marks);
  assert.match(decorated, /<mark id="N1" color="yellow" label="important">rut depth doubled above 45 °C in all\nmixtures<\/mark><note for="N1" by="you">Check binder<\/note>/);
  const struck = decorateBlock({ ...block, page: 3, text: index.pages.get(3) }, marks);
  assert.match(struck, /<del id="N2"[^>]*>no temperature effect<\/del>/);
});

test('marked passages are ranked by relevance and strikethrough gets no boost', () => {
  const marks = locateMarks([{
    label: 'D1',
    index,
    highlights: [highlight('h1', 2, 'rut depth doubled'), highlight('h2', 3, 'no temperature effect', 'strikeout')],
  }]);
  const { ranking, relevant } = markRanking(marks, 'How did rut depth change?');
  assert.equal(ranking.length, 1);
  assert.equal(relevant.length, 1);
  const list = markingsIndex(marks, 'rut depth', 2000);
  assert.match(list.text, /^N1 D1 p\.2 highlighted \(yellow: important\)/);
  assert.match(list.text, /N2 D1 p\.3 struck through/);
});

test('citations become chips and unsent pages are marked unverified', () => {
  const answer = { ...message('assistant', ''), sources: [{ label: 'D1', key: 'k1', page: 2 }], notes: [{ ref: 'N1', label: 'D1', key: 'k1', page: 2, highlightId: 'h1' }] };
  const html = renderCitations('Doubled [D1 p.2] and [D1 p.9]; see [D1 N1] and [D1 pp.1-2]. Not a citation [see above].', answer, [{ key: 'k1', label: 'D1', name: 'paper.pdf' }]);
  assert.match(html, /class="lexio-cite" data-label="D1" data-page="2"[^>]*>D1 p\.2<\/button>/);
  assert.match(html, /class="lexio-cite lexio-cite-unverified" data-label="D1" data-page="9"/);
  assert.match(html, /data-note="N1"[^>]*>D1 N1</);
  assert.match(html, /class="lexio-cite" data-label="D1" data-page="1"[^>]*>D1 pp\.1-2</);
  assert.match(html, /\[see above\]/);
});

test('several citations in one bracket are split into chips', () => {
  const answer = { ...message('assistant', ''), sources: [{ label: 'D1', key: 'a', page: 3 }, { label: 'D2', key: 'b', page: 7 }] };
  const html = renderCitations('[D1 p.3; D2 p.7, p.8]', answer, []);
  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.equal((html.match(/unverified/g) || []).length, 1);
});

test('markdown tables are rendered and HTML in answers is escaped', () => {
  const html = formatMarkdown('| Paper | Method |\n|---|---|\n| D1 | CNN |\n\n<script>alert(1)</script>');
  assert.match(html, /<table><thead><tr><th>Paper<\/th><th>Method<\/th><\/tr><\/thead><tbody><tr><td>D1<\/td><td>CNN<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /&lt;script&gt;/);
});

test('scope follows recent tabs, the limit and custom choices; labels never change', () => {
  const open = ['a', 'b', 'c'].map((key) => ({ key, name: `${key}.pdf`, tabId: key, ready: true }));
  assert.deepEqual(documentsInScope(undefined, open, 2).map((item) => item.key), ['a', 'b']);
  assert.deepEqual(documentsInScope({ scope: { mode: 'custom', keys: ['c'] } }, open, 10).map((item) => item.key), ['c']);
  assert.deepEqual(documentsInScope({ scope: { mode: 'custom', keys: ['c'] } }, open, 10, 'a').map((item) => item.key), ['a', 'c']);
  const first = assignLabels([], [open[1], open[0]]);
  const second = assignLabels(first, [open[2], open[0]]);
  assert.deepEqual(second.map((item) => `${item.label}:${item.key}`), ['D1:b', 'D2:a', 'D3:c']);
});

test('a follow-up reuses the previous question for search and the previous answer pages', async () => {
  const report = new Map();
  for (let page = 1; page <= 40; page++) report.set(page, `Section ${page}. General discussion of pavement maintenance topics and network condition. `.repeat(12));
  report.set(33, 'Expenditure for rehabilitation of the Riverside bridge deck totalled 2.3 million dollars. '.repeat(3));
  report.set(34, 'The contractor finished the Riverside bridge deck work in October. '.repeat(3));
  const reportIndex = buildDocumentIndex({ key: 'r', name: 'report.pdf', pageTexts: report });
  const documents = [{
    tabId: 't', key: 'r', name: 'report.pdf', ready: true,
    tab: { pageTexts: report, highlights: [highlight('h9', 34, 'finished the Riverside bridge deck work in October')] },
    index: () => reportIndex,
  }];
  const labels = [{ key: 'r', name: 'report.pdf', label: 'D1' }];
  const settings = { ...DEFAULT_SETTINGS, maxContextChars: 12000 };
  const config = { ...DEFAULT_PROVIDERS.claude, enabled: true };
  const conversation = {
    id: 'c', title: '', createdAt: 1, documents: labels, scope: { mode: 'all', keys: [] },
    messages: [
      message('user', 'How much was spent on the Riverside bridge deck?'),
      message('assistant', 'It cost 2.3 million dollars [D1 p.33].', { status: 'done', sources: [{ label: 'D1', key: 'r', page: 33 }] }),
      message('user', 'And when was it finished?'),
    ],
  };
  const request = await prepareRequest({
    question: 'And when was it finished?',
    selection: null,
    conversation,
    documents,
    labels,
    settings,
    config,
    provider: {},
    queryVector: async () => null,
    signal: new AbortController().signal,
    onProgress: () => {},
  });
  const pages = request.sources.map((source) => source.page);
  assert.ok(pages.includes(33), 'previous answer page carried over');
  assert.ok(pages.includes(34), 'follow-up found the answer page');
  assert.match(request.systemPrompt, /<mark id="N1" color="yellow" label="important">finished the Riverside bridge deck work in October<\/mark>/);
  assert.equal(request.history[request.history.length - 1].content, 'And when was it finished?');
  assert.deepEqual(request.notes.map((note) => note.ref), ['N1']);
});
