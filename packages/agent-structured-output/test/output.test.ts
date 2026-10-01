import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as z from 'zod';
import { parseStructuredOutput, validateStructuredOutput } from '../src/index.js';

const Schema = z.object({ answer: z.string(), count: z.number() });

test('parses fenced JSON and validates it', () => {
  const result = parseStructuredOutput('answer:\n```json\n{"answer":"ok","count":2}\n```', Schema);
  assert.equal(result.value.count, 2);
});

test('validates already parsed provider output', () => {
  const value = validateStructuredOutput({ answer: 'ok', count: 1 }, Schema);
  assert.equal(value.answer, 'ok');
});

test('rejects invalid structured output', () => {
  assert.throws(() => validateStructuredOutput({ answer: 'ok' }, Schema), /count/);
});