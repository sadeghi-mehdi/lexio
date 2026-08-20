import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeSettingsApiKeys,
  splitSettingsApiKeys,
} from '../electron/credential-settings.ts';

test('API keys are removed from settings before plaintext persistence', () => {
  const result = splitSettingsApiKeys({
    activeProvider: 'openaiCompatible',
    providers: {
      openai: { model: 'gpt-4o', apiKey: 'openai-secret' },
      openaiCompatible: { model: 'qwen', apiKey: 'asu-secret' },
    },
  });
  assert.deepEqual(result.apiKeys, {
    openai: 'openai-secret',
    openaiCompatible: 'asu-secret',
  });
  assert.equal(result.settings.providers.openai.apiKey, undefined);
  assert.equal(result.settings.providers.openaiCompatible.apiKey, undefined);
  assert.doesNotMatch(JSON.stringify(result.settings), /openai-secret|asu-secret/);
});

test('decrypted API keys are merged back into runtime settings', () => {
  const result = mergeSettingsApiKeys({
    providers: { openai: { model: 'gpt-4o' } },
  }, {
    openai: 'decrypted-secret',
  });
  assert.equal(result.providers.openai.apiKey, 'decrypted-secret');
});

test('legacy plaintext keys take precedence during one-time migration', () => {
  const result = mergeSettingsApiKeys({
    providers: { openai: { apiKey: 'new-plaintext-key' } },
  }, {
    openai: 'older-encrypted-key',
  });
  assert.equal(result.providers.openai.apiKey, 'new-plaintext-key');
});
