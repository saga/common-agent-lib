import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertWorkflowSkill, parseSkillMarkdown, validateSkill } from '../src/index.js';

test('parses workflow metadata', () => {
  const manifest = parseSkillMarkdown(['---','name: demo','description: Folded','metadata:','  kind: workflow','---','# Demo','## @flow demo'].join('\n'), { requireKind: true });
  assert.equal(manifest.name, 'demo');
  assert.equal(manifest.metadata?.kind, 'workflow');
});

test('requires kind in strict mode', () => {
  assert.throws(() => parseSkillMarkdown(['---','name: demo','description: Demo','---','# Demo'].join('\n'), { requireKind: true }), /metadata.kind/);
});

test('validates capability/workflow boundaries', () => {
  const capability = ['---','name: search','description: Search','metadata:','  kind: capability','---','# Search'].join('\n');
  const workflow = ['---','name: flow','description: Flow','metadata:','  kind: workflow','---','# Flow','## @flow flow'].join('\n');
  assert.deepEqual(validateSkill(capability), []);
  assert.deepEqual(validateSkill(workflow), []);
});

test('assertWorkflowSkill rejects capability', () => {
  assert.throws(() => assertWorkflowSkill({ name: 'search', description: 'Search', metadata: { kind: 'capability' } }), /workflow/);
});