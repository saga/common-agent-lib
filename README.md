# common-agent-lib

几个独立复用的 AI Agent 公共库。目标不是再造一个 Agent Framework，而是把几个项目里反复出现、边界清楚的基础模式抽出来。

当前 package：

| Package | 解决什么问题 | 依赖 |
| --- | --- | --- |
| `@saga/copilot-agent-runtime` | Copilot SDK client / session / turn / streaming / reasoning / timeout / abort / concurrency / usage delta / session recovery / permission 与 MCP auth 回调契约 | `@github/copilot-sdk` |
| `@saga/codebuddy-agent-runtime` | CodeBuddy/WorkBuddy SDK query、无工具安全默认值、结构化 JSON、timeout/abort、session ID 与 token 用量规范化 | `@tencent-ai/agent-sdk` |
| `@saga/agent-tracing` | Agent 轨迹记录、trace/span 关联、Token Usage 聚合、敏感信息脱敏、事件载荷限制、SQLite 持久化与查询 | `@saga/agent-contracts` + `node:sqlite` |
| **@saga/document-core** | 文档统一契约、预算分批、逻辑分页、翻译结果校验 | 无 |
| `@saga/agent-context` | 确定性 Context 组装、预算控制、来源保留、重复项和省略原因 | 无 |
| `@saga/agent-knowledge` | Knowledge schema、provenance、抽取契约、catalog、deterministic retrieval、safe rendering | `zod` |
| `@saga/markdown-workflow` | Markdown → AST → validate → facts → Journey state / route | 无 |
| `@saga/agent-skill` | SKILL.md manifest、`metadata.kind`、Skill discovery 和 capability/workflow 边界 | `yaml` + `zod` |
| `@saga/agent-structured-output` | Provider-neutral 的结构化输出解析和最终 Schema 校验 | `zod` |
| `@saga/agent-eval` | Eval case、observation、code/model/human grader 和结果汇总 | 无 |
| `@saga/agent-memory` | 持久记忆契约、分页、工作记忆窗口和归档候选 | `zod` |
| `@saga/agent-rules` | 小型声明式确定性规则评估器 | `zod` |
| `@saga/agent-state-machine` | 小型确定性状态转移运行时 | 无 |

这些 package 可独立安装、按需使用；只有确实需要公共契约的模块才声明单向依赖，例如 agent-tracing 依赖 agent-contracts。不存在一个必须同时安装的“大一统 Agent Framework”。

## 为什么新增这些 package

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

- Context assembly：先保持来源检索、权限边界和领域事实在宿主；轻量确定性组装器的设计见 [Context Assembly proposal](docs/context-assembly-design.md)。当前不实现 CLM 式自主改写 Context 的运行时，也不把 memory、retrieval 和 prompt orchestration 合成一个大框架。
- Human-in-the-loop / interrupt：模式很通用，但 checkpoint、审批对象、授权和持久化都与业务强相关，暂不做通用执行引擎。
- Tracing / Audit：使用 @saga/agent-tracing 统一事件记录、脱敏、载荷限额和本地持久化；不自己再造托管 tracing backend，也不把 runtime trace 当业务审计。
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

Session 的 `onPermissionRequest` / `onMcpAuthRequest` 是宿主应用的策略接缝：在 `createSession` 和 `resumeSession` 中都要传递所需回调。SDK 未收到权限回调时可能把请求留在 pending 状态；公共包只提供 `CopilotSessionPolicy` 类型，不替宿主批准工具或实现 OAuth。托管策略、审批 UI 和无可用审批人时的 fail-closed 行为见 [Copilot Runtime session callback 约定](packages/copilot-agent-runtime/README.md#session-permission--mcp-auth-callbacks)。

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


## 新增的跨项目实践（2026-10）

- **轨迹与 Token Usage 进入公共契约**：AgentTraceContext / AgentEvent 统一 correlationId、traceId、turnId、parentEventId、sequence、provider/model、输入/输出/缓存/推理 Token、Provider 报告的费用指标和上下文窗口占用。@saga/agent-tracing 提供跨模型的 Usage 聚合及 SQLite 持久化；不把上下文占用当作消费量，也不混加不同单位的费用。Schema 只规定事件形状，不提供托管 tracing 或监管审计系统。
- **Ant Design X UI**：放在 [可复用 Skill](skills/ant-design-x-agent-ui/SKILL.md)，而不是做成 npm UI framework。它指导如何组合 antd 控件、X 聊天组件、流式消息和应用自身的业务状态。
- **WorkBuddy / 本机 Agent**：操作流程沉淀在 [coding-agent Skill](skills/workbuddy-agent-workflow/SKILL.md)；本机/远程 Provider 的边界沉淀在 [local-agent integration Skill](skills/local-agent-provider-integration/SKILL.md)。
- **仓库分析与证据**：见 [2026-10 模式归纳](docs/patterns-from-saga-repos-2026-10.md)。

公共包只包含跨项目稳定的 contract/runtime。组件选型、工具安装路径、WorkBuddy 记忆目录、UI 交互与具体 app 生命周期都是 Skill 或应用层文档，不做不必要的抽象。


## CodeBuddy / WorkBuddy SDK 复用

与 Copilot 一样，CodeBuddy SDK 的调用约定也适合代码复用，因此新增 `@saga/codebuddy-agent-runtime`，不只提供 Skill 文档。它把 `@tencent-ai/agent-sdk` 的 `query()` 接线、prompt 组合、禁止隐式加载宿主配置、默认禁用普通工具、StructuredOutput、timeout/abort 与 per-turn usage 统一起来。

- Copilot SDK：使用 `@saga/copilot-agent-runtime`。
- CodeBuddy/WorkBuddy SDK：使用 `@saga/codebuddy-agent-runtime`。
- WorkBuddy 桌面工具、工作记忆目录、仓库协作步骤：使用 `skills/workbuddy-agent-workflow/SKILL.md`。

当前 CodeBuddy SDK 官方仍标记为 Preview，所以 package 封装了可验证的 `query()` 使用路径，但没有把 unstable v2 Session API 包装成稳定承诺。高并发 Session Pool、EPUB/PDF 文档 Run、SQLite 持久化和翻译专用 task profile 先留在 local-agent-service，等多个项目证明契约稳定后再抽取。


## Agent tracing

@saga/agent-tracing 提供跨 Agent SDK 的 trace recorder、span helper、Token Usage 规范化/聚合、内存 store 和 SQLite store。Token 统计直接采用 SDK / Provider 指标，不根据文本长度估算；上下文占用单独记录，费用只在计量单位一致时聚合。不同项目统一事件形状和查询方式，同时保留对 PostgreSQL、LangSmith、OpenTelemetry 或其它后端的适配空间。

```ts
import { AgentTraceRecorder, SqliteTraceStore } from '@saga/agent-tracing';

const tracing = new AgentTraceRecorder(
  new SqliteTraceStore({ filename: './data/agent-traces.sqlite' }),
);
const context = tracing.createContext({ sessionId: 'conversation-1' });
await tracing.runSpan({ ...context, category: 'tool', name: 'knowledge.search' }, async () => {
  return searchKnowledge('portfolio');
});
const events = await tracing.query({ traceId: context.traceId });
await tracing.close();
```

完整 API、存储接口和隐私边界见 packages/agent-tracing/README.md。该包记录运行轨迹，不代替业务执行审计、授权证据或托管可观测性平台。


## Document core

**@saga/document-core** 提供浏览器端和服务端可共用的文档片段契约、预算分批、阅读分页以及模型译文结果校验。不包含 EPUB/PDF/DOCX 解析器、模型调用、缓存、数据库或长文档翻译工作流。

API 和边界见 [packages/document-core/README.md](packages/document-core/README.md)。

## Context assembly

vocal-saga 的 Context Graph、文学记忆、上下文选择和 prompt 组装验证了单独 Context Assembly 层的可行性，但其中大量规则属于小说翻译领域。先保留宿主检索和证据/章节边界，把确定性排序、预算和来源清单作为后续候选包；设计与迁移顺序见 [docs/context-assembly-design.md](docs/context-assembly-design.md)。


## Context assembly

@saga/agent-context provides a deterministic composition layer between host-side retrieval and provider-specific prompt/runtime code. It enforces a caller-supplied budget, keeps required context with explicit over-budget reporting, and returns the provenance and omission ledger.

The host application still owns retrieval, authorization, evidence validation, trust status, and temporal boundaries. It is intentionally not an autonomous memory manager or a CLM implementation. See [packages/agent-context/README.md](packages/agent-context/README.md) and [Context Assembly design](docs/context-assembly-design.md).
