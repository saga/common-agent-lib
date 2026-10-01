# AI Agent Common Patterns

本文档记录从以下四个项目代码中归纳出的公共模式：

- `saga/copilot-server-agent`
- `saga/ai-interview-questions`
- `saga/team-member-copilot-agent`
- `saga/agentic-data-architect`

它不是另一个 Agent Framework 设计文档，而是说明哪些重复模式应该进入公共库，哪些只应该形成 Schema、Interface、SKILL 或设计规范。

## 核心原则：不要把所有模式都做成 Runtime

公共化有五个层级：

```text
Schema / Contract
        ↓
Interface
        ↓
SKILL / Spec
        ↓
Pattern / Guidance
        ↓
Runtime / Implementation
```

越靠上越应该稳定、provider-neutral；越靠下越应该留给宿主应用或具体 Agent Runtime。

因此：

> 跨框架稳定的数据边界做 Schema；跨实现稳定的能力边界做 Interface；Agent 使用方法做 SKILL；实现细节留给 Runtime。

这也是 `@saga/agent-contracts` 的定位。

## Pattern 1：Copilot SDK Agent Service Runtime

### 重复出现的代码

典型调用链：

```text
HTTP / Application service
        ↓
Agent runtime
        ↓
CopilotClient.start()
        ↓
createSession() / resumeSession()
        ↓
session.sendAndWait()
        ↓
assistant.message_delta
assistant.message
session.idle
        ↓
business result
```

三个项目都有不同程度的：

- SDK client lifecycle
- session lifecycle
- turn lifecycle
- streaming
- cancellation
- timeout
- concurrency control
- shutdown

这就是 `@saga/copilot-agent-runtime` 的边界。

### 不能抽什么

不要把以下对象放进去：

- Team
- Member
- Conversation
- Business Execution
- Agent-specific tools
- Business persistence

Policy、Approval、Command、Audit 等可以有 provider-neutral contract，但不应进入这个 Runtime。

---

## Pattern 2：Structured Knowledge

公共层应该稳定的是数据和检索契约，而不是某一种数据库或 RAG 实现。

### 公共 Schema

```text
KnowledgeEntry
 ├─ id
 ├─ title
 ├─ kind
 ├─ summary
 ├─ content
 ├─ tags
 ├─ metadata
 ├─ status
 └─ sources

KnowledgeSource
 ├─ provenance
 ├─ publication / review time
 ├─ confidence
 └─ URI
```

### Retrieval Contract

`@saga/agent-contracts` 提供：

```text
KnowledgeSearchRequest
KnowledgeHit
KnowledgeSearchResult
KnowledgeProvider
```

之后业务项目可以替换：

- BM25
- embedding
- vector DB
- graph retrieval
- Snowflake
- PostgreSQL
- hybrid search

而不用改变 Agent 与检索层之间的契约。

抽取过程仍由 application extractor 决定：

```text
raw text
  ↓
application extractor
  ├─ Copilot
  ├─ OpenAI
  ├─ local model
  └─ deterministic parser
  ↓
Zod schema
  ↓
KnowledgeEntry
```

---

## Pattern 3：Markdown Workflow

两个项目已经出现两种实现：

### agentic-data-architect

偏轻：

```text
SKILL.md
  ↓
parse
  ↓
Journey Definition
  ↓
facts
  ↓
Journey State
```

### copilot-server-agent

偏重：

```text
SKILL.md
  ↓
remark / AST
  ↓
FlowAst
  ↓
validator
  ↓
analyzer
  ↓
runtime
```

公共库取二者的交集，不复制安全专用 DSL。

### 公共 AST

```text
Workflow
 ├─ id
 ├─ start
 └─ nodes[]

Node
 ├─ id
 ├─ type
 ├─ title
 ├─ objective
 ├─ visible
 ├─ completeWhen
 ├─ body
 └─ routes[]

Route
 ├─ outcome
 └─ target
```

### Runtime 边界

公共库可以回答：

- 当前节点是什么？
- 哪些节点已经完成？
- 哪些节点已解锁？
- 某个 outcome 应该去哪个节点？

公共库不能回答：

- business condition 是什么？
- 这个 gate 是否真的通过？
- SQL 是否正确？
- 谁可以审批？
- 谁可以执行命令？
- 外部系统是否真的成功？

这些问题由 application facts / evaluator / executor 决定。

---

## Pattern 4：Schema-first Structured Output

四个项目里凡是把 LLM 输出写进业务状态，都出现了同一个原则：先得到结构化结果，再做 Schema 验证，最后才允许进入业务状态。

```text
LLM / Provider
      ↓
structured response
      ↓
schema validation
      ↓
domain validation
      ↓
persisted business state
```

`agent-structured-output` 提供 provider-neutral 的最终 Schema 门。OpenAI / LangChain 等能直接返回 parsed object 时，不需要强制经过 JSON 字符串解析。

---

## Pattern 5：Provider-neutral Agent Contracts

四个项目中已经反复出现一些稳定的“名词和边界”。它们不值得各自实现一套 Runtime，但值得统一 Schema / Interface。

这些契约集中在 `@saga/agent-contracts`：

```text
AgentDefinition
SessionReference
ToolDefinition / ToolResult
ToolProvider
KnowledgeSearchRequest / KnowledgeSearchResult
KnowledgeProvider
ContextReference
AgentInterrupt / InterruptResult
ApprovalRequest / ApprovalDecision
PolicyRequest / PolicyDecision
AgentCommand / CommandResult
Evidence
AgentEvent
```

### 为什么不是更多 Runtime

例如：

```text
PolicyRequest
      ↓
PolicyDecision
```

可以由 OPA、Cedar、公司内部 Policy Service 或其它系统完成。

同样：

```text
AgentCommand
      ↓
CommandExecutor
```

只规定调用边界，不规定数据库、交易系统或外部 API 怎么执行。

### 一个统一的宿主关系

```text
                         Application
                              │
                    @saga/agent-contracts
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
       Copilot            LangChain          OpenAI Agents
       Runtime             Runtime               Runtime
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                     Enterprise Systems
```

Common Lib 不试图成为第四个 Agent Runtime。

---

## Pattern 6：Evaluation-first Agent

AI Agent 和普通函数最大的不同，是同一个任务可能有多条正确路径，而且工具调用、延迟、token、失败和中间轨迹本身都影响质量。因此 Eval 不应该只测最终字符串。

公共模型统一为：

```text
EvalCase
  ↓
Agent execution
  ↓
Observation
  ├─ output / error
  ├─ latency
  ├─ tool calls
  ├─ token usage
  └─ trace id
  ↓
Code Grader / Model Grader / Human Grader
  ↓
Case Result
```

`agent-eval` 不定义评分方法，也不把不同业务硬合成一个总分。

---

## Pattern 7：Context Engineering

这是值得复刻的设计模式，目前不做通用 Context Runtime。

四个项目已经反复出现：

- session history 与 application/business state 分开。
- 当前 turn 只注入增量或真正相关的上下文。
- 大结果落文件 / workspace，再用引用按需读取。
- 上下文有预算，需要截断、压缩或 just-in-time retrieval。
- 忽略的历史必须显式告诉 Agent，不能让“没看到”被误认为“没发生”。

但是现在已经可以定义 provider-neutral `ContextReference`，用于表达：

```text
message / file / document / knowledge / artifact / tool-result / workflow-state
```

它只表示“哪里有上下文”，不负责加载、压缩、截断或持久化。

---

## Pattern 8：Human-in-the-loop / Interrupt

通用语义是：

```text
agent run
   ↓
interrupt
   ↓
durable checkpoint
   ↓
human decision
   ↓
resume
```

现在不做通用 HITL Runtime，但可以定义：

```text
AgentInterrupt
InterruptResult
```

这样 LangGraph interrupt、OpenAI RunState interruption、Copilot waiting state、业务 approval 等都可以适配到同一数据边界。

Common Lib 不决定：

- 谁可以批准
- 谁可以恢复
- checkpoint 存在哪里
- authorization 如何判断

---

## Pattern 9：Approval / Policy / Command 的 Contract-first 设计

这些能力不应该进入 common runtime，但其跨应用的数据边界已经足够稳定。

### Approval

```text
ApprovalRequest
       ↓
Application Policy / Authorization
       ↓
ApprovalDecision
```

### Policy

```text
PolicyRequest
       ↓
Policy Provider
       ↓
PolicyDecision
```

### Command

```text
AgentCommand
       ↓
Approval / Policy
       ↓
CommandExecutor
       ↓
CommandResult
```

因此 Common Lib 定义 Schema / Interface，但不实现：

- authorization
- data entitlement
- policy engine
- approval service
- command executor

这尤其适合金融服务场景：Agent 可以提出 Command，但不能因为 LLM 自己判断“应该执行”就越过企业授权边界。

---

## Pattern 10：Evidence / Provenance

Evidence 是另一个值得公共化的数据边界。

```text
Agent answer
     │
     ├── output
     └── evidence[]
              │
              ├── document
              ├── database
              ├── API
              ├── tool
              ├── agent
              └── human
```

`Evidence` 只描述来源和 provenance，不负责判断证据是否足以支持业务结论。后者仍然是 application evaluator / domain logic。

---

## Pattern 11：Observability 与 Business Audit 分开

```text
Agent trace
  = 谁调用了什么、什么时候调用、运行多久、是否失败

Business audit
  = 谁批准、依据什么、访问了什么数据、执行了什么业务动作、最终采用什么决定
```

Common Lib 可以提供 provider-neutral `AgentEvent`，方便映射到 OpenTelemetry、LangSmith、OpenAI tracing 或应用事件流。

但 `AgentEvent` **不等于 Regulatory Audit Evidence**。

Business audit 仍然属于应用自己的审计模型。

---

## Pattern 12：Tool Contract，而不是 Tool Registry

行业实践的共同点不是“做一个巨大的 Tool Registry”，而是：

- 参数必须有明确 Schema。
- description 要告诉 Agent 什么时候用、什么时候不要用。
- 输入输出尽可能结构化。
- Tool 返回高信号结果，不把无关数据全塞回上下文。
- 需要时按服务 / 资源做命名空间。
- Tool 调用前后可以有 guardrail / validation。

因此 Common Lib 提供 `ToolDefinition` 和 `ToolProvider` contract，但不实现 Registry。

MCP、REST、内部 API、脚本和 runtime-native tools 都可以适配到这个 contract。

---

## Pattern 13：Progressive Disclosure / Capability Loading

Agent Skills 与现在的四个项目已经共同说明：不能把所有能力正文、所有工具和所有知识一次性塞进 context。

更稳定的模式是：

```text
metadata
  ↓
discover
  ↓
load only when relevant
  ↓
read supporting resources / run scripts
```

`agent-skill` 负责 Skill manifest/discovery；`agent-contracts` 负责必要的 capability / tool / context 数据边界；具体动态加载和执行仍属于 runtime。

---

## 哪些仍然不要抽

即使现在有 contract，也不要继续扩张成公共业务框架：

- Team / Member
- Conversation domain model
- Learner Model
- Graph RAG implementation
- MCP Registry
- Data Entitlement implementation
- Authorization implementation
- Policy Engine
- Approval Service
- Command Executor implementation
- Business State
- Regulatory Audit system
- Agent-specific workflow evaluator

原则是：

> **Schema 可以通用，不代表业务语义也应该通用；Interface 可以通用，不代表实现应该进入 common-agent-lib。**

---

## 与 LangChain / OpenAI / Anthropic 的对照

| 行业模式 | LangChain | OpenAI Agents | Anthropic | common-agent-lib |
| --- | --- | --- | --- | --- |
| Agent Runtime | LangGraph / Agents | Agents SDK | Agent SDK / Managed Agents | Copilot Runtime |
| Agent Definition | Agent / Graph config | Agent definition | Agent configuration | `agent-contracts` |
| Session | persistence / state | Sessions / RunState | Sessions | Runtime + `SessionReference` |
| Structured Output | ProviderStrategy / ToolStrategy | Zod / structured output | structured output / tool use | `agent-structured-output` |
| Skill | ecosystem / middleware | tool/agent composition | Agent Skills | `agent-skill` |
| Workflow | LangGraph | orchestration | Workflows | `markdown-workflow` |
| Knowledge | Retriever / Store | file/search/tool | Skills + retrieval | `agent-knowledge` + contracts |
| Context | middleware / context editing | RunContext / compaction | JIT context | `ContextReference` + guidance |
| HITL | interrupt + persistence | interruptions + RunState | confirmation / session | `AgentInterrupt` contract |
| Approval | app-specific | app-specific | permission / confirmation | `ApprovalRequest/Decision` contract |
| Policy | middleware / app | guardrails / app | hooks / permissions | `PolicyRequest/Decision` contract |
| Command | tool/application | tool/application | tool/application | `AgentCommand/Result` contract |
| Evidence | app / retrieval metadata | app / tracing | app / context | `Evidence` |
| Eval | LangSmith ecosystem | tracing/evals | code/model/human graders | `agent-eval` |
| Tool governance | middleware | guardrails | hooks / permissions | contract + application/runtime |
| Multi-agent | subgraphs / subagents | handoffs / agents-as-tools | subagents / Task | application/runtime |
| Tracing | LangSmith / OTel | built-in tracing | hooks / managed events | OTel/vendor + `AgentEvent` |

## 最终原则

**复刻概念，不复刻框架内部实现。**

进一步说：

> **跨框架稳定的数据边界做 Schema；跨实现稳定的能力边界做 Interface；Agent 使用方法做 SKILL；实现细节留给 Runtime。**

Common library 的目标不是成为另一个 LangChain，而是让 Copilot、LangChain、OpenAI、Anthropic 和业务 Agent Runtime 可以共享稳定的契约，同时保持各自的实现自由度。
