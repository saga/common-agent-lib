export type WorkflowNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';

export interface WorkflowRoute {
  outcome: string;
  target: string;
  /** Optional deterministic routing condition. */
  condition?: string;
  line?: number;
}

export type WorkflowActor = 'agent' | 'human' | 'system';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  objective?: string;
  visible: boolean;
  completion?: 'deterministic' | 'agent';
  actor?: WorkflowActor;
  completeWhen?: string;
  tools?: string[];
  requires?: string[];
  produces?: string[];
  body: string;
  attrs: Record<string, string>;
  routes: WorkflowRoute[];
  line?: number;
}

export interface WorkflowDefinition {
  id: string;
  start: string;
  nodes: WorkflowNode[];
}

export type WorkflowChange =
  | { type: 'replace-definition'; definition: WorkflowDefinition }
  | { type: 'add-node'; node: WorkflowNode }
  | { type: 'update-node'; nodeId: string; patch: Partial<Omit<WorkflowNode, 'id' | 'routes'>> }
  | { type: 'remove-node'; nodeId: string }
  | { type: 'add-route'; nodeId: string; route: WorkflowRoute }
  | { type: 'update-route'; nodeId: string; outcome: string; patch: { target?: string; condition?: string | null } }
  | { type: 'remove-route'; nodeId: string; outcome: string };

export interface WorkflowAnalysisIssue {
  severity: 'warning' | 'error';
  code:
    | 'multiple-conditional-routes'
    | 'conditional-route-without-fallback'
    | 'missing-required-producer'
    | 'duplicate-produced-output';
  nodeId?: string;
  message: string;
}

export interface WorkflowPendingInteraction {
  id: string;
  nodeId: string;
  reason: string;
  requestedAt: string;
}

export type WorkflowRunEventType =
  | 'workflow-started'
  | 'node-started'
  | 'node-completed'
  | 'node-waiting'
  | 'node-failed'
  | 'workflow-completed'
  | 'workflow-stopped'
  | 'transition-rejected';

export interface WorkflowRunEvent {
  id: string;
  runId: string;
  workflowId: string;
  workflowVersion: number;
  type: WorkflowRunEventType;
  timestamp: string;
  nodeId?: string;
  outcome?: string;
  error?: string;
  data?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cost?: number;
  };
}

export interface WorkflowIssue {
  code:
    | 'missing-flow'
    | 'duplicate-flow'
    | 'missing-start'
    | 'missing-start-target'
    | 'duplicate-node'
    | 'missing-route-target'
    | 'node-without-route'
    | 'no-end'
    | 'unreachable-node'
    | 'unknown-block';
  line: number;
  nodeId?: string;
  message: string;
}

export interface ParsedWorkflow {
  definition?: WorkflowDefinition;
  issues: WorkflowIssue[];
}

export interface WorkflowStageState {
  id: string;
  title: string;
  objective: string;
  status: 'completed' | 'current' | 'future' | 'locked';
  nodeType: WorkflowNodeType;
  unlocked: boolean;
}

export interface WorkflowState {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  unlockedNodeIds: string[];
  stages: WorkflowStageState[];
}

export type CompletionEvaluator<TFacts> = (
  condition: string | undefined,
  facts: TFacts,
  node: WorkflowNode,
) => boolean;

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/);
  if (!match) return markdown;
  return '\n'.repeat(match[0].split('\n').length - 1) +
    markdown.slice(match[0].length);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 只解析公共 DSL 的结构。
 *
 * 这里不解释业务语义，也不做权限判断。宿主应用如果需要更复杂的属性，
 * 可以从 node.attrs 读取自己的扩展字段，但公共 parser 不会替它们赋予安全含义。
 */
export function parseWorkflowMarkdown(markdown: string): ParsedWorkflow {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const issues: WorkflowIssue[] = [];
  const nodes: WorkflowNode[] = [];
  let workflowId: string | undefined;
  let declaredStart: string | undefined;
  let current:
    | {
        id: string;
        type: WorkflowNodeType;
        title: string;
        attrs: Record<string, string>;
        bodyLines: string[];
        routes: WorkflowRoute[];
        line: number;
      }
    | undefined;

  const commitNode = () => {
    if (!current) return;
    const attrs = current.attrs;
    const actor = attrs.actor === 'human' || attrs.actor === 'system' ? attrs.actor : 'agent';
    const completion = attrs.completion === 'agent' || attrs.completion === 'deterministic'
      ? attrs.completion
      : attrs.completeWhen
        ? 'deterministic'
        : 'agent';
    nodes.push({
      id: current.id,
      type: current.type,
      title: attrs.title || current.title,
      objective: attrs.objective,
      visible: attrs.visible !== 'false',
      completion,
      actor,
      completeWhen: attrs.completeWhen,
      tools: attrs.tools ? attrs.tools.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      requires: attrs.requires ? attrs.requires.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      produces: attrs.produces ? attrs.produces.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
      body: current.bodyLines.join('\n').trim(),
      attrs,
      routes: current.routes,
      line: current.line,
    });
    current = undefined;
  };

  const headingPattern = /^##\s+@(flow|task|gate|review|end|stop)\s+([A-Za-z0-9._:-]+)\s*$/i;
  const routePattern = /^(?:[-*]\s+)?([A-Za-z0-9._:-]+)\s*->\s*([A-Za-z0-9._:-]+)(?:\s+if\s+([A-Za-z0-9._:-]+))?\s*$/;
  const attrPattern = /^([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*?)\s*$/;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (!trimmed) {
      if (current) current.bodyLines.push('');
      continue;
    }

    const heading = headingPattern.exec(trimmed);
    if (heading) {
      commitNode();
      const kind = heading[1]!.toLowerCase();
      const id = normalizeId(heading[2]!);

      if (kind === 'flow') {
        if (workflowId) {
          issues.push({
            code: 'duplicate-flow',
            line: lineNumber,
            message: '重复定义 @flow：' + id,
          });
        } else {
          workflowId = id;
        }
      } else {
        current = {
          id,
          type: kind as WorkflowNodeType,
          title: id,
          attrs: {},
          bodyLines: [],
          routes: [],
          line: lineNumber,
        };
      }
      continue;
    }

    if (trimmed.startsWith('@')) {
      issues.push({
        code: 'unknown-block',
        line: lineNumber,
        message: '不认识的 Workflow block：' + trimmed,
      });
      continue;
    }

    const route = routePattern.exec(trimmed);
    if (!current && route && normalizeId(route[1]!) === 'start') {
      declaredStart = normalizeId(route[2]!);
      continue;
    }

    if (!current) continue;

    if (route) {
      current.routes.push({
        outcome: normalizeId(route[1]!),
        target: normalizeId(route[2]!),
        ...(route[3] ? { condition: normalizeId(route[3]!) } : {}),
        line: lineNumber,
      });
      continue;
    }

    const attr = attrPattern.exec(trimmed);
    if (attr && current.routes.length === 0) {
      current.attrs[attr[1]!] = attr[2] ?? '';
      continue;
    }

    current.bodyLines.push(raw);
  }

  commitNode();

  if (!workflowId) {
    issues.push({
      code: 'missing-flow',
      line: 1,
      message: '没有找到 @flow。',
    });
  }

  if (!workflowId) return { issues };

  return {
    definition: {
      id: workflowId,
      start: declaredStart ?? '',
      nodes,
    },
    issues,
  };
}

export function validateWorkflow(
  definition: WorkflowDefinition,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodeMap = new Map<string, WorkflowNode>();

  if (!definition.start) {
    issues.push({
      code: 'missing-start',
      line: 1,
      message: 'Workflow 必须定义 start -> <node>。',
    });
  }

  for (const node of definition.nodes) {
    if (nodeMap.has(node.id)) {
      issues.push({
        code: 'duplicate-node',
        line: node.line ?? 1,
        nodeId: node.id,
        message: '重复的 Workflow node：' + node.id,
      });
      continue;
    }
    nodeMap.set(node.id, node);
    if (node.actor && !['agent', 'human', 'system'].includes(node.actor)) {
      issues.push({
        code: 'unknown-block',
        line: node.line ?? 1,
        nodeId: node.id,
        message: '未知 actor：' + node.actor,
      });
    }
  }

  if (definition.start && !nodeMap.has(definition.start)) {
    issues.push({
      code: 'missing-start-target',
      line: 1,
      message: 'start 指向不存在的节点：' + definition.start,
    });
  }

  let hasEnd = false;
  for (const node of definition.nodes) {
    if (node.type === 'end' || node.type === 'stop') {
      if (node.type === 'end') hasEnd = true;
      if (node.routes.length > 0) {
        issues.push({
          code: 'node-without-route',
          line: node.line ?? 1,
          nodeId: node.id,
          message: '@' + node.type + ' ' + node.id + ' 不应该继续定义 route。',
        });
      }
    } else if (node.routes.length === 0) {
      issues.push({
        code: 'node-without-route',
        line: node.line ?? 1,
        nodeId: node.id,
        message: node.id + ' 没有定义 route。',
      });
    }

    for (const route of node.routes) {
      if (!nodeMap.has(route.target)) {
        issues.push({
          code: 'missing-route-target',
          line: route.line ?? 1,
          nodeId: node.id,
          message: node.id + ' 指向不存在的节点：' + route.target,
        });
      }
    }
  }

  if (!hasEnd) {
    issues.push({
      code: 'no-end',
      line: 1,
      message: 'Workflow 至少需要一个 @end。',
    });
  }

  if (definition.start && nodeMap.has(definition.start)) {
    const reachable = new Set<string>();
    const queue = [definition.start];

    while (queue.length) {
      const current = queue.shift()!;
      if (reachable.has(current)) continue;
      reachable.add(current);
      for (const route of nodeMap.get(current)?.routes ?? []) {
        if (nodeMap.has(route.target)) queue.push(route.target);
      }
    }

    for (const node of definition.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: 'unreachable-node',
          line: node.line ?? 1
          nodeId: node.id,
          message: '节点不可从 start 到达：' + node.id,
        });
      }
    }
  }

  return issues;
}


function cloneWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => ({
      ...node,
      attrs: { ...node.attrs },
      tools: node.tools ? [...node.tools] : undefined,
      requires: node.requires ? [...node.requires] : undefined,
      produces: node.produces ? [...node.produces] : undefined,
      routes: node.routes.map((route) => ({ ...route })),
    })),
  };
}

/**
 * Apply typed semantic edits. UI frameworks must not be part of this function.
 * Invalid edits throw immediately; callers can validate the returned definition before persistence.
 */
export function applyWorkflowChanges(
  definition: WorkflowDefinition,
  changes: WorkflowChange[],
): WorkflowDefinition {
  let next = cloneWorkflowDefinition(definition);

  for (const change of changes) {
    switch (change.type) {
      case 'replace-definition':
        next = cloneWorkflowDefinition(change.definition);
        break;
      case 'add-node':
        if (next.nodes.some((node) => node.id === change.node.id)) {
          throw new Error('不能新增重复 Workflow node：' + change.node.id);
        }
        next.nodes.push({
          ...change.node,
          attrs: { ...change.node.attrs },
          routes: change.node.routes.map((route) => ({ ...route })),
        });
        break;
      case 'update-node': {
        const node = next.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        Object.assign(node, change.patch);
        break;
      }
      case 'remove-node':
        if (change.nodeId === next.start) {
          throw new Error('不能删除 Workflow start node：' + change.nodeId);
        }
        next.nodes = next.nodes
          .filter((node) => node.id !== change.nodeId)
          .map((node) => ({
            ...node,
            routes: node.routes.filter((route) => route.target !== change.nodeId),
          }));
        break;
      case 'add-route': {
        const node = next.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        if (node.routes.some((route) => route.outcome.toLowerCase() === change.route.outcome.toLowerCase())) {
          throw new Error(node.id + ' 已经存在 outcome=' + change.route.outcome);
        }
        node.routes.push({ ...change.route });
        break;
      }
      case 'update-route': {
        const node = next.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        const index = node.routes.findIndex(
          (route) => route.outcome.toLowerCase() === change.outcome.toLowerCase(),
        );
        if (index < 0) throw new Error(node.id + ' 不存在 outcome=' + change.outcome);
        const updated = { ...node.routes[index], ...change.patch };
        if (change.patch.condition === null) delete updated.condition;
        if (node.routes.some((route, routeIndex) =>
          routeIndex !== index && route.outcome.toLowerCase() === updated.outcome.toLowerCase()
        )) {
          throw new Error(node.id + ' 更新后产生重复 outcome=' + updated.outcome);
        }
        node.routes[index] = updated;
        break;
      }
      case 'remove-route': {
        const node = next.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        node.routes = node.routes.filter(
          (route) => route.outcome.toLowerCase() !== change.outcome.toLowerCase(),
        );
        break;
      }
    }
  }

  return next;
}

/** Generate a compact typed diff between two semantic Workflow definitions. */
export function diffWorkflowDefinitions(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): WorkflowChange[] {
  const changes: WorkflowChange[] = [];
  if (before.id !== after.id || before.start !== after.start) {
    changes.push({ type: 'replace-definition', definition: after });
    return changes;
  }

  const beforeMap = new Map(before.nodes.map((node) => [node.id, node]));
  const afterMap = new Map(after.nodes.map((node) => [node.id, node]));

  for (const node of before.nodes) {
    if (!afterMap.has(node.id)) changes.push({ type: 'remove-node', nodeId: node.id });
  }
  for (const node of after.nodes) {
    if (!beforeMap.has(node.id)) changes.push({ type: 'add-node', node });
  }

  const comparableNode = (node: WorkflowNode) => ({
    type: node.type,
    title: node.title,
    objective: node.objective,
    visible: node.visible,
    completion: node.completion,
    actor: node.actor,
    completeWhen: node.completeWhen,
    tools: node.tools,
    requires: node.requires,
    produces: node.produces,
    body: node.body,
    attrs: node.attrs,
  });

  for (const [id, oldNode] of beforeMap) {
    const newNode = afterMap.get(id);
    if (!newNode) continue;
    if (JSON.stringify(comparableNode(oldNode)) !== JSON.stringify(comparableNode(newNode))) {
      changes.push({
        type: 'update-node',
        nodeId: id,
        patch: {
          ...comparableNode(newNode),
        },
      });
    }

    const oldRoutes = new Map(oldNode.routes.map((route) => [route.outcome.toLowerCase(), route]));
    const newRoutes = new Map(newNode.routes.map((route) => [route.outcome.toLowerCase(), route]));
    for (const oldRoute of oldNode.routes) {
      if (!newRoutes.has(oldRoute.outcome.toLowerCase())) {
        changes.push({ type: 'remove-route', nodeId: id, outcome: oldRoute.outcome });
      }
    }
    for (const newRoute of newNode.routes) {
      const oldRoute = oldRoutes.get(newRoute.outcome.toLowerCase());
      if (!oldRoute) {
        changes.push({ type: 'add-route', nodeId: id, route: newRoute });
      } else if (JSON.stringify({ target: oldRoute.target, condition: oldRoute.condition })
        !== JSON.stringify({ target: newRoute.target, condition: newRoute.condition })) {
        changes.push({
          type: 'update-route',
          nodeId: id,
          outcome: oldRoute.outcome,
          patch: {
            target: newRoute.target,
            condition: newRoute.condition ?? null,
          },
        });
      }
    }
  }

  return changes;
}

/**
 * Static analysis complements structural validation.
 * It intentionally reports warnings for ambiguous workflow authoring rather than inventing a rule engine.
 */
export function analyzeWorkflowDefinition(
  definition: WorkflowDefinition,
): WorkflowAnalysisIssue[] {
  const issues: WorkflowAnalysisIssue[] = [];
  const producedBy = new Map<string, string[]>();

  for (const node of definition.nodes) {
    for (const output of node.produces ?? []) {
      const key = output.trim().toLowerCase();
      if (!key) continue;
      producedBy.set(key, [...(producedBy.get(key) ?? []), node.id]);
    }
  }

  for (const node of definition.nodes) {
    const conditional = node.routes.filter((route) => Boolean(route.condition));
    if (conditional.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'multiple-conditional-routes',
        nodeId: node.id,
        message: node.id + ' 有多个条件分支；当前按 DSL 顺序匹配，条件同时成立时前面的优先。',
      });
    }
    if (conditional.length && !node.routes.some((route) => !route.condition)) {
      issues.push({
        severity: 'warning',
        code: 'conditional-route-without-fallback',
        nodeId: node.id,
        message: node.id + ' 只有条件分支，没有 fallback outcome；没有条件命中时可能无法继续。',
      });
    }

    for (const input of node.requires ?? []) {
      const key = input.trim().toLowerCase();
      if (!key) continue;
      if (!producedBy.has(key)) {
        issues.push({
          severity: 'warning',
          code: 'missing-required-producer',
          nodeId: node.id,
          message: node.id + ' 依赖产物“' + input + '”，但当前 Workflow 没有声明任何 produces。',
        });
      }
    }
  }

  for (const [output, nodes] of producedBy) {
    if (nodes.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'duplicate-produced-output',
        message: '产物“' + output + '”由多个节点产生：' + nodes.join('、') + '。',
      });
    }
  }

  return issues;
}

/** 一次完成 Markdown → AST → structural validation。 */
export function parseAndValidateWorkflow(markdown: string): {
  definition?: WorkflowDefinition;
  issues: WorkflowIssue[];
} {
  const parsed = parseWorkflowMarkdown(markdown);
  if (!parsed.definition || parsed.issues.length) {
    return parsed;
  }

  const validationIssues = validateWorkflow(parsed.definition);
  if (validationIssues.length) {
    return {
      definition: parsed.definition,
      issues: validationIssues,
    };
  }

  return parsed;
}

function defaultEvaluate<TFacts>(
  condition: string | undefined,
  _facts: TFacts,
): boolean {
  return Boolean(condition && condition.trim());
}

/**
 * 根据确定性 facts 计算当前 Journey。
 *
 * 这个函数故意不执行节点，也不猜 condition 的业务含义。
 * 应用自己决定 facts 和 evaluator。
 */
export function buildWorkflowState<TFacts>(
  definition: WorkflowDefinition,
  facts: TFacts,
  evaluate: CompletionEvaluator<TFacts> = defaultEvaluate,
): WorkflowState {
  const visibleNodes = definition.nodes.filter(
    (node) => node.visible && node.type !== 'stop',
  );

  const completedNodeIds = visibleNodes
    .filter((node) => evaluate(node.completeWhen, facts, node))
    .map((node) => node.id);

  const currentIndex = visibleNodes.findIndex(
    (node) => !completedNodeIds.includes(node.id),
  );

  const currentNodeId =
    currentIndex >= 0
      ? visibleNodes[currentIndex]!.id
      : visibleNodes.at(-1)?.id ?? definition.start;

  const stages = visibleNodes.map((node, index) => {
    const completed = completedNodeIds.includes(node.id);
    const current = node.id === currentNodeId;
    let status: WorkflowStageState['status'] = 'locked';

    if (completed) status = 'completed';
    else if (current) status = 'current';
    else if (index <= currentIndex + 1) status = 'future';

    return {
      id: node.id,
      title: node.title,
      objective: node.objective || node.title,
      status,
      nodeType: node.type,
      unlocked: status !== 'locked',
    };
  });

  return {
    workflowId: definition.id,
    currentNodeId,
    completedNodeIds,
    unlockedNodeIds: stages.filter((stage) => stage.unlocked).map((stage) => stage.id),
    stages,
  };
}

/**
 * 轻量 runtime：只处理已声明的 route，不执行任何业务 action。
 *
 * 例如应用完成了 gate，并得到 outcome = "pass"，
 * runtime 只负责告诉应用下一节点是谁。
 */
export class WorkflowRuntime<TFacts = unknown> {
  constructor(
    public readonly definition: WorkflowDefinition,
    private readonly evaluate: CompletionEvaluator<TFacts> = defaultEvaluate,
  ) {}

  state(facts: TFacts): WorkflowState {
    return buildWorkflowState(this.definition, facts, this.evaluate);
  }

  node(nodeId: string): WorkflowNode | undefined {
    return this.definition.nodes.find((node) => node.id === normalizeId(nodeId));
  }

  transition(nodeId: string, outcome: string): WorkflowNode | undefined {
    const node = this.node(nodeId);
    if (!node) return undefined;
    const route = node.routes.find(
      (candidate) => candidate.outcome === normalizeId(outcome),
    );
    return route ? this.node(route.target) : undefined;
  }
}
