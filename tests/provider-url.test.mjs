import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOpenAICompatibleUrl } from '../src/providers/ai-providers.ts';

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

