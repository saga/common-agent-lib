# @saga/agent-memory

公共库里原来没有独立的 Agent Memory。这个包定义跨项目稳定的记忆边界，不绑定 SQLite、向量库或具体 Agent SDK。

核心分三层：

```text
Durable Record
    ↓
Active Working Memory
    ↓
Archive Summary
```

分页和归档是两件事：分页解决“怎么继续读取历史”，归档解决“旧记录怎么从活跃窗口退出”。归档不删除原始记录。

宿主应用负责具体存储和摘要生成。本包提供 MemoryRecord、MemoryArchive、MemoryStore、cursor pagination、工作记忆窗口和 archive candidate 选择。