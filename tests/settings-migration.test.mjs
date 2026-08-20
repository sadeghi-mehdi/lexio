import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSettings } from '../src/utils/settings-migration.ts';

test('moves a legacy ASU configuration to the generic provider', () => {
  const settings = normalizeSettings({
    activeProvider: 'openai',
    providers: {
      openai: {
        id: 'openai',
        name: 'ASU Research Computing',
        enabled: true,
        apiKey: 'asu-test-key',
        model: 'qwen3-235b-a22b-thinking-2507',
        models: ['qwen3-235b-a22b-thinking-2507'],
      },
    },
  });

  assert.equal(settings.activeProvider, 'openaiCompatible');
  assert.equal(settings.providers.openai.name, 'OpenAI');
  assert.equal(settings.providers.openai.apiKey, '');
  assert.equal(settings.providers.openaiCompatible.apiKey, 'asu-test-key');
  assert.equal(settings.providers.openaiCompatible.baseUrl, 'https://openai.rc.asu.edu/v1');
});

test('adds new defaults to older settings without discarding unrelated provider settings', () => {
  const settings = normalizeSettings({
    maxContextChars: 700000,
    customInstructions: 'Use concise technical language.',
    providers: {
      ollama: { model: 'qwen2.5', baseUrl: 'http://localhost:11434' },
    },
  });
  assert.equal(settings.maxContextChars, 700000);
  assert.equal(settings.contextMode, 'documentAware');
  assert.equal(settings.digestEnabled, true);
  assert.equal(settings.digestProvider, 'active');
  assert.equal(settings.digestModels.ollama, '');
  assert.equal(settings.digestChunkChars, 60000);
  assert.equal(settings.customInstructions, 'Use concise technical language.');
  assert.equal(settings.providers.ollama.model, 'qwen2.5');
  assert.ok(settings.providers.openaiCompatible);
});

test('migrates the old entire-document mode to raw full-document mode', () => {
  const settings = normalizeSettings({ contextMode: 'entire' });
  assert.equal(settings.contextMode, 'rawEntire');
});

test('defaults missing custom instructions to an empty string', () => {
  const settings = normalizeSettings({});
  assert.equal(settings.customInstructions, '');
});

test('keeps gemma4-e2b-it only on the generic OpenAI-compatible provider', () => {
  const settings = normalizeSettings({
    providers: {
      ollama: { model: 'gemma4-e2b-it', models: ['llama3.2', 'gemma4-e2b-it'] },
      openai: { model: 'gemma4-e2b-it', models: ['gpt-4o', 'gemma4-e2b-it'] },
      openaiCompatible: { model: 'gemma4-e2b-it', models: ['gemma4-e2b-it'] },
    },
  });

  assert.equal(settings.providers.ollama.model, 'llama3.2');
  assert.deepEqual(settings.providers.ollama.models, ['llama3.2']);
  assert.equal(settings.providers.openai.model, 'gpt-4o');
  assert.deepEqual(settings.providers.openai.models, ['gpt-4o']);
  assert.equal(settings.providers.openaiCompatible.model, 'gemma4-e2b-it');
  assert.deepEqual(settings.providers.openaiCompatible.models, ['gemma4-e2b-it']);
});

test('page-index models are provider-specific and reject a generic-only legacy override', () => {
  const settings = normalizeSettings({
    activeProvider: 'openai',
    digestProvider: 'active',
    digestModel: 'gemma4-e2b-it',
    digestModels: {
      claude: 'claude-haiku-4-20250414',
      openaiCompatible: 'gemma4-e2b-it',
    },
  });

  assert.equal(settings.digestModels.openai, '');
  assert.equal(settings.digestModels.claude, 'claude-haiku-4-20250414');
  assert.equal(settings.digestModels.openaiCompatible, 'gemma4-e2b-it');
});
