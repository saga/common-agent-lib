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
