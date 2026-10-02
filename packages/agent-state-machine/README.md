# @saga/agent-state-machine

一个极小的确定性状态机。

它只处理：状态、事件、允许的转移和 terminal state。

它不处理业务条件、权限、审批、SQL、工具调用或外部副作用。

`@saga/markdown-workflow` 仍负责 Markdown → Workflow State；这个包只提供更底层的通用状态转移能力。