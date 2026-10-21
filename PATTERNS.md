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


---

## Pattern 14：Durable Agent Memory

当前项目里已经出现一个必须区分的概念：

```text
Transcript / Work Records
        ↓
Working Memory
        ↓
Archive
```

三者不是一回事：

- Transcript 是完整原始记录，应该可分页、可检索、可审计。
- Working Memory 是当前 turn 给模型看的有界窗口。
- Archive 是旧记录的摘要和引用，不能替代原始记录。

Common Lib 现在用 `@saga/agent-memory` 定义 MemoryRecord、MemoryArchive、分页契约和窗口/归档候选选择。存储和摘要生成继续由 application 决定。

## Pattern 15：Declarative Rule Engine

很多“if/else → 建议/分类/状态”的逻辑已经开始在应用里重复。最适合抽成规则的是：

```text
facts
  ↓
rules
  ↓
matched outputs
```

`@saga/agent-rules` 提供最小的声明式条件、优先级、启停和模板能力。它不执行副作用，也不决定权限。

典型宿主规则：

```text
Finding → Recommendation
Current-State → Gap
Validation facts → Ready / Blocked
Journey facts → Complete / Current
```

## Pattern 16：Generic State Machine

Workflow runtime 与 Agent turn lifecycle 都包含稳定的状态转移模式。现在用 `@saga/agent-state-machine` 提供最小的 state / event / transition 能力。

它不替宿主保存业务状态，也不执行状态进入时的副作用。

不要把它再升级成第二个 Workflow Engine；`@saga/markdown-workflow` 仍然负责 Markdown → Workflow Definition → Journey State。

## Pattern 17：Long-running Agent 需要把“运行进度”和“工作成果”分开

agentic-data-architect 的实际长任务运行暴露出一个常见问题：工具和模型可以持续工作很久，但用户仍然感觉“没有结果”。

需要区分三层：

runtime status
  = 还在运行吗？

progress event
  = 当前在做什么？

checkpoint
  = 到这里已经得到什么？

长任务不应该靠固定时间输出“还在处理中”解决。更合适的是在形成有实质成果的阶段后产生一个紧凑 checkpoint，然后继续 Agent。

AgentCheckpoint 只保留：阶段标题、阶段小结、已确认事实、Evidence 引用、未确认事项、下一步。

公共库只提供 Schema。checkpoint 什么时候生成、保存在哪里、如何展示、如何和业务 Evidence 关联，仍由应用决定。

不要每个 tool call 都生成 checkpoint，也不要为了“有进度”生成没有新信息的报告，更不要把 checkpoint 变成第二套 Workflow / Task system。

## Pattern 18：执行超时和等待人工输入不是同一个时间预算

agentic-data-architect 的实际运行还验证了一条重要边界：

Agent execution
        ↓
有限执行时间

ask_user / human input
        ↓
独立等待时间

用户思考的时间不是 Agent 计算的时间。因此宿主至少应该区分 execution timeout、user-input wait、permission wait。

公共库目前不实现通用 HITL runtime。具体 timeout timer、pending interaction、resume 和 persistence 仍由宿主负责。
## Pattern 19：Agent 不能自己给 Claim 授予更高可信度

agentic-data-architect 的结构化结果处理暴露出一个容易被忽略的边界：LLM 输出的 status 只是“模型声称的状态”，不能直接进入业务状态。

更稳妥的链路是：

~~~text
LLM claim
  ↓
Schema validation
  ↓
evidence reference 校验
  ↓
status calibration
  ↓
application state
~~~

公共 `@saga/agent-contracts` 现在提供 `Claim`、`ClaimStatus` 和 `calibrateClaimStatus`。其中：

- 没有 Evidence → `unknown`
- Agent 声称 `verified` → 至少先降为 `inferred`
- `supported` 需要至少两个不同证据来源；同一个 source / URI / sourceHash 的两条记录不算独立支持
- `contradicted` 不因为 Evidence 数量变化而被覆盖

公共库只负责这条安全边界，不负责判断业务领域里“什么证据才足够”。`verified` 仍必须由 deterministic / application-owned 校验产生。

## Pattern 20：Copilot Runtime 应返回“本轮增量 Usage”，而不是让每个应用自己读 session metrics

`agentic-data-architect` 为显示每一轮 token / AI credit，不得不读取 session 累计 `usage.getMetrics()`，再做 before/after 差值，并按 model 聚合。这部分没有业务语义，完全属于 Copilot Runtime。

因此 `@saga/copilot-agent-runtime` 现在提供：

~~~text
getCopilotSessionUsageMetrics()
diffCopilotUsageMetrics()
CopilotTurnResult.usage
~~~

这样应用只关心：

~~~text
本轮用了多少 input/output token
本轮 Premium Request Cost / AIU 变化
各模型分别用了多少
~~~

Session 累计 usage 仍由 Copilot SDK 自己定义；Common Runtime 不把 AI credit 转成货币，也不建立跨 provider 的 cost model。

## Pattern 21：Resumable Session 不存在时，Runtime 可以做“恢复或新建”的技术兜底

Copilot Session ID 可以长期保存在业务状态，但 SDK session 可能因为过期、删除或本地运行目录变化而不存在。`agentic-data-architect` 已有明确的 `resume → 确认 session 不存在 → create` 策略。

这个判断不涉及业务语义，因此属于 `@saga/copilot-agent-runtime`：

~~~text
stored session id
      ↓
resumeSession
      ├─ exists → reuse
      └─ missing → createSession
~~~

但是“新建的 SDK session 是否可以继续沿用原业务 Conversation / Investigation / Member 状态”仍然由宿主决定，不能由 Runtime 自动假定。
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
| Tracing | LangSmith / OTel | built-in tracing | hooks / managed events | @saga/agent-tracing + OTel/vendor |

## 最终原则

**复刻概念，不复刻框架内部实现。**

进一步说：

> **跨框架稳定的数据边界做 Schema；跨实现稳定的能力边界做 Interface；Agent 使用方法做 SKILL；实现细节留给 Runtime。**

Common library 的目标不是成为另一个 LangChain，而是让 Copilot、LangChain、OpenAI、Anthropic 和业务 Agent Runtime 可以共享稳定的契约，同时保持各自的实现自由度。


---

## Pattern 22：Trace envelope 要能把一次请求串起来，但不承载审计真相

近期的 architecture-diagram-studio trace ledger 和 copilot-server-agent execution events 重复出现一组字段：correlationId、traceId、turnId、parentEventId、sequence、category、status、durationMs、provider、model。

公共化结果：@saga/agent-contracts 提供 AgentTraceContext / AgentEvent 契约；@saga/agent-tracing 进一步提供事件生成、trace-local sequence、脱敏、payload 限额、span helper、可替换 store 接口与 SQLite 存储。业务审计、授权证据、访问控制和 retention policy 仍由应用负责。

实践要点：

- traceId 关联一个逻辑请求；turnId 区分请求内的 Agent/模型轮次；parentEventId 可把 tool/child event 组织成树；sequence 由事件写入端生成，不能让模型决定。
- 事件记录 turn.started、model.requested、tool.started、tool.completed、tool.failed、policy.decided、state.changed、turn.completed 等可验证的运行事实。事件名是应用约定，不由公共包锁死。
- 日志体先递归脱敏，再做大小限制；大正文、附件、长增量不应无上限塞进事件表。保留引用、哈希、长度和有限预览，按需到授权存储读取。
- reasoning delta 是某些 Runtime 提供的观测事件，不代表可显示给用户的解释；不要把隐藏推理、完整 prompt 或整段 token delta 默认存入长期日志。
- LangSmith / OpenTelemetry 是运行时观测；需要回答“谁批准、依据什么、后来执行了什么”的业务审计，应由应用自己的持久化事件和证据对象负责。

来源：[architecture-diagram-studio trace ledger](https://github.com/saga/architecture-diagram-studio/blob/main/v1/server/trace-ledger.ts)、[copilot-server-agent execution events](https://github.com/saga/copilot-server-agent/blob/main/server/src/execution/events.ts)。

## Pattern 23：Ant Design X 适合 Agent 对话面，不替代业务画布和领域状态

ai-interview-questions 与 architecture-diagram-studio/v2 都采用 antd + @ant-design/x。可以共享的是组合方式与交互规则，不是具体业务组件。

- antd 负责表单、布局、弹窗、配置上下文与主题；@ant-design/x 负责 Bubble / Sender / Prompts 等 Agent 对话交互。
- 保持 ConfigProvider、本地化、XProvider 和 antd App 上下文一致。以项目 lockfile 实际锁定版本为准，不能只因为示例版本相同就忽略升级差异。
- 聊天 transcript、任务/Execution 状态和领域对象分开建模。消息的 stream 状态只是消息状态；它不能代表工作流成功或外部副作用已成功。
- 对结构化动作，模型只能通过领域工具提交提议；服务端验证 Schema 和业务不变量后更新领域模型。不要允许模型直接操纵 React Flow / 画布内部状态。
- 显式覆盖无 tool call 的正常回复、空文本、错误 stop reason、断流、重试和部分流式内容；不能把“模型这轮没调用工具”直接解释为整个请求失败。

来源：[ai-interview-questions CopilotSidebar](https://github.com/saga/ai-interview-questions/blob/main/src/components/copilot/CopilotSidebar.tsx)、[architecture-diagram-studio/v2 UI](https://github.com/saga/architecture-diagram-studio/blob/main/v2/src/App.tsx)。

## Pattern 24：WorkBuddy Skill 是可执行方法，不是项目架构说明的替代品

在 ai-interview-questions、copilot-server-agent 和 fanyi-extension 中，Skill、AGENTS.md、架构文档和工作记忆承担不同职责：

- AGENTS.md：短小、稳定的仓库原则与禁止事项。
- README / docs：架构、数据流、运行命令、故障语义和决定记录。
- SKILL.md：可重复的工作程序、检查顺序、操作方法和完成标准。
- 工作记忆：跨轮次的临时连续性。写入前先核对当前仓库真正维护的目录；不能假定 .workbuddy/ 和 .workbuddy-ai/ 始终同步，也不应默认把本机日志或临时产物提交进 Git。

每个 Skill 引用的脚本、命令和文件必须先验证真实存在；安装前检查用户级与项目级 Skill 是否重复或已分叉。把“我检查了代码”与“运行过测试”分开表述。

来源：[ai-interview-questions AGENTS.md](https://github.com/saga/ai-interview-questions/blob/main/AGENTS.md)、[fanyi-extension local provider docs](https://github.com/saga/fanyi-extension/blob/main/ARCHITECTURE.md)。

## Pattern 25：本机 Provider 要有显式选择与失败语义

fanyi-extension 把浏览器扩展、远程服务、本机 WorkBuddy/OpenCode 服务分开。可复用的重点不是某个本机产品的 SDK，而是 Provider 边界：

- 本机 Provider 的地址、provider、model、token 和文档翻译配置独立保存，避免一个设置意外改动其它流程。
- 选择本机 Provider 后，模型调用失败就返回明确错误或保留已存在结果；不应静默退回远程模型，否则可能改变数据边界、费用或隐私语义。
- 先用 health/model endpoint 检测服务可用；不可用时在 UI 明确禁用或说明原因，而不是等长任务失败。
- 浏览器端负责界面、消息路由和轻量确定性调度；大型文件解析、数据库缓存、耗时文档分析应放在本机服务中。
- 若做本机 HTTP API，使用 loopback 绑定、可选但明确的 token 门禁、请求大小/路径校验和超时；不要把“localhost”本身当成完整授权。

来源：[fanyi-extension README](https://github.com/saga/fanyi-extension/blob/main/README.md)、[fanyi-extension architecture](https://github.com/saga/fanyi-extension/blob/main/ARCHITECTURE.md)。

## Pattern 26：Agent 对领域模型提出修改，应用验证后提交

architecture-diagram-studio 的 Copilot 工具围绕 Diagram Document 做增删改，再由应用校验并渲染；Agent 不直接编辑画布内部运行态。相同原则适用于 SQL、翻译实体、知识条目和工作流：

1. 向 Agent 提供明确、窄小、可验证的领域工具。
2. 把 LLM 输出解析成结构化提议；失败时不更新权威状态。
3. 校验引用、版本、实体 ID、边关系和业务约束。
4. 应用提交后再返回权威状态；UI 只显示该状态的投影。
5. 对“没产生改变”“产生部分改变”“验证失败”“工具未调用”分别定义结果语义。

它比添加更多 prompt 规则更可靠：安全和一致性来自应用边界，而不是模型自我约束。

来源：[architecture-diagram-studio Copilot Runtime](https://github.com/saga/architecture-diagram-studio/blob/main/v2/server/copilot/runtime.ts)、[copilot-server-agent tool policy](https://github.com/saga/copilot-server-agent/blob/main/server/src/tool-policy.ts)。


---

## Pattern 27：CodeBuddy SDK 的调用边界值得做成 npm package，WorkBuddy 的宿主操作流程仍用 Skill

`devweekly/vocal-saga/local-agent-service` 中 `workbuddy.ts` 已经积累了一组不依赖小说翻译领域的 SDK 适配逻辑：显式 prompt 组合、隔离宿主 setting sources、普通文本任务禁用工具、StructuredOutput 单独白名单、JSON Schema 输出、查询事件消费、超时中断、session ID 观察，以及 usage 归一化。它们有明确的输入/输出和测试边界，因此进入 `@saga/codebuddy-agent-runtime`。

包名选择 CodeBuddy，是为了对应实际依赖 `@tencent-ai/agent-sdk`；WorkBuddy 是用户接触到的产品 / 宿主体验名称。使用示例和 Skill 仍同时使用 WorkBuddy/CodeBuddy 便于检索。

边界：

- npm package：CodeBuddy `query()` 的调用、默认选项、输出抽取、事件回调、usage、timeout/abort。
- 应用层：业务 Prompt、每个任务使用哪个模型/effort、Zod 最终校验、重试与持久化。
- 应用暂留：unstable v2 Session 的池化与重用策略、小说任务 profile、Run/Batch scope、SQLite 历史和长文档工作流。它们目前主要由一个应用验证，且上游 Session API 标记为 unstable；不要急着发布为稳定抽象。
- Skill：WorkBuddy 如何操作代码仓库、维护记忆、运行验证与完成任务。这是宿主操作方法，不是 SDK runtime。

与 `@saga/copilot-agent-runtime` 的关系：两者是不同供应商的独立 adapter，不做统一到最低公分母的巨大接口。公共的事件关联字段放在 `@saga/agent-contracts`，而供应商特有的流、会话和 usage 仍由各自 runtime 处理。

参考：
- [WorkBuddy/CodeBuddy SDK 快速开始](https://cloud.tencent.cn/document/product/1831/137023)
- [TypeScript SDK 参考](https://cloud.tencent.cn/document/product/1831/137028)
- [本机 Agent Service 的实现](https://github.com/devweekly/vocal-saga/tree/main/local-agent-service/src/agents)


---

## Pattern 28：Agent tracing 适合独立 package，但不应该变成新的 LangSmith

Trace 是多个应用重复出现的横向能力：事件关联、sequence、span 开始/结束、脱敏、载荷限制、持久化和查询稳定可复用；Trace UI、业务 action、policy、approval、授权和监管审计不属于这层。

@saga/agent-tracing 的边界：
- 统一使用 AgentEvent contract，并生成稳定的 event ID、时间戳和 trace context。
- 为一次逻辑 trace 顺序分配 sequence，并让 span helper 记录 started / completed / failed 和耗时。
- 在持久化前递归脱敏敏感字段；超过大小限制的 payload 必须明确标记不完整，不能伪装成完整证据。
- 提供内存 store、内置 SQLite store 和可替换的 AgentTraceStore 接口。
- 按 trace、turn、session、event type、category 和时间段查询，事件按时间正序返回。

明确不负责：
- LangSmith / OpenTelemetry collector、托管 dashboard、告警和远程 trace 导出。
- 多租户权限、保留/删除策略、备份与防篡改。
- 证明 Actor 具有权限、Approval 已发生或业务副作用成功。
- 自动收集隐藏推理或默认保存完整 prompt / tool payload。

简单用法：

```ts
const context = tracing.createContext({ sessionId: 'conversation-1' });
await tracing.runSpan({ ...context, category: 'tool', name: 'search' }, () => search());
const events = await tracing.query({ traceId: context.traceId });
```

Tracing store 写入失败默认会向调用方传播。要求“事件必须落盘才能继续”的应用可以保持严格行为；仅把它当遥测的应用可以在自己的边界明确选择 best-effort 策略，不能由通用库默默吞掉错误。


---

## Pattern 29：文档公共化优先抽取统一数据契约和确定性纯逻辑

fanyi-extension 的文档处理已经把多种文件格式统一成稳定的 DocumentSegment，并把文档翻译拆成预算分批、阅读分页、翻译结果校验与格式解析。前面几类适合复用，格式解析器和 UI 不应该为了共享而一起挪走。

@saga/document-core 负责：
- 统一的 DocumentInput、ParsedDocument、DocumentSegment 契约。
- 保持顺序的预算分批，可以选择在章节路径或 PDF 页边界切分。
- 不改变原始片段顺序和 ID 的逻辑分页，并允许宿主自定义页面标签。
- 将 LLM 输出限制到本批预期 ID，拒绝未知 ID、空文本、格式错误和重复 ID。
- 明确字符预算不是 token 预算。

应用仍负责 EPUB/PDF/DOCX 等格式解析、稳定 ID 的产生、导出、文档存储、缓存和翻译 Run 生命周期。包不依赖 DOM 或模型 SDK，便于浏览器与 Node 服务共同使用。

## Pattern 30：Context Assembly 是 Memory / Retrieval 之后的一层，不应等同于它们

vocal-saga 的 contextGraph.ts、voiceContext.ts 和 literary.ts 显示，上下文处理至少有三种职责：

1. **Retrieval / domain logic**：从 Context Graph、记忆、章节摘要和相邻原文中找出候选项，并执行来源证据、人物身份及章节知识边界校验。
2. **Context Assembly**：对已经被宿主允许使用的候选项进行稳定排序、去重、预算分配、渲染，并输出纳入/省略清单。
3. **Prompt / Runtime**：注入任务指令、翻译模式、结构化输出约束，并发起具体模型调用。

第二层跨项目最有机会复用，第一和第三层的领域规则则留在宿主。候选 @saga/agent-context 应先是一个无数据库、无模型调用的 TypeScript 库，而不是独立网络服务；tokenizer 通过宿主注入，不能把字符数冒充 token 数。

不要照搬 Context Language Models 的自主 Context 文件更新作为初版能力。Context item 的权限、证据可信度和时间边界必须由应用提供，通用组装器不能自行提升候选信息的可信度，也不能把未来章节知识塞进当前提示词。

详细边界与迁移顺序见 [docs/context-assembly-design.md](docs/context-assembly-design.md)。
