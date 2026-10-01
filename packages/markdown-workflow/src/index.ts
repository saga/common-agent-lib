export type WorkflowNodeType = 'task' | 'gate' | 'review' | 'end' | 'stop';

export interface WorkflowRoute {
  outcome: string;
  target: string;
  line: number;
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  title: string;
  objective?: string;
  visible: boolean;
  completeWhen?: string;
  body: string;
  attrs: Record<string, string>;
  routes: WorkflowRoute[];
  line: number;
}

export interface WorkflowDefinition {
  id: string;
  start: string;
  nodes: WorkflowNode[];
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
    nodes.push({
      id: current.id,
      type: current.type,
      title: attrs.title || current.title,
      objective: attrs.objective,
      visible: attrs.visible !== 'false',
      completeWhen: attrs.completeWhen,
      body: current.bodyLines.join('\n').trim(),
      attrs,
      routes: current.routes,
      line: current.line,
    });
    current = undefined;
  };

  const headingPattern = /^##\s+@(flow|task|gate|review|end|stop)\s+([A-Za-z0-9._:-]+)\s*$/i;
  const routePattern = /^(?:[-*]\s+)?([A-Za-z0-9._:-]+)\s*->\s*([A-Za-z0-9._:-]+)\s*$/;
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
        line: node.line,
        nodeId: node.id,
        message: '重复的 Workflow node：' + node.id,
      });
      continue;
    }
    nodeMap.set(node.id, node);
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
          line: node.line,
          nodeId: node.id,
          message: '@' + node.type + ' ' + node.id + ' 不应该继续定义 route。',
        });
      }
    } else if (node.routes.length === 0) {
      issues.push({
        code: 'node-without-route',
        line: node.line,
        nodeId: node.id,
        message: node.id + ' 没有定义 route。',
      });
    }

    for (const route of node.routes) {
      if (!nodeMap.has(route.target)) {
        issues.push({
          code: 'missing-route-target',
          line: route.line,
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
          line: node.line,
          nodeId: node.id,
          message: '节点不可从 start 到达：' + node.id,
        });
      }
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
