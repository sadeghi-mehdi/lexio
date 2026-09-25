import assert from 'node:assert/strict';
import test from 'node:test';
import { contextWindowTokens, estimateTokens, requestBudget } from '../src/utils/context-budget.ts';
import { DEFAULT_PROVIDERS } from '../src/types.ts';

test('known models use their context window and overrides win', () => {
  assert.equal(contextWindowTokens(DEFAULT_PROVIDERS.claude), 200000);
  assert.equal(contextWindowTokens({ ...DEFAULT_PROVIDERS.gemini, model: 'gemini-1.5-pro' }), 2097152);
  assert.equal(contextWindowTokens(DEFAULT_PROVIDERS.ollama), 8192);
  assert.equal(contextWindowTokens({ ...DEFAULT_PROVIDERS.ollama, contextTokens: 32768 }), 32768);
});

test('a small local model gets a small document budget', () => {
  const budget = requestBudget(DEFAULT_PROVIDERS.ollama, 100000);
  assert.ok(budget.documentTokens < 8192);
  assert.ok(budget.documentTokens + budget.historyTokens + 4096 <= 8192);
});

test('the maximum context setting caps large models', () => {
  const budget = requestBudget(DEFAULT_PROVIDERS.claude, 35000);
  assert.equal(budget.documentTokens, 10000);
});

test('token estimate counts CJK characters separately', () => {
  assert.ok(estimateTokens('車輪荷重の測定') >= 7);
  assert.ok(estimateTokens('a'.repeat(350)) === 100);
});
