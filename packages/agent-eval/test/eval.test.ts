import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gradeCase, summarizeEval } from '../src/index.js';

test('grades a case with independent graders', async () => {
  const result = await gradeCase(
    { id: 'case-1', input: '2+2', expected: 4 },
    { output: 4, durationMs: 12, toolCalls: 0 },
    [
      ({ testCase, observation }) => ({
        grader: 'exact',
        pass: observation.output === testCase.expected,
      }),
    ],
  );
  assert.equal(result.grades[0]?.pass, true);
});

test('summarizes failures without hiding which grader failed', () => {
  const summary = summarizeEval([
    { testCase: { id: 'case-1', input: 'x' }, observation: {}, grades: [{ grader: 'exact', pass: false, explanation: 'wrong' }] },
  ]);
  assert.equal(summary.failedCases, 1);
  assert.equal(summary.failures[0]?.grader, 'exact');
});