# @saga/agent-state-machine

一个极小的确定性状态机。

它只处理：状态、事件、允许的转移和 terminal state。

它不处理业务条件、权限、审批、SQL、工具调用或外部副作用。

`@saga/markdown-workflow` 仍负责 Markdown → Workflow State；这个包只提供更底层的通用状态转移能力。

## 与 Markdown Workflow 的关系

`@saga/markdown-workflow` 负责“人能读的高层路线”：从 Markdown 得到节点、outcome 和 Workflow state。

`@saga/agent-state-machine` 只是更底层的通用状态转移原语。它不应该被用来重新实现一套 Workflow DSL，也不负责 facts、completeWhen、Skill、Tool 或 Agent 决策。

推荐边界：

~~~text
Workflow Markdown
      ↓
@saga/markdown-workflow
      ↓
高层 Workflow state
      ↓
宿主应用决定何时/为什么 transition
      ↓
@saga/agent-state-machine（只有确实需要通用状态机时才使用）
~~~

在当前 Data Architect 场景中，Markdown Workflow 已经足够，不需要再额外套一层状态机。
