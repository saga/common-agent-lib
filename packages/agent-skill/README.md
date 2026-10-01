# @saga/agent-skill

框架无关的 Agent Skill manifest 解析、Schema 校验和目录发现。

它只解决：

- `SKILL.md` frontmatter 的标准读取。
- `metadata.kind = capability | workflow`。
- Skill 目录发现。
- capability / workflow 边界校验。

它不负责 Agent SDK 加载、不负责 Tool 权限、不负责 Workflow 执行。

建议的 capability Skill：

~~~yaml
---
name: search-confluence
description: Search internal Confluence content.
metadata:
  kind: capability
---
~~~

Workflow Skill：

~~~yaml
---
name: legacy-modernization
description: Modernize an existing data estate.
metadata:
  kind: workflow
---
~~~

开放 Agent Skills 可以没有 `metadata.kind`；这类 Skill 可以被解析，
但在 `requireKind: true` 模式下会被拒绝，也不能进入 Workflow runtime。