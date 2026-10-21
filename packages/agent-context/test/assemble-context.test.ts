import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleContext,
  ContextAssemblyInputError,
  type ContextSection,
} from '../src/index.js';

test('renders selected context in input order even when priority selects in reverse order', () => {
  const result = assembleContext({
    sections: [
      { id: 'rules', title: 'Rules', items: [{ id: 'rule', text: 'Follow the task contract.', required: true }] },
      { id: 'retrieval', title: 'Evidence', items: [{ id: 'evidence', text: 'Evidence item.', priority: 10 }] },
    ],
    budget: { maxUnits: 200 },
  });

  assert.equal(result.text, '## Rules\nFollow the task contract.\n\n## Evidence\nEvidence item.');
  assert.deepEqual(result.includedItems.map((entry) => entry.item.id), ['rule', 'evidence']);
  assert.equal(result.budget.exceeded, false);
});

test('selects higher-priority optional context first while retaining stable rendering order', () => {
  const result = assembleContext({
    sections: [
      { id: 'low', title: 'Low', items: [{ id: 'low-item', text: 'low-priority-long-item', priority: 0 }] },
      { id: 'high', title: 'High', items: [{ id: 'high-item', text: 'H', priority: 50 }] },
    ],
    budget: { maxUnits: 15 },
  });

  assert.deepEqual(result.includedItems.map((entry) => entry.item.id), ['high-item']);
  assert.deepEqual(result.omittedItems.map((entry) => [entry.item.id, entry.reason]), [['low-item', 'budget-exceeded']]);
  assert.equal(result.text, '## High\nH');
  assert.ok(result.budget.usedUnits <= result.budget.maxUnits);
});

test('budget counts rendered headers and separators, not just item body text', () => {
  const result = assembleContext({
    sections: [{ id: 'a', title: 'A long title', items: [{ id: 'item', text: 'body' }] }],
    budget: { maxUnits: 5 },
  });

  assert.equal(result.text, '');
  assert.deepEqual(result.omittedItems.map((entry) => entry.reason), ['budget-exceeded']);
  assert.equal(result.budget.usedUnits, 0);
});

test('required context is never silently dropped when the full rendering exceeds budget', () => {
  const result = assembleContext({
    sections: [
      { id: 'required', title: 'Required', required: true, items: [{ id: 'contract', text: 'MUST REMAIN' }] },
      { id: 'optional', items: [{ id: 'extra', text: 'nice to have' }] },
    ],
    budget: { maxUnits: 5 },
  });

  assert.ok(result.text.includes('MUST REMAIN'));
  assert.ok(result.budget.exceeded);
  assert.ok(result.budget.overflowUnits > 0);
  assert.deepEqual(result.issues.map((issue) => issue.code), ['required-context-exceeds-budget']);
  assert.deepEqual(result.omittedItems.map((entry) => [entry.item.id, entry.reason]), [['extra', 'budget-exceeded']]);
});

test('deduplication prefers required, then higher priority, then original order', () => {
  const result = assembleContext({
    sections: [
      { id: 'first', items: [{ id: 'candidate', text: 'unconfirmed suggestion', dedupeKey: 'term:x', priority: 100 }] },
      { id: 'second', items: [{ id: 'confirmed', text: 'confirmed value', dedupeKey: 'term:x', required: true, priority: 1 }] },
    ],
    budget: { maxUnits: 200 },
  });

  assert.deepEqual(result.includedItems.map((entry) => entry.item.id), ['confirmed']);
  assert.deepEqual(result.omittedItems.map((entry) => ({
    id: entry.item.id,
    reason: entry.reason,
    duplicateOf: entry.duplicateOf,
  })), [{ id: 'candidate', reason: 'duplicate', duplicateOf: 'confirmed' }]);
});

test('provenance and metadata remain attached to included items', () => {
  const sources = [{ id: 'chapter-1-seg-3', kind: 'source-segment', uri: 'document://book/chapter-1#s3', revision: 'r1' }];
  const result = assembleContext({
    sections: [{ id: 'evidence', items: [{
      id: 'memory-item',
      text: 'The quote supports this fact.',
      sources,
      metadata: { status: 'confirmed', score: 0.9 },
    }] }],
    budget: { maxUnits: 200 },
  });

  assert.deepEqual(result.includedItems[0]?.item.sources, sources);
  assert.deepEqual(result.includedItems[0]?.item.metadata, { status: 'confirmed', score: 0.9 });
});

test('deduplication does not merge or overwrite the winning item provenance', () => {
  const result = assembleContext({
    sections: [
      { id: 'a', items: [{ id: 'x1', text: 'Same', dedupeKey: 'same', sources: [{ id: 'source-a' }] }] },
      { id: 'b', items: [{ id: 'x2', text: 'Same', dedupeKey: 'same', sources: [{ id: 'source-b' }] }] },
    ],
    budget: { maxUnits: 100 },
  });

  assert.deepEqual(result.includedItems[0]?.item.sources, [{ id: 'source-a' }]);
  assert.equal(result.omittedItems[0]?.duplicateOf, 'x1');
});

test('caller may inject a model-specific tokenizer/length estimator', () => {
  const result = assembleContext({
    sections: [{ id: 'one', items: [{ id: 'a', text: 'one two three four' }] }],
    budget: { maxUnits: 5, unit: 'tokens' },
    measure: (text) => text.trim() ? text.trim().split(/\s+/).length : 0,
    renderSectionHeader: () => undefined,
  });

  assert.equal(result.text, 'one two three four');
  assert.equal(result.budget.usedUnits, 4);
  assert.equal(result.budget.unit, 'tokens');
});

test('empty optional items are reported and empty required items are rejected', () => {
  const result = assembleContext({
    sections: [{ id: 'optional', items: [{ id: 'blank', text: '  ' }, { id: 'useful', text: 'ok' }] }],
    budget: { maxUnits: 100 },
  });
  assert.deepEqual(result.omittedItems.map((item) => [item.item.id, item.reason]), [['blank', 'empty-content']]);

  assert.throws(() => assembleContext({
    sections: [{ id: 'required', required: true, items: [{ id: 'blank-required', text: '  ' }] }],
    budget: { maxUnits: 100 },
  }), ContextAssemblyInputError);
});

test('invalid or ambiguous inputs fail instead of silently making arbitrary decisions', () => {
  assert.throws(() => assembleContext({
    sections: [{ id: 'same', items: [] }, { id: 'same', items: [] }],
    budget: { maxUnits: 100 },
  }), /Duplicate context section id/);

  assert.throws(() => assembleContext({
    sections: [{ id: 'a', items: [{ id: 'same', text: 'one' }] }, { id: 'b', items: [{ id: 'same', text: 'two' }] }],
    budget: { maxUnits: 100 },
  }), /Duplicate context item id/);

  assert.throws(() => assembleContext({
    sections: [{ id: 'a', items: [{ id: 'bad', text: 'text', priority: Number.NaN }] }],
    budget: { maxUnits: 100 },
  }), /priority must be a finite number/);

  assert.throws(() => assembleContext({ sections: [], budget: { maxUnits: 0 } }), /maxUnits/);
  assert.throws(() => assembleContext({
    sections: [{ id: 'a', items: [{ id: 'x', text: 'x' }] }],
    budget: { maxUnits: 10 },
    measure: () => Number.POSITIVE_INFINITY,
  }), /estimator/);
});

test('section required marks every non-empty item as required', () => {
  const section: ContextSection = {
    id: 'mandatory',
    required: true,
    items: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }],
  };
  const result = assembleContext({ sections: [section], budget: { maxUnits: 1 }, renderSectionHeader: () => undefined });
  assert.deepEqual(result.includedItems.map((entry) => entry.item.id), ['a', 'b']);
  assert.equal(result.budget.exceeded, true);
});
