# @saga/agent-rules

一个小型、确定性的声明式规则引擎。

适合把业务代码中的“条件 → 建议/分类/状态”从主流程中移出来。

```text
facts → rules → matched outputs
```
适合：Finding 后的分类、Gap / Recommendation、Validation readiness、Journey 条件。

不负责 LLM 推理、权限、审批、数据库事务和外部副作用。宿主应用决定如何执行和持久化规则结果。