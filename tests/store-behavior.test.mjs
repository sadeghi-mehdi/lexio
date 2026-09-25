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

test('opening a document clears the previous document session', () => {
  useStore.setState({
    conversations: [conversation('old-document')],
    activeConversation: 'old-document',
    selectedTextForAI: 'old selection',
    selectedPageForAI: 9,
    isStreaming: true,
    extractedPageCount: 203,
    documentTextReady: true,
    documentDigest: {
      version: 1,
      documentFingerprint: 'a'.repeat(64),
      documentName: 'old.pdf',
      pageCount: 10,
      generatedAt: 1,
      providerId: 'ollama',
      model: 'test',
      overview: 'old',
      majorTopics: [],
      sections: [],
    },
  });

  useStore.getState().setPdfFile(pdf('new.pdf'));
  const state = useStore.getState();
  assert.deepEqual(state.conversations, []);
  assert.equal(state.activeConversation, null);
  assert.equal(state.selectedTextForAI, '');
  assert.equal(state.isStreaming, false);
  assert.equal(state.extractedPageCount, 0);
  assert.equal(state.documentTextReady, false);
  assert.equal(state.documentDigest, null);
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

test('page-index approval is remembered per document tab', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('approved.pdf'));
  const approvedTab = useStore.getState().activeDocumentTabId;
  useStore.getState().approveDocumentDigest();
  useStore.getState().setPdfFile(pdf('other.pdf'));
  assert.equal(useStore.getState().digestApproved, false);
  useStore.getState().switchDocumentTab(approvedTab);
  assert.equal(useStore.getState().digestApproved, true);
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

test('document tabs preserve independent viewer, chat, and page-index state', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('A.pdf'));
  const tabA = useStore.getState().activeDocumentTabId;
  useStore.getState().setCurrentPage(17);
  const conversationA = useStore.getState().newConversation();
  useStore.getState().addMessage(conversationA, {
    id: 'a-message', role: 'user', content: 'Question for A', timestamp: 1,
  });
  useStore.getState().setDocumentDigest({
    version: 2,
    documentFingerprint: 'a'.repeat(64),
    documentName: 'A.pdf',
    pageCount: 20,
    generatedAt: 1,
    providerId: 'openaiCompatible',
    model: 'index-model-a',
    overview: 'A index',
    majorTopics: [],
    sections: [],
    pages: [],
  });

  useStore.getState().setPdfFile(pdf('B.pdf'));
  const tabB = useStore.getState().activeDocumentTabId;
  assert.notEqual(tabA, tabB);
  assert.equal(useStore.getState().currentPage, 1);
  assert.deepEqual(useStore.getState().conversations, []);
  assert.equal(useStore.getState().documentDigest, null);

  useStore.getState().setCurrentPage(4);
  const conversationB = useStore.getState().newConversation();
  useStore.getState().addMessage(conversationB, {
    id: 'b-message', role: 'user', content: 'Question for B', timestamp: 2,
  });

  useStore.getState().switchDocumentTab(tabA);
  assert.equal(useStore.getState().pdfFile.name, 'A.pdf');
  assert.equal(useStore.getState().currentPage, 17);
  assert.equal(useStore.getState().conversations[0].messages[0].content, 'Question for A');
  assert.equal(useStore.getState().documentDigest.model, 'index-model-a');

  useStore.getState().switchDocumentTab(tabB);
  assert.equal(useStore.getState().pdfFile.name, 'B.pdf');
  assert.equal(useStore.getState().currentPage, 4);
  assert.equal(useStore.getState().conversations[0].messages[0].content, 'Question for B');
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

test('background chat updates remain attached to their originating document tab', () => {
  useStore.getState().setPdfFile(null);
  useStore.getState().setPdfFile(pdf('A.pdf'));
  const tabA = useStore.getState().activeDocumentTabId;
  const conversationA = useStore.getState().newConversation();
  useStore.getState().addMessage(conversationA, {
    id: 'assistant-a', role: 'assistant', content: '', timestamp: 1,
  }, tabA);
  useStore.getState().setIsStreaming(true, tabA);
  useStore.getState().setPdfFile(pdf('B.pdf'));
  const tabB = useStore.getState().activeDocumentTabId;

  useStore.getState().updateLastAssistantMessage(conversationA, 'Answer for A', tabA);
  useStore.getState().setIsStreaming(false, tabA);
  assert.equal(useStore.getState().activeDocumentTabId, tabB);
  assert.deepEqual(useStore.getState().conversations, []);

  useStore.getState().switchDocumentTab(tabA);
  assert.equal(useStore.getState().conversations[0].messages[0].content, 'Answer for A');
  assert.equal(useStore.getState().isStreaming, false);
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
