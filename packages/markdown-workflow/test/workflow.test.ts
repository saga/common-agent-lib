import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyWorkflowChanges,
  buildWorkflowState,
  diffWorkflowDefinitions,
  parseAndValidateWorkflow,
  parseWorkflowMarkdown,
  WorkflowRuntime,
  type WorkflowExecution,
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

- success -> review
- retry -> intake

## @review review

title: 人工确认

- approved -> done
- retry -> inspect

## @end done

title: 完成
`;

test('parses the minimal Markdown workflow', () => {
  const result = parseAndValidateWorkflow(markdown);
  assert.equal(result.issues.length, 0);
  assert.ok(result.definition);
  assert.equal(result.definition.id, 'demo');
  assert.equal(result.definition.start, 'intake');
  assert.equal(result.definition.nodes.length, 4);
  assert.equal(result.definition.nodes.find((node) => node.id === 'review')?.actor, 'human');
});

test('rejects removed DSL fields instead of silently accepting them', () => {
  const result = parseWorkflowMarkdown(`## @flow demo

start -> intake

## @task intake
completion: agent
tools: read,url
- success -> done

## @end done
`);
  assert.ok(result.issues.some((issue) => issue.code === 'unknown-attribute'));
});

test('validates duplicate outcomes, unreachable nodes and dead-end cycles', () => {
  const result = parseAndValidateWorkflow(`## @flow broken

start -> a

## @task a
- success -> b
- SUCCESS -> c

## @task b
- retry -> b

## @task c
- success -> done

## @task unreachable
- success -> done

## @end done
`);
  assert.ok(result.issues.some((issue) => issue.code === 'duplicate-outcome'));
  assert.ok(result.issues.some((issue) => issue.code === 'unreachable-node'));
  assert.ok(result.issues.some((issue) => issue.code === 'cannot-reach-end'));
});

test('deterministic completion uses host facts and follows the first route', () => {
  const result = parseAndValidateWorkflow(markdown);
  assert.ok(result.definition);

  const state = buildWorkflowState(
    result.definition!,
    { goal: true },
    (condition, facts) => condition === 'goal' && facts.goal === true,
  );

  assert.deepEqual(state.execution.completedNodeIds, ['intake']);
  assert.equal(state.execution.currentNodeId, 'inspect');
  assert.equal(state.stages.find((stage) => stage.id === 'inspect')?.status, 'current');
});

test('human review becomes waiting and cannot be auto-completed', () => {
  const result = parseAndValidateWorkflow(markdown);
  assert.ok(result.definition);

  const state = buildWorkflowState(
    result.definition!,
    { goal: true },
    (condition, facts) => condition === 'goal' && facts.goal === true,
  );

  const execution: WorkflowExecution = {
    ...state.execution,
    currentNodeId: 'review',
    completedNodeIds: ['intake', 'inspect'],
    status: 'waiting',
  };

  const next = new WorkflowRuntime(result.definition!).state(
    { goal: true },
    execution,
  );

  assert.equal(next.execution.status, 'waiting');
  assert.equal(next.execution.currentNodeId, 'review');
});

test('retry is a normal declared route, not a special node type', () => {
  const result = parseAndValidateWorkflow(markdown);
  const runtime = new WorkflowRuntime(result.definition!);

  assert.equal(runtime.transition('inspect', 'retry')?.id, 'intake');
  assert.equal(runtime.transition('inspect', 'unknown'), undefined);
});

test('applyTransition updates execution without performing external work', () => {
  const result = parseAndValidateWorkflow(markdown);
  const runtime = new WorkflowRuntime(result.definition!);
  const execution = runtime.applyTransition(
    {
      workflowId: 'demo',
      currentNodeId: 'inspect',
      completedNodeIds: ['intake'],
      status: 'active',
    },
    'inspect',
    'retry',
  );

  assert.equal(execution.currentNodeId, 'intake');
  assert.deepEqual(execution.completedNodeIds, ['intake', 'inspect']);
  assert.equal(execution.status, 'active');
});

test('applies and diffs typed workflow changes', () => {
  const result = parseAndValidateWorkflow(markdown);
  const before = result.definition!;
  const after = applyWorkflowChanges(before, [
    {
      type: 'add-node',
      node: {
        id: 'human-check',
        type: 'review',
        title: '人工确认',
        actor: 'human',
        body: '',
        routes: [{ outcome: 'approved', target: 'inspect' }],
      },
    },
    {
      type: 'update-route',
      nodeId: 'intake',
      outcome: 'success',
      patch: { target: 'human-check' },
    },
  ]);
  const diff = diffWorkflowDefinitions(before, after);
  assert.ok(diff.length >= 2);
  const replayed = applyWorkflowChanges(before, diff);
  assert.deepEqual(replayed, after);
});
