# common-agent-lib

几个独立复用的 AI Agent 公共库。目标不是再造一个 Agent Framework，而是把几个项目里反复出现、边界清楚的基础模式抽出来。

当前有三个 package：

| Package | 解决什么问题 | 运行时依赖 | 不能负责什么 |
| --- | --- | --- | --- |
| `@saga/copilot-agent-runtime` | 服务端使用 GitHub Copilot SDK，统一处理 client、session、turn、streaming、timeout、abort | `@github/copilot-sdk` | Team / Member / Business State / Approval / Policy / Skill |
| `@saga/agent-knowledge` | Knowledge 的表示、来源、Schema、抽取契约、Catalog、确定性检索和安全渲染 | `zod` | LLM、Vector DB、Graph RAG、Learner Model、业务权限 |
| `@saga/markdown-workflow` | 用 Markdown 表示 Workflow，解析 AST、校验结构、根据 facts 计算状态、执行 route transition | 无 | 业务 action、审批策略、权限、持久化 |

三个 package **互不依赖**。任何项目都可以只使用其中一个。

## 这几个项目里真正重复的模式

### 1. Server-side Agent Runtime

`saga/copilot-server-agent`、`saga/team-member-copilot-agent`、`saga/agentic-data-architect` 都出现了相同的边界：

```text
Application Service
      ↓
Copilot runtime adapter
      ↓
CopilotClient
      ↓
CopilotSession
      ↓
turn
      ↓
delta / message / event
```

最容易重复、又最适合公共化的是：

- CopilotClient 生命周期
- create / resume / delete session
- 同一个业务 lockKey 同时只允许一个 turn
- assistant delta / message / event 监听
- timeout 后显式 abort
- abort / timeout 后等待 `session.idle`
- active turn 记录
- stop / error 状态

业务代码仍然负责谁在运行、为什么运行、结果保存在哪里。

### 2. Knowledge

四个项目里的 Knowledge 形态不同，但共同骨架很稳定：

```text
Raw document / source
        ↓
Extractor
        ↓
Schema validation
        ↓
KnowledgeEntry
        ↓
Catalog / Index
        ↓
retrieve(query)
        ↓
KnowledgeHit / KnowledgeEvidence
        ↓
prompt / UI / next action
```

其中：

- `ai-interview-questions`：KnowledgeNode、KnowledgeDocument、metadata、lexical retrieval、graph expansion、答案安全投影。
- `agentic-data-architect`：source type、source confidence、knowledge confidence、time sensitivity、reviewedAt 和可复用架构知识 catalog。
- `team-member-copilot-agent`：filesystem knowledge、Team / Member scope、document limits 和 citation。
- `common-agent-lib`：只保留跨项目都成立的结构，不把金融、面试、Team、Learner 等字段硬塞进公共 Schema。

一个很重要的边界：

> Knowledge 是“可复用知识”；当前任务查到的事实仍然应该由具体应用自己的 Evidence / business state 管理。

### 3. Markdown Workflow

`saga/copilot-server-agent` 和 `saga/agentic-data-architect` 都证明了一件事：

```text
SKILL.md
   ↓
parse Markdown
   ↓
Workflow AST
   ↓
validate
   ↓
application facts
   ↓
Journey / current state
   ↓
next node / UI / API
```

公共库因此只负责通用结构：

- `@flow`
- `@task`
- `@gate`
- `@review`
- `@end`
- `@stop`
- route
- title / objective / visible / completeWhen
- AST
- structural validation
- facts → current Journey state
- current node + outcome → next node

**不**把 `Policy`、`Approval`、`Command`、MCP 权限、业务 Action 执行规则放进公共 Workflow package。那部分是 `copilot-server-agent` 的业务/安全运行时，不适合变成公共依赖。

## 为什么不做一个“大一统 Agent Framework”

这几个模式的生命周期完全不同：

```text
Copilot Runtime
  依赖具体 Agent SDK

Knowledge
  依赖 schema / data model

Markdown Workflow
  只依赖 Markdown + deterministic facts
```

把它们绑在一起，会导致：

- 任何项目安装一个 package 就带上不需要的依赖
- Knowledge 修改影响 Agent Runtime
- Workflow 修改影响 Copilot 生命周期
- 以后切换 Agent SDK / Knowledge backend 时难以拆开

所以这里刻意保持：

```text
copilot-agent-runtime   ← independent
agent-knowledge         ← independent
markdown-workflow       ← independent
```

## 与四个项目的对应

| 项目 | Runtime | Knowledge | Workflow |
| --- | --- | --- | --- |
| `copilot-server-agent` | Copilot SDK server runtime 最完整 | Skill / execution context | 最完整的 parser / validator / analyzer；安全属性不全部抽取 |
| `ai-interview-questions` | 自己的 AI provider / conversation abstraction | 最丰富：structured knowledge + projection + retrieval + graph | Skills 有工作方法，但不是本公共 Workflow runtime 的主要来源 |
| `team-member-copilot-agent` | Member runtime → Copilot session | filesystem / scoped knowledge / citation | Skill 作为 Copilot SDK 输入 |
| `agentic-data-architect` | Copilot session | source / confidence / timeSensitivity + deterministic catalog | Markdown Workflow + Journey state + lint |

## 使用原则

### Copilot Runtime

业务项目负责：

```text
Member / Agent
Conversation
Business Execution
Authorization
Persistence
Audit
```

公共 Runtime 只负责：

```text
SDK lifecycle
Session
Turn
Streaming
Timeout
Abort
Concurrency lock
```

### Knowledge

业务项目负责：

```text
业务字段
业务 scope
权限
Evidence
Learner state
Graph semantics
Vector / Search backend
```

公共 Knowledge 负责：

```text
schema
provenance
extraction contract
catalog
deterministic baseline retrieval
safe rendering
```

### Workflow

业务项目负责：

```text
condition evaluator
business action
persistence
approval
authorization
external side effect
```

公共 Workflow 负责：

```text
Markdown → AST
AST validation
state projection
route transition
```

## 推荐迁移顺序

不要一次性重构四个项目。

1. 新项目优先直接使用三个 package。
2. 在实际项目中验证 API。
3. 再把已有重复实现逐个替换掉。
4. 最后删除项目自己的重复 runtime / parser / knowledge helper。

当前最自然的迁移顺序：

```text
1. Copilot SDK turn runtime
2. Knowledge schema / catalog
3. Markdown Workflow parser / validator / state runtime
```

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
```
