import assert from 'node:assert/strict';
import test from 'node:test';
import { useStore } from '../src/stores/useStore.ts';
import { loadRegisteredDocument } from '../src/utils/pdf-document-registry.ts';

// Store files carry an opaque id and raw bytes, like files from the main process.
const pdf = (name) => ({ id: name, name, data: new TextEncoder().encode(`%PDF ${name}`) });

const conversation = (id) => ({
  id,
  title: `Chat ${id}`,
  messages: [],
  createdAt: 1,
});

test('closing the active chat selects the nearest remaining chat', () => {
  useStore.setState({
    conversations: [conversation('a'), conversation('b'), conversation('c')],
    activeConversation: 'b',
  });
  useStore.getState().deleteConversation('b');
  assert.deepEqual(useStore.getState().conversations.map((item) => item.id), ['a', 'c']);
  assert.equal(useStore.getState().activeConversation, 'c');
});

test('closing the final chat returns to the empty state', () => {
  useStore.setState({ conversations: [conversation('a')], activeConversation: 'a' });
  useStore.getState().deleteConversation('a');
  assert.equal(useStore.getState().activeConversation, null);
  assert.equal(useStore.getState().conversations.length, 0);
});

test('sidebar resizing is clamped and synchronized to settings', () => {
  useStore.getState().setSidebarWidth(950);
  assert.equal(useStore.getState().sidebarWidth, 950);
  assert.equal(useStore.getState().settings.sidebarWidth, 950);
  useStore.getState().setSidebarWidth(5000);
  assert.equal(useStore.getState().sidebarWidth, 1200);
});

test('opening a document clears the previous document view but keeps chats', () => {
  useStore.setState({
    conversations: [conversation('old-document')],
    activeConversation: 'old-document',
    selectedTextForAI: 'old selection',
    selectedPageForAI: 9,
    isStreaming: true,
    extractedPageCount: 203,
    documentTextReady: true,
    documentOutline: [{ title: 'Old', page: 1, depth: 0 }],
  });

  useStore.getState().setPdfFile(pdf('new.pdf'));
  const state = useStore.getState();
  // Chats belong to the workspace, not to one PDF.
  assert.equal(state.conversations[0].id, 'old-document');
  assert.equal(state.selectedTextForAI, '');
  // An answer in progress keeps streaming; it is not tied to the old tab.
  assert.equal(state.isStreaming, true);
  assert.equal(state.extractedPageCount, 0);
  assert.equal(state.documentTextReady, false);
  assert.deepEqual(state.documentOutline, []);
});

test('extracted page text is merged in batches without losing earlier pages', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('batch.pdf'));
  useStore.getState().mergePageTexts([[1, 'one'], [2, 'two']]);
  const firstMap = useStore.getState().pageTexts;
  useStore.getState().mergePageTexts([[3, 'three']]);
  const state = useStore.getState();
  assert.deepEqual([...state.pageTexts.entries()], [[1, 'one'], [2, 'two'], [3, 'three']]);
  assert.notEqual(state.pageTexts, firstMap);
  useStore.getState().mergePageTexts([]);
  assert.equal(useStore.getState().pageTexts, state.pageTexts);
});

test('closing a tab releases its parsed PDF document', async () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('release.pdf'));
  const tabId = useStore.getState().activeDocumentTabId;
  let destroyed = 0;
  await loadRegisteredDocument(tabId, async () => ({ destroy: async () => { destroyed++; } }));
  useStore.getState().closeDocumentTab(tabId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(destroyed, 1);
});

test('document tabs keep their own viewer state while chats are shared', () => {
  useStore.getState().setPdfFile(null);
  useStore.setState({ conversations: [], activeConversation: null });
  useStore.getState().setPdfFile(pdf('A.pdf'));
  const tabA = useStore.getState().activeDocumentTabId;
  useStore.getState().setCurrentPage(17);
  const conversation = useStore.getState().newConversation();
  useStore.getState().addMessage(conversation, {
    id: 'a-message', role: 'user', content: 'Question asked while A was open', timestamp: 1,
  });
  useStore.getState().setDocumentOutline([{ title: 'A outline', page: 1, depth: 0 }]);

  useStore.getState().setPdfFile(pdf('B.pdf'));
  const tabB = useStore.getState().activeDocumentTabId;
  assert.notEqual(tabA, tabB);
  assert.equal(useStore.getState().currentPage, 1);
  assert.deepEqual(useStore.getState().documentOutline, []);
  assert.equal(useStore.getState().conversations[0].messages[0].content, 'Question asked while A was open');
  assert.deepEqual(useStore.getState().recentTabIds, [tabB, tabA]);

  useStore.getState().setCurrentPage(4);
  useStore.getState().switchDocumentTab(tabA);
  assert.equal(useStore.getState().pdfFile.name, 'A.pdf');
  assert.equal(useStore.getState().currentPage, 17);
  assert.equal(useStore.getState().documentOutline[0].title, 'A outline');
  assert.deepEqual(useStore.getState().recentTabIds, [tabA, tabB]);

  useStore.getState().switchDocumentTab(tabB);
  assert.equal(useStore.getState().currentPage, 4);
  assert.equal(useStore.getState().conversations.length, 1);
});

test('opening an already-open PDF focuses its existing tab', () => {
  useStore.getState().setPdfFile(null);
  const fileA = pdf('A.pdf');
  useStore.getState().setPdfFile(fileA);
  const tabA = useStore.getState().activeDocumentTabId;
  useStore.getState().setPdfFile(pdf('B.pdf'));
  useStore.getState().setPdfFile(fileA);
  assert.equal(useStore.getState().documentTabs.length, 2);
  assert.equal(useStore.getState().activeDocumentTabId, tabA);
});

test('closing tabs selects the nearest document and returns to welcome after the final tab', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('A.pdf'));
  const tabA = useStore.getState().activeDocumentTabId;
  useStore.getState().setPdfFile(pdf('B.pdf'));
  const tabB = useStore.getState().activeDocumentTabId;
  useStore.getState().closeDocumentTab(tabB);
  assert.equal(useStore.getState().activeDocumentTabId, tabA);
  assert.equal(useStore.getState().pdfFile.name, 'A.pdf');
  useStore.getState().closeDocumentTab(tabA);
  assert.equal(useStore.getState().activeDocumentTabId, null);
  assert.equal(useStore.getState().pdfFile, null);
  assert.deepEqual(useStore.getState().documentTabs, []);
});

test('an answer keeps streaming into its chat when the user switches tabs', () => {
  useStore.getState().setPdfFile(null);
  useStore.setState({ conversations: [], activeConversation: null });
  useStore.getState().setPdfFile(pdf('A.pdf'));
  const conversation = useStore.getState().newConversation();
  useStore.getState().addMessage(conversation, {
    id: 'assistant-a', role: 'assistant', content: '', timestamp: 1, status: 'streaming',
  });
  useStore.getState().setIsStreaming(true);
  useStore.getState().setPdfFile(pdf('B.pdf'));

  useStore.getState().updateLastAssistantMessage(conversation, 'Answer');
  useStore.getState().patchLastAssistantMessage(conversation, { status: 'done', sources: [{ label: 'D1', key: 'a', page: 2 }] });
  useStore.getState().setIsStreaming(false);
  const message = useStore.getState().conversations[0].messages[0];
  assert.equal(message.content, 'Answer');
  assert.equal(message.status, 'done');
  assert.equal(message.sources[0].page, 2);
  assert.equal(useStore.getState().isStreaming, false);
});

test('closing a tab removes it from the recently viewed list', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('A.pdf'));
  const tabA = useStore.getState().activeDocumentTabId;
  useStore.getState().setPdfFile(pdf('B.pdf'));
  const tabB = useStore.getState().activeDocumentTabId;
  useStore.getState().closeDocumentTab(tabB);
  assert.deepEqual(useStore.getState().recentTabIds, [tabA]);
});

test('annotations can be commented, removed, undone, and redone', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('annotations.pdf'));
  const highlight = {
    id: 'highlight-1',
    page: 2,
    rects: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.04 }],
    text: 'Selected text',
    color: 'yellow',
    type: 'strikeout',
    createdAt: 1,
  };

  useStore.getState().addHighlight(highlight);
  useStore.getState().updateHighlightComment(highlight.id, 'Review this statement');
  useStore.getState().removeHighlight(highlight.id);
  assert.equal(useStore.getState().highlights.length, 0);

  useStore.getState().undo();
  assert.equal(useStore.getState().highlights[0].comment, 'Review this statement');
  useStore.getState().undo();
  assert.equal(useStore.getState().highlights[0].comment, undefined);

  useStore.getState().redo();
  assert.equal(useStore.getState().highlights[0].comment, 'Review this statement');
  useStore.getState().redo();
  assert.equal(useStore.getState().highlights.length, 0);
});

test('background extraction writes to its own tab, not the active one', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('first.pdf'));
  const firstTab = useStore.getState().activeDocumentTabId;
  useStore.getState().setPdfFile(pdf('second.pdf'));
  const store = useStore.getState();
  store.mergePageTexts([[1, 'background text']], firstTab, [[1, ['1 Introduction']]]);
  store.setExtractionProgress(1, true, firstTab);
  store.setDocumentOutline([{ title: 'Intro', page: 1, depth: 0 }], firstTab);
  const state = useStore.getState();
  assert.equal(state.pageTexts.size, 0);
  assert.equal(state.documentTextReady, false);
  const background = state.documentTabs.find((tab) => tab.id === firstTab);
  assert.equal(background.pageTexts.get(1), 'background text');
  assert.deepEqual(background.pageHeadings.get(1), ['1 Introduction']);
  assert.equal(background.documentTextReady, true);
  assert.equal(background.documentOutline[0].title, 'Intro');
  useStore.getState().switchDocumentTab(firstTab);
  assert.equal(useStore.getState().pageTexts.get(1), 'background text');
});
