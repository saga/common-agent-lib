import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyWorkflowChanges,
  analyzeWorkflowDefinition,
  buildWorkflowState,
  diffWorkflowDefinitions,
  parseAndValidateWorkflow,
  parseWorkflowMarkdown,
  WorkflowRuntime,
  type WorkflowRunEvent,
} from '../src/index.js';

const markdown = `---
name: demo
metadata:
  kind: workflow
---

# Demo

## @flow demo

start -> intake

## @task intake

title: 接到任务
objective: 明确目标
completeWhen: goal

- success -> inspect

## @task inspect

title: 检查资料
completeWhen: evidence-ready

- success -> review-gate
- retry -> intake

## @gate review-gate

title: 人工检查
completeWhen: gate-passed

- pass -> done
- retry -> inspect

## @end done

title: 完成
visible: false
`;

test('parses and validates a Markdown workflow', () => {
  const result = parseAndValidateWorkflow(markdown);
  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(result.definition.id, 'demo');
  assert.equal(result.definition.start, 'intake');
  assert.equal(result.definition.nodes.length, 4);
});

test('returns structural errors before runtime use', () => {
  const parsed = parseWorkflowMarkdown(`## @flow broken

start -> missing

## @task intake
- success -> missing
`);
  assert.ok(parsed.definition);

  const result = parseAndValidateWorkflow(`## @flow broken

start -> missing

## @task intake
- success -> missing
`);
  assert.ok(result.issues.some((issue) => issue.code === 'missing-start-target'));
});

test('builds state from deterministic facts, not agent self-report', () => {
  const result = parseAndValidateWorkflow(markdown);
  assert.ok(result.definition);

  const state = buildWorkflowState(
    result.definition!,
    { goal: true, evidenceReady: false },
    (condition, facts) => {
      if (condition === 'goal') return facts.goal;
      if (condition === 'evidence-ready') return facts.evidenceReady;
      return false;
    },
  );

  assert.deepEqual(state.completedNodeIds, ['intake']);
  assert.equal(state.currentNodeId, 'inspect');
});

test('resolves only declared transitions', () => {
  const result = parseAndValidateWorkflow(markdown);
  const runtime = new WorkflowRuntime(result.definition!);

  assert.equal(runtime.transition('inspect', 'retry')?.id, 'intake');
  assert.equal(runtime.transition('inspect', 'unknown'), undefined);
});


test('supports actor, conditional routes, and data dependencies', () => {
  const result = parseAndValidateWorkflow(`## @flow demo

start -> intake

## @task intake
actor: system
requires: request
produces: normalized-request
completeWhen: goal
- success -> review if goal
- failure -> stop

## @review review
actor: human
requires: normalized-request
produces: approved-request
- approved -> done

## @end done
`);
  assert.equal(result.issues.length, 0);
  assert.equal(result.definition?.nodes[0]?.actor, 'system');
  assert.deepEqual(result.definition?.nodes[0]?.requires, ['request']);
  assert.deepEqual(result.definition?.nodes[0]?.produces, ['normalized-request']);
  assert.equal(result.definition?.nodes[0]?.routes[0]?.condition, 'goal');
});


test('applies and diffs typed workflow changes', () => {
  const result = parseAndValidateWorkflow(markdown);
  const before = result.definition!;
  const after = applyWorkflowChanges(before, [
    { type: 'update-node', nodeId: 'intake', patch: { title: '接收并澄清目标' } },
    {
      type: 'add-node',
      node: {
        id: 'human-check',
        type: 'review',
        title: '人工确认',
        visible: true,
        completion: 'agent',
        actor: 'human',
        body: '',
        attrs: {},
        routes: [{ outcome: 'approved', target: 'inspect' }],
      },
    },
    { type: 'update-route', nodeId: 'intake', outcome: 'success', patch: { target: 'human-check' } },
    { type: 'remove-route', nodeId: 'inspect', outcome: 'retry' },
    { type: 'add-route', nodeId: 'inspect', route: { outcome: 'failure', target: 'intake' } },
  ]);
  const diff = diffWorkflowDefinitions(before, after);
  assert.ok(diff.length >= 4);
  const replayed = applyWorkflowChanges(before, diff);
  assert.deepEqual(replayed, after);
});

test('workflow analysis warns about ambiguous routing and unmet outputs', () => {
  const result = parseAndValidateWorkflow(`## @flow demo

start -> a

## @task a
requires: missing-input
- yes -> done if goal
- no -> done if current-state

## @end done
`);
  assert.equal(result.issues.length, 0);
  const analysis = analyzeWorkflowDefinition(result.definition!);
  assert.ok(analysis.some((item) => item.code === 'multiple-conditional-routes'));
  assert.ok(analysis.some((item) => item.code === 'conditional-route-without-fallback'));
  assert.ok(analysis.some((item) => item.code === 'missing-required-producer'));
});
