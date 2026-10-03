# @saga/markdown-workflow

一个独立的 Markdown Workflow parser / validator / state runtime。

设计来源：

- `saga/copilot-server-agent`：Skill Flow、AST、validator、analyzer 的分层
- `saga/agentic-data-architect`：轻量 Markdown Workflow + deterministic Journey state

公共 package 只取两者共同的结构，不绑定某个 Agent SDK，也不绑定业务权限。

## 支持的语法

```markdown
## @flow data-review

start -> intake

## @task intake

title: 明确目标
objective: 先说清楚要解决什么问题。
completeWhen: goal

- success -> inspect

## @gate inspect

title: 检查资料
completeWhen: evidence-ready

- pass -> done
- retry -> intake

## @review approval

title: 人工确认
- approved -> done
- changes-requested -> inspect

## @end done

title: 完成
visible: false
```

支持的 node 类型只有：

- `task`
- `gate`
- `review`
- `end`
- `stop`

公共包暂时不支持 `@command`。涉及业务副作用、审批策略、工具权限的节点应由宿主应用自行扩展，避免把安全模型塞进公共库。

## API

### Parse

```ts
const parsed = parseWorkflowMarkdown(markdown);
```

只负责把 Markdown 变成 AST，并返回语法问题。

### Validate

```ts
const issues = validateWorkflow(parsed.definition!);
```

检查：

- @flow / start
- duplicate node
- route target
- non-terminal node 是否有 route
- 是否存在可达 end

### State

```ts
const state = buildWorkflowState(
  definition,
  facts,
  (condition, facts, node) => evaluateCondition(condition, facts, node),
);
```

公共 runtime 不知道 `goal`、`evidence-ready`、`current-state` 是什么意思。

这些由宿主应用传入 evaluator。

### Transition

```ts
const next = runtime.transition('inspect', 'pass');
```

它只负责：

```text
current node + outcome
       ↓
declared route
       ↓
next node
```

不会执行 SQL、调用 MCP、发邮件、审批或修改业务数据。

## Editor Patch / Analysis

公共 Workflow 还提供一套与 UI 无关的语义编辑操作。

```ts
const next = applyWorkflowChanges(definition, [
  { type: 'update-node', nodeId: 'inspect', patch: { title: '检查资料' } },
  { type: 'add-route', nodeId: 'inspect', route: { outcome: 'retry', target: 'intake' } },
]);
```

UI 和 AI 可以使用同一套 `WorkflowChange`，再调用 `validateWorkflow()` 保存。这样 React Flow、其它编辑器或 CLI 不需要各自实现一套 Workflow 修改规则。

`diffWorkflowDefinitions(before, after)` 可以把两张 Definition 转成 Patch，适合做 AI 修改预览、Undo/Redo 和变更记录。

`analyzeWorkflowDefinition(definition)` 只做静态提醒，例如条件分支没有 fallback、多个条件可能同时命中、requires 没有对应 produces。它不会执行业务逻辑。

节点可以声明轻量的工作成果依赖：

```markdown
requires: current-state, evidence
produces: target
```

它不是表达式语言，也不是变量运行时。

## Run Event / Human Wait

公共 contract 还定义了 `WorkflowPendingInteraction` 和 `WorkflowRunEvent`，用于表达 Workflow 暂停等待人工、节点完成/失败、Workflow 完成/停止等运行事件。公共库只定义数据边界，不负责 checkpoint、审批或持久化。

React Flow、ELK、节点坐标、viewport 等画布实现不属于这个 package。
## 为什么故意保持这么小

一个 Markdown Workflow 文件经常同时要被：

- 人阅读
- Git review
- Agent 阅读
- runtime 解析

因此公共层应该只解决结构问题。

业务项目自己决定：

```text
condition evaluator
business action
approval
authorization
persistence
retry / compensation
audit
external side effect
```

