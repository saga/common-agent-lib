# @saga/markdown-workflow

一个很小的 Markdown Workflow parser / validator / state runtime。

这个 package 来自 `saga/copilot-server-agent` 和 `saga/agentic-data-architect` 的实际使用经验，但只保留已经证明有长期价值的部分：

```text
SKILL.md
   ↓
Markdown parser
   ↓
Workflow Definition
   ↓
structural validation
   ↓
host facts + evaluator
   ↓
Workflow state
   ↓
declared outcome → next node
```

它不是 Agent Framework，也不是 BPMN engine。

## DSL

当前只支持四种 block：

~~~markdown
## @flow data-review

start -> intake

## @task intake

title: 明确目标
objective: 先说清楚要解决什么问题。
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
~~~

### Node

节点只保留这些真正有运行意义的字段：

- `title`
- `objective`
- `actor`
- `completeWhen`

`@task` 默认由 Agent 执行，`@review` 默认等待人工；只有 `actor: human` 才会进入人工等待状态。

### Route

Route 只有：

~~~text
outcome -> target
~~~

`success`、`failed`、`retry`、`approved` 都只是 outcome 字符串。

特别是 `retry` 不需要特殊 node、group 或 DSL 关键字。它就是一条真实的 Workflow Edge。

公共 runtime 不解释 outcome 的业务含义，也不根据 outcome 自动执行任何副作用。

### completeWhen

`completeWhen` 只是一个条件名字，不是表达式语言。

宿主应用通过 `CompletionEvaluator` 决定这些名字如何映射到自己的 facts。

公共包不知道 `goal` 是什么，也不应该知道。

## State

执行状态只有一个来源：`WorkflowExecution`。

`WorkflowState` 在 execution 之上只提供 UI/展示用的 `stages`，不再复制 current/completed/unlocked。

有 `completeWhen` 的当前节点会在 evaluator 返回 true 时自动推进，并沿该节点的第一个 route 进入下一步。没有 `completeWhen` 的节点不会被公共包猜测完成。

## Parse / Validate

`parseAndValidateWorkflow()` 做的是结构检查，而不是业务检查。

检查包括：

- `@flow` 和 `start -> node`
- 重复 node / outcome
- route target 不存在
- 非 `@end` 节点没有出口
- `@end` 仍然定义出口
- 不可从 start 到达的节点
- 无法走到 `@end` 的节点
- 不支持的 node / attribute

## Transition

`WorkflowRuntime.transition()` 和 `applyTransition()` 只处理声明过的 route。

它不会调用 SQL、MCP、API，不做权限判断，不执行 approval/policy，也不代表 Agent 推理。

## Workflow 编辑

`WorkflowChange` 和 `diffWorkflowDefinitions()` 用于人工编辑、AI 修改预览、Undo/Redo 和变更记录。

Patch 只处理 Workflow Definition，不处理画布坐标。

## 为什么不继续加功能

最近在真实项目里验证后，下面这些能力被明确排除在公共 DSL 之外：

- `completion`：由 `completeWhen` 是否存在即可判断。
- `visible`：这是 UI 状态，不是 Workflow 语义。
- `tools`：工具由 Agent/runtime capability 决定，不应该在 Workflow 中声明一个假的工具权限模型。
- `requires / produces`：业务产物由宿主应用维护，不进入核心 Workflow。
- route `condition`：会把简单 outcome route 变成第二套规则系统。
- `@gate`：没有独立 runtime 语义时就是另一个名字的 task。
- `@stop`：停止运行属于 execution/control，不需要额外终点类型。
- `system` actor：没有稳定的公共执行语义。
- Workflow Registry：多个独立 Skill 已经足够。

## 与宿主应用的边界

宿主应用负责 facts/evaluator、business state、Tool/MCP、authorization、approval、persistence、audit 和外部副作用。

公共 package 负责 Markdown、AST、结构校验、state projection、声明式 route transition 和语义 edit/diff。

画布布局、X6、React Flow、ELK 等不属于这个 package。
