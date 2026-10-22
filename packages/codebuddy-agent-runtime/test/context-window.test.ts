import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildCodeBuddyContextWindowOption,
  formatCodeBuddyContextWindow,
  normalizeCodeBuddyContextWindow,
  resolveCodeBuddyContextWindow,
} from '../src/context-window.js';

const deepseekFlash = {
  maxInputTokens: 1_000_000,
  contextWindow: { supportedLengths: [300_000, 1_000_000], defaultLength: 300_000 },
};

test('only exposes a selector for at least two valid tiers within maxInputTokens', () => {
  assert.deepEqual(normalizeCodeBuddyContextWindow(deepseekFlash), {
    maxInputTokens: 1_000_000,
    supportedLengths: [300_000, 1_000_000],
    defaultLength: 300_000,
  });
  assert.deepEqual(buildCodeBuddyContextWindowOption(deepseekFlash), {
    type: 'select',
    id: 'context_window',
    name: 'Context window',
    description: 'Select the context budget for this model. The model input-token limit remains unchanged.',
    currentValue: '300000',
    options: [
      { value: '300000', name: '300K' },
      { value: '1000000', name: '1M' },
    ],
  });
  assert.equal(buildCodeBuddyContextWindowOption({ maxInputTokens: 1_000_000, contextWindow: { supportedLengths: [1_000_000] } }), undefined);
  assert.equal(buildCodeBuddyContextWindowOption({ maxInputTokens: 300_000, contextWindow: { supportedLengths: [300_000, 1_000_000] } }), undefined);
  assert.equal(buildCodeBuddyContextWindowOption({ maxInputTokens: 1_000_000 }), undefined);
});

test('a missing or invalid default falls back to the smallest tier', () => {
  assert.equal(buildCodeBuddyContextWindowOption({
    maxInputTokens: 1_000_000,
    contextWindow: { supportedLengths: [1_000_000, 300_000] },
  })?.currentValue, '300000');
  assert.equal(buildCodeBuddyContextWindowOption({
    maxInputTokens: 1_000_000,
    contextWindow: { supportedLengths: [300_000, 1_000_000], defaultLength: 500_000 },
  })?.currentValue, '300000');
});

test('keeps values as token-count strings and formats labels in decimal K/M', () => {
  assert.equal(formatCodeBuddyContextWindow(300_000), '300K');
  assert.equal(formatCodeBuddyContextWindow(1_000_000), '1M');
  assert.equal(resolveCodeBuddyContextWindow(deepseekFlash, '1000000'), 1_000_000);
  assert.equal(resolveCodeBuddyContextWindow(deepseekFlash, '1000001'), undefined);
  assert.equal(resolveCodeBuddyContextWindow(deepseekFlash, '200000'), undefined);
});
