# AI Agent Common Patterns

本文档记录从以下四个项目代码中归纳出的公共模式：

- `saga/copilot-server-agent`
- `saga/ai-interview-questions`
- `saga/team-member-copilot-agent`
- `saga/agentic-data-architect`

它不是另一个框架设计文档，而是说明哪些重复代码已经值得抽成公共库。

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
- Approval
- Policy
- Business Execution
- Audit
- Agent-specific tools

这些都属于宿主应用。

---

## Pattern 2：Structured Knowledge

### 最成熟的共同结构

`ai-interview-questions` 已经形成：

```text
KnowledgeNode
Question
Concept Graph
       ↓
KnowledgeDocument
       ↓
query planner
       ↓
metadata + lexical + graph
       ↓
projection / redaction
       ↓
prompt context
```

`agentic-data-architect` 又补足了：

```text
Source Type
Publisher
PublishedAt
ReviewedAt
Source Confidence
Knowledge Confidence
Time Sensitivity
       ↓
Knowledge Entry
```

`team-member-copilot-agent` 补足：

```text
Knowledge Base
  ↓
Document
  ↓
scope / owner
  ↓
citation
```

因此公共层应该只保留：

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

### 抽取

抽取不要绑定模型：

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

公共库只负责：

1. 定义输入契约
2. 调用 extractor
3. validate structured result
4. 返回可信的 KnowledgeEntry

### 使用

公共 baseline：

```ts
const catalog = new KnowledgeCatalog(entries);

const evidence = catalog.search({
  query: 'point-in-time position source',
  tags: ['finance'],
  limit: 5,
});
```

返回：

```text
KnowledgeHit
  ├─ content
  ├─ score
  ├─ metadata
  └─ sources
```

之后业务项目可以替换：

- BM25
- embedding
- vector DB
- graph retrieval
- hybrid search

而不用改 KnowledgeEntry。

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

## 一个统一的宿主架构

三个 package 可以这样组合，但不是相互依赖：

```text
                    Application
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
 Copilot Agent     Knowledge     Markdown Workflow
 Runtime            Catalog          Runtime
          │            │            │
          ▼            ▼            ▼
     Copilot SDK   Search/Data   Business Facts
          │            │            │
          └────────────┼────────────┘
                       ▼
                  Agent Service
```

这三个公共库都可以单独替换或删除。

---

## 哪些暂时不要抽

从四个项目也能看到很多“看起来通用、实际上语义很重”的模块：

- Authorization / Policy
- Data Entitlement
- Approval
- Command
- Audit
- Evidence
- Team / Member
- Learner Model
- Graph RAG
- Evaluation
- MCP Registry
- Business State

这些目前都不应该进入 common-agent-lib。

原因不是做不到，而是这些模块已经携带具体业务边界。公共化以后容易出现一个“大而全”的 Agent Framework，反而失去这个仓库最重要的独立性。

## Pattern 4：Schema-first Structured Output

四个项目里凡是把 LLM 输出写进业务状态，都出现了同一个原则：先得到结构化结果，再做 Schema 验证，最后才允许进入业务状态。

典型边界：

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

`agentic-data-architect` 的 `AgentAnswerSchema`、AI Interview 的题目/变体校验，以及 Team Member 的各种运行时 Schema 都属于这一类。

现在公共库提供最后的 provider-neutral 校验层；OpenAI / LangChain 等能直接返回 parsed object 时，不需要强制经过 JSON 字符串解析。

## Pattern 5：Evaluation-first Agent

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

这个方向与 Anthropic 当前的 Agent eval 实践一致：代码、模型和人工 grader 可以组合，而且多轮 agent 需要同时观察轨迹、最终结果和环境状态。见 Anthropic 的 [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)。

## Pattern 6：Context Engineering

这是值得复刻的**设计模式**，目前不值得再造一个通用 Context Runtime。

四个项目已经反复出现：

- session history 与 application/business state 分开。
- 当前 turn 只注入增量或真正相关的上下文。
- 大结果落文件 / workspace，再用引用按需读取。
- 上下文有预算，需要截断、压缩或 just-in-time retrieval。
- 忽略的历史必须显式告诉 Agent，不能让“没看到”被误认为“没发生”。

`team-member-copilot-agent` 的 checkpoint + bounded room history、`agentic-data-architect` 的 evidence/knowledge 分层和 `ai-interview-questions` 的学习上下文，都属于这个模式。

Anthropic 现在明确推荐 just-in-time context：先保存轻量引用，运行时按需要读取数据，而不是把所有资料预先塞进上下文；LangChain 也已经把 context editing 作为 middleware；OpenAI Agents SDK 则明确区分 local `RunContext` 与 LLM-visible conversation context。这个模式应进入各项目架构规范，但暂时不要做成强绑定的 common package。

## Pattern 7：Human-in-the-loop / Interrupt

这四个项目已经出现人工确认、Stop、等待输入、审批和恢复等不同形式。

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

OpenAI Agents SDK 使用 `RunState` 保存可恢复的中断状态；LangGraph 使用 persistence + `interrupt()`；Claude Managed Agents 也把 session 与等待工具确认分开。

但 approval object、authorization、business command 和 checkpoint store 都是业务边界，所以 common-agent-lib 当前只记录这个 pattern，不做通用 HITL runtime。

## Pattern 8：Tool Contract，而不是 Tool Registry

行业实践的共同点不是“做一个巨大的 Tool Registry”，而是：

- 参数必须有明确 Schema。
- description 要告诉 Agent 什么时候用、什么时候不要用。
- 输入输出尽可能结构化。
- Tool 返回高信号结果，不把无关数据全塞回上下文。
- 需要时按服务 / 资源做命名空间。
- Tool 调用前后可以有 guardrail / validation。

Anthropic 对 tool ergonomics 的研究尤其强调：工具名称、参数命名、描述、返回内容和 evaluation 都会直接影响 agent tool-use；它还在持续推进 Tool Search / programmatic tool calling 来减少大量工具定义占用上下文。

这类规则应该进入各应用的 Tool/MCP 开发规范，而不是现在再造一个 registry。

## Pattern 9：Observability 与 Business Audit 分开

OpenAI Agents SDK、LangChain/LangSmith、Copilot runtime 都把 trace / event 作为运行观察手段。

公共设计上应该固定：

```text
Agent trace
  = 谁调用了什么、什么时候调用、运行多久、是否失败

Business audit
  = 谁批准、依据什么、访问了什么数据、执行了什么业务动作、最终采用什么决定
```

Trace 可以接 OpenTelemetry / LangSmith / OpenAI tracing；Business audit 不应该直接等同于 trace。

## Pattern 10：Progressive Disclosure / Capability Loading

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

Anthropic Agent Skills 已把这种 progressive disclosure 做成正式架构；Anthropic 还提供 Tool Search 用于在大量工具中按需发现工具。当前 common-agent-lib 的 `agent-skill` package 只负责 Skill manifest/discovery，不负责动态加载执行。

## 与 LangChain / OpenAI / Anthropic 的对照

| 行业模式 | LangChain | OpenAI Agents | Anthropic | common-agent-lib |
| --- | --- | --- | --- | --- |
| Structured Output | `response_format` + Provider/Tool Strategy | Zod / structured output | provider structured output / tool use | `agent-structured-output` |
| Context engineering | Middleware / context editing / LangGraph state | RunContext + session + input filter / compaction | just-in-time context / Skills | 设计规范，暂不单独做 runtime |
| HITL | LangGraph interrupt + persistence | RunState + interruptions | session/tool confirmation | 暂不做通用 runtime |
| Skill / progressive disclosure | middleware / tool ecosystem | agent/tool composition | Agent Skills | `agent-skill` |
| Eval | LangSmith ecosystem | tracing + eval integrations | code/model/human graders | `agent-eval` |
| Tool guardrails | middleware | input/output tool guardrails | hooks / tool permissions | 留在应用/runtime |
| Multi-agent | subagents/subgraphs | handoffs / agents-as-tools | subagents / Task | 留在应用/runtime |

结论：**复刻概念，不复刻框架内部实现。** Common library 只抽取跨框架都成立、而且边界足够稳定的纯模式。