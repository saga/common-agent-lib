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

