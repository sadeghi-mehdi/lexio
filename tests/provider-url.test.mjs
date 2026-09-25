import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAICompatibleUrl, isLocalProvider, providers } from '../src/providers/ai-providers.ts';

test('normalizes an OpenAI-compatible base URL', () => {
  assert.equal(
    buildOpenAICompatibleUrl('https://openai.rc.asu.edu/v1/'),
    'https://openai.rc.asu.edu/v1/chat/completions'
  );
  assert.equal(
    buildOpenAICompatibleUrl('https://example.test/v1/chat/completions'),
    'https://example.test/v1/chat/completions'
  );
});

test('rejects a non-http API address', () => {
  assert.throws(() => buildOpenAICompatibleUrl('openai.rc.asu.edu/v1'), /must start/);
});


test('plain http is only accepted for a local server', () => {
  assert.equal(
    buildOpenAICompatibleUrl('http://localhost:8000/v1'),
    'http://localhost:8000/v1/chat/completions'
  );
  assert.equal(
    buildOpenAICompatibleUrl('http://127.0.0.1:8000/v1'),
    'http://127.0.0.1:8000/v1/chat/completions'
  );
  assert.throws(() => buildOpenAICompatibleUrl('http://llm.example.com/v1'), /https:\/\//);
});

test('an empty generic base URL asks the user to configure one', () => {
  assert.throws(() => buildOpenAICompatibleUrl('  '), /Enter the API base URL/);
});

test('only Ollama and loopback endpoints count as local providers', () => {
  assert.equal(isLocalProvider({ id: 'ollama', baseUrl: 'http://10.0.0.5:11434' }), true);
  assert.equal(isLocalProvider({ id: 'openaiCompatible', baseUrl: 'http://localhost:8000/v1' }), true);
  assert.equal(isLocalProvider({ id: 'openaiCompatible', baseUrl: 'https://api.example.com/v1' }), false);
  assert.equal(isLocalProvider({ id: 'claude' }), false);
});

// Builds a fetch Response whose body arrives in the given raw chunks.
const streamingResponse = (chunks) => new Response(new ReadableStream({
  start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  },
}));

test('Ollama tokens split across network chunks are not dropped', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => streamingResponse([
    '{"message":{"content":"Hel',
    'lo"},"done":false}\n{"message":{"content":" world"},"done":false}\n{"message":{"con',
    'tent":"!"},"done":true}',
  ]));
  let text = '';
  await providers.ollama.chat([], 'system', { id: 'ollama', model: 'm', baseUrl: 'http://localhost:11434' }, undefined, {
    onToken: (token) => { text += token; },
    onDone: () => {},
    onError: () => {},
  });
  assert.equal(text, 'Hello world!');
});

test('Gemini sends the API key in a header, not the URL', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => streamingResponse([
    'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n',
  ]));
  await providers.gemini.chat([], 'system', { id: 'gemini', model: 'gemini/../x', apiKey: 'secret-key' }, undefined, {
    onToken: () => {},
    onDone: () => {},
    onError: () => {},
  });
  const [url, init] = fetchMock.mock.calls[0].arguments;
  assert.doesNotMatch(url, /secret-key/);
  assert.match(url, /models\/gemini%2F\.\.%2Fx:streamGenerateContent/);
  assert.equal(init.headers['x-goog-api-key'], 'secret-key');
});
