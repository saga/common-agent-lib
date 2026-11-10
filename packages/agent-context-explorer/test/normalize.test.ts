import test from 'node:test';
import assert from 'node:assert/strict';
import { diffContext, normalizeContext } from '../src/index.js';

test('normalizes OpenAI-compatible messages, tool calls and usage', () => {
  const value = normalizeContext({ model: 'example', messages: [{ role: 'system', content: 'Be precise' }, { role: 'user', content: [{ type: 'text', text: 'Hello' }] }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }, { choices: [{ message: { role: 'assistant', content: 'Hi', tool_calls: [{ id: 'c1', function: { name: 'lookup', arguments: '{}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
  assert.equal(value.messages.length, 2); assert.equal(value.messages[0]?.role, 'system'); assert.equal(value.tools[0]?.name, 'lookup');
  assert.equal(value.responseMessages[0]?.parts[1]?.kind, 'tool-call'); assert.equal(value.usage?.inputTokens, 12); assert.equal(value.usage?.outputTokens, 3);
});
test('normalizes Anthropic-style blocks and redacts secrets', () => {
  const value = normalizeContext({ model: 'claude', system: 'Rules', api_key: 'secret-value', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }, { type: 'text', text: 'answer' }] }] }, { content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(value.messages[0]?.parts[0]?.kind, 'thinking'); assert.equal((value.rawRequest as Record<string, unknown>).api_key, '[REDACTED]'); assert.equal(value.usage?.totalTokens, undefined);
});
test('diff identifies appended and changed messages', () => {
  const before = normalizeContext({ messages: [{ role: 'user', content: 'A' }] }); const after = normalizeContext({ messages: [{ role: 'user', content: 'B' }, { role: 'assistant', content: 'C' }] });
  const diff = diffContext(before.messages, after.messages); assert.equal(diff.changed, 1); assert.equal(diff.added, 1);
});
