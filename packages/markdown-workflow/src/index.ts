/**
 * 极小的 Markdown Workflow 公共层。
 *
 * 这个包只解决一件事：把人能读的 Workflow Markdown 转成稳定的结构，做结构检查，
 * 再根据宿主应用提供的 facts 判断确定性步骤是否已经完成。
 *
 * 有意不放进来：工具调用、权限、审批、业务 Action、SQL、MCP、重试策略、外部副作用。
 * 这些都属于宿主应用。这样 Workflow 才能作为导航骨架，而不会慢慢变成一个新的 Agent Framework。
 */

export type WorkflowNodeType = 'task' | 'review' | 'end';

/**
 * Workflow Edge 的唯一业务语义就是 outcome + target。
 * success / failed / retry / approved 都只是字符串；公共 runtime 不解释这些词。
 */
export interface WorkflowRoute {
  outcome: string;
  target: string;
  /** Markdown 中的 1-based 行号，只用于错误提示和 Git review。 */
  line?: number;
}

/**
 * 执行者只保留两种真正有不同运行语义的角色。
 * @review 默认 human；普通 @task 默认 agent，也可以显式写 actor: human。
 */
export type WorkflowActor = 'agent' | 'human';

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  objective?: string;
  actor: WorkflowActor;
  /**
   * 确定性完成条件的名字，不是表达式语言。
   * 具体含义由宿主传入的 CompletionEvaluator 决定。
   */
  completeWhen?: string;
  /** 节点 Markdown 中未参与 DSL 语义的自然语言正文，解析时原样保留。 */
  body: string;
  routes: WorkflowRoute[];
  line?: number;
}

export interface WorkflowDefinition {
  id: string;
  start: string;
  nodes: WorkflowNode[];
}

/**
 * UI 和 AI 共用的语义修改操作。
 * 坐标、viewport、X6/React Flow 对象都不能进入这里。
 */
export type WorkflowChange =
  | { type: 'replace-definition'; definition: WorkflowDefinition }
  | { type: 'add-node'; node: WorkflowNode }
  | { type: 'update-node'; nodeId: string; patch: Partial<Omit<WorkflowNode, 'id' | 'routes' | 'line'>> }
  | { type: 'remove-node'; nodeId: string }
  | { type: 'add-route'; nodeId: string; route: Omit<WorkflowRoute, 'line'> }
  | { type: 'update-route'; nodeId: string; outcome: string; patch: { target?: string } }
  | { type: 'remove-route'; nodeId: string; outcome: string };

export interface WorkflowPendingInteraction {
  id: string;
  nodeId: string;
  reason: string;
  requestedAt: string;
}

/**
 * 运行事件只是一个跨项目都能理解的轻量 contract。
 * 具体怎样持久化、怎样和 tracing/audit 对接，由宿主应用决定。
 */
export type WorkflowRunEventType =
  | 'workflow-started'
  | 'node-started'
  | 'node-completed'
  | 'node-waiting'
  | 'workflow-completed'
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
    | 'duplicate-outcome'
    | 'missing-route-target'
    | 'node-without-route'
    | 'end-with-route'
    | 'no-end'
    | 'unreachable-node'
    | 'cannot-reach-end'
    | 'unknown-block'
    | 'unknown-attribute'
    | 'invalid-complete-when';
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
}

/**
 * Execution 是唯一的运行状态来源；WorkflowState 不再重复 current/completed/unlocked。
 * stages 只是给 UI 用的投影。
 */
export interface WorkflowExecution {
  workflowId: string;
  currentNodeId: string;
  completedNodeIds: string[];
  status: 'active' | 'waiting' | 'completed';
  pendingInteraction?: WorkflowPendingInteraction;
}

export interface WorkflowState {
  workflowId: string;
  stages: WorkflowStageState[];
  execution: WorkflowExecution;
}

/**
 * 宿主应用负责解释 completeWhen。
 * 例如 agentic-data-architect 可以把 goal / current-state / validation 映射到自己的业务状态。
 * 公共包绝不能知道这些 key 的业务含义。
 */
export type CompletionEvaluator<TFacts> = (
  condition: string | undefined,
  facts: TFacts,
  node: WorkflowNode,
) => boolean;

function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---[ \t]*\n[\s\S]*?\n---[ \t]*\n/);
  if (!match) return markdown;
  return markdown.slice(match[0].length);
}

function normalizeId(value: string): string {
  return value.trim().toLowerCase();
}

function cloneWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  return {
    id: definition.id,
    start: definition.start,
    nodes: definition.nodes.map((node) => ({
      ...node,
      routes: node.routes.map((route) => ({ ...route })),
    })),
  };
}

const KNOWN_ATTRIBUTES = new Set(['title', 'objective', 'actor', 'completeWhen']);

/**
 * 解析 Workflow Markdown。
 *
 * 语法只认四种 block：@flow、@task、@review、@end。
 * start 使用单独的 `start -> node` 关系；节点出口使用 `- outcome -> target`。
 *
 * 注意：这里故意不把 Skill 正文解析成 Tool、Permission、Condition DSL。
 * 解析器只保留 Workflow runtime 真正需要的字段。
 */
export function parseWorkflowMarkdown(markdown: string): ParsedWorkflow {
  const lines = stripFrontmatter(markdown).split(/\r?\n/);
  const issues: WorkflowIssue[] = [];
  const nodes: WorkflowNode[] = [];
  let workflowId: string | undefined;
  let declaredStart: string | undefined;
  let current: {
    id: string;
    type: WorkflowNodeType;
    title: string;
    line: number;
    attrs: Record<string, string>;
    bodyLines: string[];
    routes: WorkflowRoute[];
  } | undefined;

  const commitNode = () => {
    if (!current) return;
    const actor = current.type === 'review'
      ? 'human'
      : current.attrs.actor === 'human'
        ? 'human'
        : 'agent';
    nodes.push({
      id: current.id,
      type: current.type,
      title: current.attrs.title || current.title,
      ...(current.attrs.objective ? { objective: current.attrs.objective } : {}),
      actor,
      ...(current.attrs.completeWhen ? { completeWhen: current.attrs.completeWhen } : {}),
      body: current.bodyLines.join('\n').trim(),
      routes: current.routes,
      line: current.line,
    });
    current = undefined;
  };

  const headingPattern = /^##\\s+@(flow|task|review|end)\\s+([A-Za-z0-9._:-]+)\\s*$/i;
  const routePattern = /^(?:[-*]\\s+)?([A-Za-z0-9._:-]+)\\s*->\\s*([A-Za-z0-9._:-]+)\\s*$/;
  const attrPattern = /^([A-Za-z][A-Za-z0-9_-]*)\\s*:\\s*(.*?)\\s*$/;

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
          issues.push({ code: 'duplicate-flow', line: lineNumber, message: '重复定义 @flow：' + id });
        } else {
          workflowId = id;
        }
      } else {
        current = {
          id,
          type: kind as WorkflowNodeType,
          title: id,
          line: lineNumber,
          attrs: {},
          bodyLines: [],
          routes: [],
        };
      }
      continue;
    }

    if (trimmed.startsWith('@')) {
      issues.push({ code: 'unknown-block', line: lineNumber, message: '不认识的 Workflow block：' + trimmed });
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
        line: lineNumber,
      });
      continue;
    }

    const attr = attrPattern.exec(trimmed);
    if (attr && current.routes.length === 0) {
      const key = attr[1]!;
      if (!KNOWN_ATTRIBUTES.has(key)) {
        issues.push({
          code: 'unknown-attribute',
          line: lineNumber,
          nodeId: current.id,
          message: 'Workflow 节点不支持这个属性：' + key,
        });
      } else {
        current.attrs[key] = attr[2] ?? '';
      }
      continue;
    }

    current.bodyLines.push(raw);
  }

  commitNode();
  if (!workflowId) {
    issues.push({ code: 'missing-flow', line: 1, message: '没有找到 @flow。' });
  }
  if (!workflowId) return { issues };

  return {
    definition: { id: workflowId, start: declaredStart ?? '', nodes },
    issues,
  };
}

/**
 * 结构校验只检查 Workflow 自己能知道的事情。
 * 它不会验证 goal 是否真的完成，也不会执行任何工具。
 */
export function validateWorkflow(definition: WorkflowDefinition): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodeMap = new Map<string, WorkflowNode>();

  if (!definition.start) {
    issues.push({ code: 'missing-start', line: 1, message: 'Workflow 必须定义 start -> <node>。' });
  }

  for (const node of definition.nodes) {
    if (nodeMap.has(node.id)) {
      issues.push({ code: 'duplicate-node', line: node.line ?? 1, nodeId: node.id, message: '重复的 Workflow node：' + node.id });
      continue;
    }
    nodeMap.set(node.id, node);
    if (node.completeWhen && node.type === 'end') {
      issues.push({ code: 'invalid-complete-when', line: node.line ?? 1, nodeId: node.id, message: '@end 不应该定义 completeWhen：' + node.completeWhen });
    }
  }

  if (definition.start && !nodeMap.has(definition.start)) {
    issues.push({ code: 'missing-start-target', line: 1, message: 'start 指向不存在的节点：' + definition.start });
  }

  let hasEnd = false;
  for (const node of definition.nodes) {
    if (node.type === 'end') {
      hasEnd = true;
      if (node.routes.length) {
        issues.push({ code: 'end-with-route', line: node.line ?? 1, nodeId: node.id, message: '@end 不能继续定义 route。' });
      }
      continue;
    }

    if (!node.routes.length) {
      issues.push({ code: 'node-without-route', line: node.line ?? 1, nodeId: node.id, message: node.id + ' 没有任何出口。' });
    }

    const outcomes = new Set<string>();
    for (const route of node.routes) {
      const normalizedOutcome = normalizeId(route.outcome);
      if (outcomes.has(normalizedOutcome)) {
        issues.push({ code: 'duplicate-outcome', line: route.line ?? node.line ?? 1, nodeId: node.id, message: node.id + ' 重复使用 outcome：' + route.outcome });
      }
      outcomes.add(normalizedOutcome);
      if (!nodeMap.has(route.target)) {
        issues.push({ code: 'missing-route-target', line: route.line ?? node.line ?? 1, nodeId: node.id, message: node.id + ' 指向不存在的节点：' + route.target });
      }
    }
  }

  if (!hasEnd) issues.push({ code: 'no-end', line: 1, message: 'Workflow 至少需要一个 @end。' });

  if (definition.start && nodeMap.has(definition.start)) {
    const reachable = reachableFrom(definition.start, definition);
    for (const node of definition.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({ code: 'unreachable-node', line: node.line ?? 1, nodeId: node.id, message: '节点不可从 start 到达：' + node.id });
      }
    }
  }

  const terminals = definition.nodes.filter((node) => node.type === 'end').map((node) => node.id);
  const canReachEnd = reverseReachable(terminals, definition);
  for (const node of definition.nodes) {
    if (!canReachEnd.has(node.id)) {
      issues.push({ code: 'cannot-reach-end', line: node.line ?? 1, nodeId: node.id, message: '这一步没有任何路径可以走到 @end：' + node.id });
    }
  }

  return [...new Map(issues.map((issue) => [issue.code + '\\0' + issue.nodeId + '\\0' + issue.line + '\\0' + issue.message, issue])).values()];
}

function reachableFrom(start: string, definition: WorkflowDefinition): Set<string> {
  const nodeMap = new Map(definition.nodes.map((node) => [node.id, node]));
  const reachable = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const route of nodeMap.get(current)?.routes ?? []) {
      if (nodeMap.has(route.target)) queue.push(route.target);
    }
  }
  return reachable;
}

function reverseReachable(targets: string[], definition: WorkflowDefinition): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const node of definition.nodes) {
    for (const route of node.routes) {
      incoming.set(route.target, [...(incoming.get(route.target) ?? []), node.id]);
    }
  }
  const seen = new Set(targets);
  const queue = [...targets];
  while (queue.length) {
    const current = queue.shift()!;
    for (const source of incoming.get(current) ?? []) {
      if (seen.has(source)) continue;
      seen.add(source);
      queue.push(source);
    }
  }
  return seen;
}

/** 完成 Markdown 解析后立即做结构校验，避免无效 Definition 进入 runtime。 */
export function parseAndValidateWorkflow(markdown: string): ParsedWorkflow {
  const parsed = parseWorkflowMarkdown(markdown);
  if (!parsed.definition || parsed.issues.length) return parsed;
  const issues = validateWorkflow(parsed.definition);
  return issues.length ? { definition: parsed.definition, issues } : parsed;
}

/** 新 Workflow 从 start 开始；这里不保存 runId/version，因为那属于宿主持久化层。 */
export function initialWorkflowExecution(definition: WorkflowDefinition): WorkflowExecution {
  const start = definition.nodes.find((node) => node.id === definition.start);
  const waiting = start?.actor === 'human';
  return {
    workflowId: definition.id,
    currentNodeId: definition.start,
    completedNodeIds: [],
    status: waiting ? 'waiting' : 'active',
    ...(waiting && start
      ? {
          pendingInteraction: {
            id: 'pending-' + definition.id + '-' + definition.start,
            nodeId: start.id,
            reason: '等待人工完成“' + start.title + '”。',
            requestedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}

/**
 * 根据当前执行位置和 facts 计算状态。
 * deterministic 节点只使用 completeWhen + 宿主 evaluator，并沿第一个 route 自动前进。
 * retry 自环不会把自己标成 completed；有其它出口时，用户仍可以显式选择 retry 后重新处理。
 */
export function buildWorkflowState<TFacts>(
  definition: WorkflowDefinition,
  facts: TFacts,
  evaluate: CompletionEvaluator<TFacts> = () => false,
  existingExecution?: WorkflowExecution,
): WorkflowState {
  const base = existingExecution && existingExecution.workflowId === definition.id
    ? existingExecution
    : initialWorkflowExecution(definition);
  const completed = new Set(base.completedNodeIds);
  let currentNodeId = base.currentNodeId;
  let status = base.status;
  let pendingInteraction = base.pendingInteraction;

  if (status !== 'waiting' && status !== 'completed') {
    for (let guard = 0; guard <= definition.nodes.length; guard += 1) {
      const node = definition.nodes.find((item) => item.id === currentNodeId);
      if (!node) break;
      if (node.type === 'end') {
        status = 'completed';
        pendingInteraction = undefined;
        break;
      }
      if (node.actor === 'human') {
        status = 'waiting';
        pendingInteraction = pendingInteraction ?? {
          id: 'pending-' + definition.id + '-' + node.id,
          nodeId: node.id,
          reason: '等待人工完成“' + node.title + '”。',
          requestedAt: new Date().toISOString(),
        };
        break;
      }
      if (!node.completeWhen || !evaluate(node.completeWhen, facts, node)) break;
      const route = node.routes[0];
      if (!route || route.target === node.id) break;
      completed.add(node.id);
      currentNodeId = route.target;
    }
  }

  const execution: WorkflowExecution = {
    ...base,
    currentNodeId,
    completedNodeIds: [...completed],
    status,
    ...(status === 'waiting' && pendingInteraction ? { pendingInteraction } : {}),
  };

  const reachable = reachableFrom(currentNodeId, definition);
  const stages = definition.nodes.map((node) => {
    const done = completed.has(node.id);
    return {
      id: node.id,
      title: node.title,
      objective: node.objective || node.title,
      status: done ? 'completed' : node.id === currentNodeId ? 'current' : reachable.has(node.id) ? 'future' : 'locked',
      nodeType: node.type,
    } satisfies WorkflowStageState;
  });

  return { workflowId: definition.id, stages, execution };
}

/**
 * 只解析声明过的 route，不执行任何业务动作。
 * 不存在的 outcome 返回 undefined，让宿主决定如何向用户/Agent 报错。
 */
export class WorkflowRuntime<TFacts = unknown> {
  constructor(
    public readonly definition: WorkflowDefinition,
    private readonly evaluate: CompletionEvaluator<TFacts> = () => false,
  ) {}

  state(facts: TFacts, execution?: WorkflowExecution): WorkflowState {
    return buildWorkflowState(this.definition, facts, this.evaluate, execution);
  }

  node(nodeId: string): WorkflowNode | undefined {
    const id = normalizeId(nodeId);
    return this.definition.nodes.find((node) => node.id === id);
  }

  transition(nodeId: string, outcome: string): WorkflowNode | undefined {
    const node = this.node(nodeId);
    if (!node) return undefined;
    const route = node.routes.find((candidate) => normalizeId(candidate.outcome) === normalizeId(outcome));
    return route ? this.node(route.target) : undefined;
  }

  /** 更新 durable execution；仍然只改变 Workflow 状态，不执行外部副作用。 */
  applyTransition(execution: WorkflowExecution, nodeId: string, outcome: string): WorkflowExecution {
    if (execution.currentNodeId !== nodeId) throw new Error('当前 Workflow 节点不是：' + nodeId);
    const node = this.node(nodeId);
    if (!node) throw new Error('Workflow 当前节点不存在：' + nodeId);
    const target = this.transition(nodeId, outcome);
    if (!target) throw new Error(node.id + ' 没有 outcome=' + outcome + ' 的出口。');
    const completed = new Set(execution.completedNodeIds);
    if (target.id !== node.id) completed.add(node.id);
    const waiting = target.actor === 'human' && target.type !== 'end';
    const { pendingInteraction: _pendingInteraction, ...executionWithoutPending } = execution;
    return {
      ...executionWithoutPending,
      currentNodeId: target.id,
      completedNodeIds: [...completed],
      status: target.type === 'end' ? 'completed' : waiting ? 'waiting' : 'active',
      ...(waiting
        ? {
            pendingInteraction: {
              id: 'pending-' + execution.workflowId + '-' + target.id,
              nodeId: target.id,
              reason: '等待人工完成“' + target.title + '”。',
              requestedAt: new Date().toISOString(),
            },
          }
        : {}),
    };
  }
}

/**
 * 两张语义 Definition 的最小 diff。
 * 用于 AI 修改预览、Undo/Redo 和审计，不包含画布坐标。
 */
export function diffWorkflowDefinitions(before: WorkflowDefinition, after: WorkflowDefinition): WorkflowChange[] {
  if (before.id !== after.id || before.start !== after.start) return [{ type: 'replace-definition', definition: after }];
  const changes: WorkflowChange[] = [];
  const beforeMap = new Map(before.nodes.map((node) => [node.id, node]));
  const afterMap = new Map(after.nodes.map((node) => [node.id, node]));
  for (const node of before.nodes) if (!afterMap.has(node.id)) changes.push({ type: 'remove-node', nodeId: node.id });
  for (const node of after.nodes) if (!beforeMap.has(node.id)) changes.push({ type: 'add-node', node });
  const comparable = (node: WorkflowNode) => ({ type: node.type, title: node.title, objective: node.objective, actor: node.actor, completeWhen: node.completeWhen, body: node.body });
  for (const [id, oldNode] of beforeMap) {
    const newNode = afterMap.get(id);
    if (!newNode) continue;
    if (JSON.stringify(comparable(oldNode)) !== JSON.stringify(comparable(newNode))) {
      changes.push({ type: 'update-node', nodeId: id, patch: comparable(newNode) });
    }
    const oldRoutes = new Map(oldNode.routes.map((route) => [normalizeId(route.outcome), route]));
    const newRoutes = new Map(newNode.routes.map((route) => [normalizeId(route.outcome), route]));
    for (const oldRoute of oldNode.routes) if (!newRoutes.has(normalizeId(oldRoute.outcome))) changes.push({ type: 'remove-route', nodeId: id, outcome: oldRoute.outcome });
    for (const newRoute of newNode.routes) {
      const oldRoute = oldRoutes.get(normalizeId(newRoute.outcome));
      if (!oldRoute) changes.push({ type: 'add-route', nodeId: id, route: { outcome: newRoute.outcome, target: newRoute.target } });
      else if (oldRoute.target !== newRoute.target) changes.push({ type: 'update-route', nodeId: id, outcome: oldRoute.outcome, patch: { target: newRoute.target } });
    }
  }
  return changes;
}

/** 应用语义 Patch；调用方保存前仍必须执行 validateWorkflow。 */
export function applyWorkflowChanges(definitionInput: WorkflowDefinition, changes: WorkflowChange[]): WorkflowDefinition {
  let definition = cloneWorkflowDefinition(definitionInput);
  for (const change of changes) {
    switch (change.type) {
      case 'replace-definition': definition = cloneWorkflowDefinition(change.definition); break;
      case 'add-node':
        if (definition.nodes.some((node) => node.id === change.node.id)) throw new Error('不能新增重复 Workflow node：' + change.node.id);
        definition.nodes.push(cloneWorkflowDefinition({ id: definition.id, start: definition.start, nodes: [change.node] }).nodes[0]!);
        break;
      case 'update-node': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        Object.assign(node, change.patch);
        break;
      }
      case 'remove-node':
        if (change.nodeId === definition.start) throw new Error('不能删除 Workflow start node：' + change.nodeId);
        definition.nodes = definition.nodes.filter((node) => node.id !== change.nodeId).map((node) => ({ ...node, routes: node.routes.filter((route) => route.target !== change.nodeId) }));
        break;
      case 'add-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        if (node.routes.some((route) => normalizeId(route.outcome) === normalizeId(change.route.outcome))) throw new Error(node.id + ' 已经存在 outcome=' + change.route.outcome);
        node.routes.push({ ...change.route });
        break;
      }
      case 'update-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        const index = node.routes.findIndex((route) => normalizeId(route.outcome) === normalizeId(change.outcome));
        if (index < 0) throw new Error(node.id + ' 不存在 outcome=' + change.outcome);
        const route = node.routes[index]!;
        if (change.patch.target !== undefined) route.target = change.patch.target;
        break;
      }
      case 'remove-route': {
        const node = definition.nodes.find((item) => item.id === change.nodeId);
        if (!node) throw new Error('找不到 Workflow node：' + change.nodeId);
        node.routes = node.routes.filter((route) => normalizeId(route.outcome) !== normalizeId(change.outcome));
        break;
      }
    }
  }
  return definition;
}