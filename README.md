# common-agent-lib

几个独立复用的 AI Agent 公共库。目标不是再造一个 Agent Framework，而是把几个项目里反复出现、边界清楚的基础模式抽出来。

当前 package：

| Package | 解决什么问题 | 依赖 |
| --- | --- | --- |
| `@saga/copilot-agent-runtime` | Copilot SDK server-side client / session / turn / streaming / reasoning / timeout / abort / concurrency | `@github/copilot-sdk` |
| `@saga/agent-knowledge` | Knowledge schema、provenance、抽取契约、catalog、deterministic retrieval、safe rendering | `zod` |
| `@saga/markdown-workflow` | Markdown → AST → validate → facts → Journey state / route | 无 |
| `@saga/agent-skill` | SKILL.md manifest、`metadata.kind`、Skill discovery 和 capability/workflow 边界 | `yaml` + `zod` |
| `@saga/agent-structured-output` | Provider-neutral 的结构化输出解析和最终 Schema 校验 | `zod` |
| `@saga/agent-eval` | Eval case、observation、code/model/human grader 和结果汇总 | 无 |
| `@saga/agent-memory` | 持久记忆契约、分页、工作记忆窗口和归档候选 | `zod` |
| `@saga/agent-rules` | 小型声明式确定性规则评估器 | `zod` |
| `@saga/agent-state-machine` | 小型确定性状态转移运行时 | 无 |

这些 package **互不依赖**。应用按需安装；不存在一个必须同时安装的“大一统 Agent Framework”。

## 为什么新增三个 package

四个项目的横向检查显示，除了 Runtime / Knowledge / Workflow，还反复出现：

```text
LLM / Tool / Agent
      ↓
structured output schema
      ↓
runtime validation
      ↓
business state

real task set
      ↓
agent execution
      ↓
observation / trace / outcome
      ↓
code + model + human graders

SKILL.md
      ↓
metadata / discovery
      ↓
capability or workflow
```

这三个边界都足够稳定，而且不需要知道具体 Agent SDK。

## 明确不再继续抽的模式

- Context engineering：抽取原则和小工具即可，暂时不做通用 Context Runtime。各应用的 context source、checkpoint scheduling、budget 和 compaction 策略不同；公共层只提供 ContextReference / AgentCheckpoint 等稳定 contract。
- Human-in-the-loop / interrupt：模式很通用，但 checkpoint、审批对象、授权和持久化都与业务强相关，暂不做通用执行引擎。
- Tracing / Audit：统一事件字段可以以后接 OpenTelemetry；不自己再造 tracing backend，也不把 runtime trace 当业务审计。
- Tool registry / dynamic tool search：工具发现方式正在快速变化，先保留 Tool contract / naming / schema 规范，不做新的通用 registry。
- Multi-agent handoff / agents-as-tools：这是编排模式，不是公共业务对象；保留在具体 runtime / application 层。
- Workflow orchestration engine：不要因为出现多个 Workflow 就建立 Registry、通用编排器或 BPMN engine。当前只需要 Skill 内的高层路线 + 一个小型 parser/runtime。
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

`saga/copilot-server-agent` 和 `saga/agentic-data-architect` 的实际使用说明了一件事：

```text
SKILL.md
   ↓
parse Markdown
   ↓
Workflow Definition
   ↓
structural validation
   ↓
application facts + evaluator
   ↓
Workflow state
   ↓
declared outcome → next node
```

公共库现在只负责已经验证过的最小结构：

- `@flow`
- `@task`
- `@review`
- `@end`
- `outcome -> target`
- title / objective / actor / completeWhen
- AST / structural validation
- facts → current Workflow state
- current node + outcome → next node
- 语义 edit / diff

这里有几个明确的经验：

1. Workflow 固定的是高层工作阶段，不固定 Agent 在阶段内部的具体调查动作。
2. `completeWhen` 只是条件名称；业务含义由宿主 evaluator 提供。
3. `success`、`failed`、`retry`、`approved` 都是普通 outcome。retry 就是一条真实 Edge。
4. 人工等待只需要 `actor: human`；不需要再造 approval node 或 stop node。
5. execution 才是运行状态唯一来源，UI stage 只是 projection。
6. Workflow parser 不负责 Tool、MCP、权限、审批、SQL、外部副作用。

**不**把 `Policy`、`Approval`、`Command`、MCP 权限、业务 Action 执行规则放进公共 Workflow package。

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

## 最近验证出的 Workflow 原则

```text
固定的是：
  工作阶段 / 人工确认 / 合法 outcome

不固定的是：
  Agent 在阶段内部怎么调查
  用什么 Tool / Skill
  何时回头
  业务事实如何判断
```

因此公共库的目标不是“描述所有 Agent 行为”，而是提供一个足够稳定的导航骨架。复杂性应留在宿主应用中，而不是继续向 Markdown DSL 堆字段。

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
