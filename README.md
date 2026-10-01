# common-agent-lib

几个可以独立复用的 AI Agent 公共库。目标不是再造一个 Agent Framework，而是把多个项目里反复出现、边界清楚的基础模式抽出来。

当前有三个独立 package：

| Package | 解决什么问题 | 依赖 |
| --- | --- | --- |
| `@saga/copilot-agent-runtime` | 服务端使用 GitHub Copilot SDK，统一处理 client lifecycle、session、turn、streaming、timeout、abort | `@github/copilot-sdk` |
| `@saga/agent-knowledge` | Knowledge 的通用表示、Zod schema、来源/可信度、抽取结果校验、catalog、轻量检索和安全渲染 | `zod` |
| `@saga/markdown-workflow` | 用 Markdown 表示 Workflow，解析成 AST，静态校验，并根据确定性 facts 计算 Journey 状态 | 无运行时依赖 |

三个 package **互不依赖**。业务项目可以只装自己需要的那个。

## 1. Copilot Agent Runtime

来自：

- `saga/copilot-server-agent`
- `saga/team-member-copilot-agent`
- `saga/agentic-data-architect`

共同模式：

```text
Application Service
      ↓
CopilotAgentRuntime
      ↓
CopilotClient
      ↓
CopilotSession
      ↓
runTurn()
      ↓
assistant delta / message / events
```

公共库负责：

- CopilotClient 单例/懒启动和 stop
- create / resume / delete session
- 一个 session 同时只运行一个 turn
- assistant delta / message 事件监听
- turn timeout 后显式 abort
- abort 后等待 session.idle，避免“业务已经失败但 Agent 还在跑”
- active turn 查询

公共库**不负责**：

- Member / Team / Conversation
- Execution / Approval / Policy
- Skill / Knowledge
- 数据库持久化
- 业务权限

## 2. Agent Knowledge

来自：

- `saga/ai-interview-questions` 的 `KnowledgeNode → KnowledgeDocument → retrieval`
- `saga/agentic-data-architect` 的 `ArchitectureKnowledge + source/confidence/timeSensitivity`
- `saga/team-member-copilot-agent` 的 filesystem knowledge provider

共同模式：

```text
Source / Document
      ↓
Extractor（LLM 或规则，由应用注入）
      ↓
Schema validation
      ↓
KnowledgeEntry
      ↓
Catalog / Index
      ↓
retrieve(query)
      ↓
KnowledgeEvidence
      ↓
prompt/context rendering
```

几个关键边界：

1. Knowledge 是可复用知识，不等于当前任务 Evidence。
2. Source / provenance 是 Knowledge 的一等字段。
3. Schema 在进入 catalog 前校验。
4. 检索结果应该带 source reference，回答才能说明依据。
5. 需要隐藏答案、内部字段等场景时，公共模型支持 `public` / `restricted` 内容分层；真正的权限边界仍由应用决定。
6. Extraction 只定义契约，不在公共库里绑任何 LLM。

Graph RAG、Learner Model、金融业务字段、WorkflowId 等仍属于具体项目，不进入公共库。

## 3. Markdown Workflow

来自：

- `saga/copilot-server-agent` 的 Skill Flow / flow lint
- `saga/agentic-data-architect` 的 `@flow / @task / @gate / @review / @end / @stop` + Journey runtime

共同模式：

```text
SKILL.md
  ↓
parseWorkflowMarkdown()
  ↓
Workflow AST
  ↓
validateWorkflow()
  ↓
application-specific facts
  ↓
buildWorkflowState()
  ↓
UI / API / next action
```

公共库只理解 Workflow 结构，不理解业务条件。

例如：

```markdown
## @flow data-review

start -> intake

## @task intake
title: 明确目标
completeWhen: goal
- success -> inspect

## @gate inspect-gate
- pass -> done
- retry -> inspect

## @end done
```

应用自己提供：

```ts
(condition, facts) => boolean
```

这样 Workflow DSL 与具体业务状态解耦。

## 与现有四个项目的对应

| 项目 | Copilot Runtime | Knowledge | Markdown Workflow |
| --- | --- | --- | --- |
| copilot-server-agent | 主模式 | 少量 Skill/运行上下文 | 有 Skill Flow / lint |
| ai-interview-questions | Copilot conversation / Agent runtime | 最成熟：schema + projection + lexical/metadata/graph retrieval | Skills，但不是公共 Workflow runtime 的主要来源 |
| team-member-copilot-agent | 主模式：MemberRuntime → CopilotSession | filesystem knowledge / scoped knowledge | Skill 作为 SDK 输入 |
| agentic-data-architect | Copilot session | Architecture Knowledge catalog | 最完整：Markdown parser + Journey state + lint |

## 暂时不要抽进来

这些虽然也能在项目里看到，但现在还不够通用：

- Agent Authorization / Policy
- Audit / Evidence
- MCP registry
- Team / Member / Conversation
- Business State
- Human Task / Approval
- Learner model
- Graph RAG
- Evaluation framework

它们都有明显的业务或安全语义，过早抽公共库反而会产生依赖和耦合。

## 后续迁移顺序

建议先让新的项目直接使用这三个 package。

成熟后再逐个从四个现有项目里删除重复实现：

1. Copilot SDK service / turn runner
2. Knowledge schema / catalog / extraction boundary
3. Markdown Workflow parser / validator / Journey runtime

不要第一天就把四个项目全部改成依赖 common-agent-lib。先把公共契约稳定下来。
