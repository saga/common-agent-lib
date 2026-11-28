# Dreaming 与 Anthropic Agent Memory 的差异分析及演进方案

- 日期：2026-11-28
- 状态：设计分析与实现对照；原方案保留作设计依据，原定核心实施项已完成。当前状态以 README 和 IMPLEMENTATION-CHECKLIST.md 为准
- 对照对象：
  - [Anthropic: The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)
  - [ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap)，恢复出的 Claude Code 2.1.88 源码，仅作为实现研究材料
  - 本目录当前 `@saga/agent-dreaming` 实现

> 本文讨论的是设计能力和实现差距，不代表 Claude Code 的恢复源码就是 Anthropic 研究文章的全部实现。Source Map 仓库为非官方还原版本，不能将其视为 Anthropic 的内部设计规范。

> **实现状态说明（2026-11-28）**：本文最初用于分析差距并提出方案；其中保留的流程图、模型建议和验收场景用于解释设计依据，不代表仍有待实现的功能。原实施清单已经完成，逐项状态见 [IMPLEMENTATION-CHECKLIST.md](./IMPLEMENTATION-CHECKLIST.md)。Agent Dreaming 当前实现还包含 Evidence `expiresAt` 重新验证、持久化 Memory Manifest、Context Feedback 和独立 consumer 打包验证。

## 1. 结论

当前 Dreaming 的核心方向与 Anthropic 一致：保留原始经历和证据，从中形成持久记忆，持续检查、合并、纠错和淘汰，并将记忆变化记录为可追溯的运行结果。

我们当前实现更偏向一个**结构化、可审计的长期记忆维护引擎**；Anthropic 描述的是一个更完整的**Agent Memory 生命周期**，还强调主动探索历史资料、持续维护知识表示，以及按任务选择和控制上下文注入。

不需要推翻现有 Engine、SQLite、Evidence、Version、Feedback 和 Scheduler。本文记录的四项原始差距现已在独立 package 内实现：

1. **Knowledge Maintenance**：Dreaming 不只维护短小的 Memory Record，还能按需维护由多个经历支撑的主题知识页及其关系。
2. **Evidence Discovery**：已有 sourceRefs 不足时，能够在授权范围内主动检索历史经历和原始证据，而不是只消费当前已经关联好的引用。
3. **Context Assembly**：Dreaming 产出的 Memory 和 Knowledge 能在本 package 内形成小而精的常驻索引，并按当前任务检索、排序、去重和预算控制，输出可以直接注入 Agent 的上下文。
4. **Outcome Feedback**：把上下文实际使用效果反馈给记忆维护流程，帮助发现错误、过期、低价值和缺失的记忆。

本 package 必须保持独立。以上能力都应当成为 `@saga/agent-dreaming` 自身的模型、存储、算法和 API，不通过引用或依赖其他内部 package 实现。具体决策见同目录 [DECISION.md](./DECISION.md)。

## 2. Anthropic 的分层模型

Anthropic 文章描述的并非单一摘要文件，而是由不同职责组成的记忆系统：

| 层次 | 内容 | 用途 |
|---|---|---|
| Raw experiences | Transcript、工具调用、执行结果、观察和原始来源 | 保留可检查的事实来源 |
| Memory notes | 从经历提炼出的偏好、事实、规律、决策和工作方法 | 为未来任务提供可复用信息 |
| Memory representations | 主题页面、Wiki、实体和概念之间的关系 | 组织跨 Session、跨资料形成的知识 |
| Injected context | 小型索引、重要指令和当前任务相关内容 | 控制每次请求实际进入模型上下文的信息 |

Dreaming 是跨层的后台维护过程：发现值得保留的内容，回看证据，更新记忆和知识页面，修复关系，并维护下一次任务可用的索引。

需要区分两件事：**持久化记忆不等于每次都注入模型上下文；知识页面也不等于所有内容都应该建立 Wiki。** 记忆库可以完整，常驻上下文必须精简；简单问题直接检索原始资料即可，不应为了 Wiki 而制造 Wiki。

## 3. Claude Code 2.1.88 实现中值得借鉴的部分

研究材料：[ChinaSiro/claude-code-sourcemap](https://github.com/ChinaSiro/claude-code-sourcemap)。

### 3.1 SessionMemory

主要源码：

- [sessionMemory.ts](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/SessionMemory/sessionMemory.ts)
- [prompts.ts](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/SessionMemory/prompts.ts)

SessionMemory 在会话过程中，根据 Token 增长、工具调用次数和自然对话间隔触发后台提取，持续更新一份有固定章节的 Session Notes。章节涵盖当前状态、任务规格、文件和函数、工作流、错误与纠正、系统知识、经验和工作日志。

它解决的是当前长任务的连续性，不应与跨 Session 的长期 Dreaming 混为一谈。

### 3.2 AutoDream

主要源码：

- [autoDream.ts](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/autoDream/autoDream.ts)
- [consolidationPrompt.ts](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/autoDream/consolidationPrompt.ts)
- [consolidationLock.ts](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/autoDream/consolidationLock.ts)

恢复出的默认触发门槛是至少经过 24 小时且已有 5 个新 Session；排除当前 Session，使用 lock 控制并发，并将后台任务显示给用户。

Consolidation Prompt 有四个阶段：

1. Orient：先读取当前记忆目录和索引，理解已有内容。
2. Gather recent signal：查看近期日志，必要时针对线索搜索 JSONL Transcript，不穷举读取所有历史。
3. Consolidate：更新已有主题文件、合并重复记忆、纠正与当前事实冲突的内容。
4. Prune and index：移除过期索引，缩短入口索引，将细节保留在主题文件中。

值得借鉴的是**先理解已有记忆，再有针对性地找证据，最后维护知识和入口索引**，而不是周期性地重新总结全部历史。

## 4. 当前 common-agent-lib Dreaming 已经具备的能力

当前实现包括：

- Experience、Evidence、Memory、Relationship 的结构化记录。
- 跨来源的稳定 owner scope 和 origin provenance。
- 基于 sourceRefs、时间、重要性和可选本地向量索引的记忆选择。
- 对原始 Evidence 的解析和引用校验。
- 结构化增删改、合并、supersede 和 archive proposal。
- 自动提交有效提案、SQLite 事务、幂等键和变更前版本快照。
- 记忆过期和定期复查。
- 用户显式 remember / avoid 指令的直接写入及保护。
- Retrieval usefulness、evidence support、user correction 和 human review 等反馈统计。
- Checkpoint、Run Ledger、Lease、持久化 Scheduler 和 Worker。
- 默认无工具的 Copilot Dreaming Runtime，以及可替换的模型 Runtime 接口。

这些已经覆盖“记忆提炼、证据约束、版本化维护、运行恢复和质量反馈”的主要基础，不应为了对齐另一套实现而重写。

## 5. 差异判断

| 能力 | Anthropic / Claude Code 研究及实现 | 当前 Dreaming | 判断 |
|---|---|---|---|
| 原始经历 | Transcript / JSONL 可搜索 | Experience + Evidence、历史证据检索 | 已实现 |
| 长期记忆 | 主题化记忆文件 | SQLite Memory、版本和事务 | 已实现 |
| 记忆纠错 | 回看历史、修订已有文件 | Evidence 驱动的提案验证、自动提交和过期复查 | 已实现 |
| 知识表示 | Wiki、主题页和双向关系 | 版本化 Knowledge Page、Link、Maintenance | 已实现 |
| 记忆入口 | 小型 MEMORY.md 索引 | 持久化、按 scope 生成的 Memory Manifest | 已实现 |
| 任务相关注入 | 入口索引 + 按需读取 | Context Builder、预算、来源和省略诊断 | 已实现 |
| 运行可靠性 | 后台 fork、时间门槛和文件锁 | SQLite Scheduler、Lease、Checkpoint、Run Ledger | 已实现 |
| 质量反馈 | 研究中的任务表现评估 | 结构化 Feedback、context hash / revision 关联 | 已实现 |

## 6. 差异二：Knowledge / Wiki Maintenance 应该怎么做

### 6.1 不要把 Memory 全部转换成 Wiki

Memory 与 Knowledge 是不同的持久化对象：

- **Memory**：关于记忆所有者或 Agent 的事实、偏好、目标、约束、经验和行为规律。
- **Knowledge**：可跨任务复用的概念、主题、系统说明、领域知识、流程以及这些内容之间的关系。
- **Evidence**：支持 Memory 或 Knowledge 的原始经历、文档片段、工具结果和其他来源。

例如：

- “用户更喜欢直接的技术回答”是 Memory。
- “某系统的事件处理流程及故障恢复机制”是 Knowledge。
- “这条流程来自设计文档第 4 节和一次验证过的故障排查”是 Evidence。

不要因为一条 Experience 就自动生成一个 Knowledge 页面。只有在有明确复用价值时才创建主题页，例如多个独立经历反复涉及同一概念、已有页面需要补充、多个条目需要建立关系，或者用户明确提出长期研究目标。

### 6.2 在 agent-dreaming 内增加 Knowledge 数据模型

当前 package 已在内部实现独立的知识实体，而不是把长篇内容塞进 `DreamingMemory.content`。

建议的最小模型：

| 实体 | 主要字段 | 作用 |
|---|---|---|
| KnowledgePage | id、scope、title、summary、content、status、tags、sourceRefs、version、updatedAt | 一份可独立检索和维护的主题知识 |
| KnowledgeLink | id、scope、fromId、toId、kind、sourceRefs | 主题、概念及页面间关系 |
| KnowledgeVersion | pageId、version、snapshot、reason、capturedAt | 记录页面每次变化前后的版本 |
| KnowledgeProposal | id、operation、targetIds、proposedPage、evidenceRefs、rationale | 模型提出的知识维护操作 |

关系类型至少支持：

- related-to
- supports
- contradicts
- derived-from
- supersedes

知识页面必须保留来源引用。页面中的结论不能脱离 Evidence 独立存在；Evidence 更新时，相关页面应进入重新检查队列。

### 6.3 维护流程

当前实现将 Knowledge Maintenance 放在 Dreaming 流程内，作为有条件触发的阶段：

1. **Discover**：从本次已处理 Experience、现有 Memory、Knowledge 和反馈中寻找有复用价值的主题。
2. **Retrieve**：读取相关 Knowledge 页面和原始 Evidence；发现现有引用不完整时，调用本 package 的历史证据搜索。
3. **Propose**：模型返回 create、revise、merge、link、supersede、deprecate 等结构化提案。
4. **Validate**：检查 scope、目标 ID、Evidence 来源、关系端点、重复页面和冲突。
5. **Commit**：在 SQLite 事务中写入页面、关系、版本和幂等记录。
6. **Reindex**：更新 FTS 和可选向量索引，并重建受影响的知识入口索引。
7. **Verify**：检查失效链接、没有来源的结论、重复主题和被新证据推翻的旧页面。

模型只负责提出变更。引擎负责验证和提交；所有实际变更都必须保留旧版本及 Evidence 关联。

### 6.4 索引和检索

本 package 已提供两种检索路径：

- 主题检索：按 title、summary、tags、正文和来源进行全文检索。
- 语义检索：复用本 package 自身的 EmbeddingProvider / VectorIndex 能力。

先使用 SQLite FTS5 和当前已有的向量索引基础，避免为了 Wiki 引入独立图数据库或搜索服务。页面关系采用 SQLite 表保存，需要时按深度和数量限制展开，不能无上限遍历关系图。

Knowledge 页面不要求全部放进 Prompt。搜索命中后只返回必要页面及有限的相邻关系。

### 6.5 重要约束

- 不为一次性事件创建知识页。
- 不把个人偏好和约束自动复制成专业知识。
- 不因为两个关键词相似就合并两个语义不同的主题。
- 不允许无来源的页面结论自动成为可信知识。
- 不允许跨 scope 合并数据。
- 低置信度内容可以保留为候选，但不能因为候选状态绕过证据校验。
- 不为形式上的 Wiki 完整性制造空洞页面、过度链接和无意义摘要。

## 7. 差异三：Memory Index 和 Context Injection 应该怎么做

### 7.1 目标

持久化库可以包含大量记忆和知识，但每次模型调用只需要一小部分。

需要形成两个层次：

**Always-on Memory Index**

一个很小的常驻入口，保存最重要的全局约束、当前长期目标、核心偏好和可用主题索引。它是导航索引，不是所有 Memory 的副本。

**Task-aware Context**

根据当前任务检索出来的相关记忆、Knowledge 页面、近期经历和必要证据。完整内容按需加载，不进入每次请求的固定上下文。

不能把整个 SQLite 记忆库序列化后塞给 Agent，也不能把所有显式指令无差别地注入每个任务。

### 7.2 在本 package 内提供完整 Context Builder

当前 Context Builder 已覆盖以下职责（内部文件按存储和 API 边界组织，不要求逐项拆成独立 package）：

- `context/retriever.ts`：统一检索 Memory、Knowledge 和 Recent Experience。
- `context/selector.ts`：执行 scope、有效期、authority、相关性和重要性过滤及排序。
- `context/budget.ts`：控制 Token / 字符预算，保留必需项并说明溢出。
- `context/renderer.ts`：按稳定章节顺序生成 Markdown 或结构化 Context。
- `context/manifest.ts`：维护常驻 Memory Index。

对外 API 可以采用：

```ts
const context = await dreaming.buildContext({
  scope,
  task: currentTask,
  query: currentTask,
  budget: {
    maxTokens: 12_000,
    reservedTokens: 2_000,
  },
});

const promptContext = context.text;
```

当前 API 已由 `SqliteDreamingStore.buildContext()` 暴露；可运行示例见 [README 的 task-aware context 章节](./README.md#search-and-task-aware-context)。

Context Result 应至少包含：

- 最终文本和实际消耗预算。
- Included / omitted item IDs。
- 每条内容的来源类型、sourceRefs、memory/page version。
- 排除原因，例如不相关、过期、重复或预算不足。
- 当前 context 的稳定 hash，便于后续关联实际任务结果。

### 7.3 选择顺序

建议先按有效性和授权范围过滤，再按照以下优先级竞争上下文预算：

1. 当前任务明确要求的约束和必需上下文。
2. 与当前任务适用的 user-explicit Memory。
3. 当前有效的目标、进行中的上下文及重要约束。
4. 与任务高度相关的 confirmed / high-confidence Memory。
5. 最相关的 Knowledge 页面及有限的关联页面。
6. 必要的近期 Experience 或原始 Evidence。

优先级不是简单的固定类型排序。任务相关性、是否仍然有效、来源可信度、显式程度和用户纠正历史都应参与排序。

用户显式指令具有更高权威性，但仍要区分适用范围。例如，项目 A 的格式偏好不能自动注入项目 B 的任务。高权威不等于无条件全局注入。

### 7.4 两阶段注入

每次 Agent 任务的上下文构建建议分成两步：

**阶段 A：常驻入口**

读取小型 Memory Index，只放入真正需要每次都知道的信息和主题导航。索引大小设置明确上限，Dreaming 修改重要 Memory 或 Knowledge 后增量重建。

**阶段 B：任务检索**

使用当前任务描述检索记忆与知识，结合 FTS / 向量相似度、scope、时间有效性、authority 和重要程度排序，去重后放入剩余预算。

只有被选中的内容才注入。原始证据默认只携带引用和短摘要，Agent 或 Host 需要核实时再通过本 package 的 Evidence API 按引用加载。

### 7.5 预算和失败策略

- 支持调用方提供 Token Counter；默认提供确定性的本地字符估算。
- 预算包含标题、分隔符和元数据，不只统计正文。
- 必需内容不能被静默丢弃；超过预算时返回明确的 overflow issue。
- 可选内容按优先级进入预算，超出的项目必须返回 omission reason。
- 检索失败时退化到 SQLite FTS / 精确引用，不允许因此扩大注入范围。
- 不允许因为索引缺失而把全部记忆加载进 Prompt。
- 默认限制知识图谱展开深度和数量。

### 7.6 反馈闭环

Context Builder 必须返回所使用的 memory/page ID 和版本。任务结束后，调用方可以将结果反馈到本 package：

- 有用 / 无用。
- 是否与实际证据相符。
- 是否被用户纠正。
- 是否过期或不适用。
- 任务完成情况及关联任务 ID。

这些事件进入已有 Feedback 体系。Dreaming 在后续运行中据此重新检查原始 Evidence，必要时修订或归档 Memory / Knowledge。

“被检索到”不能直接算作有用；必须根据实际任务结果记录反馈。

## 8. 原实施顺序（已完成）

| 状态 | 工作项 | 验收结果 |
|---|---|---|
| 完成 | 统一 package 内部的 Memory、Knowledge、Evidence 模型 | 不需要其他内部 package；数据有明确 owner scope 和来源 |
| 完成 | KnowledgePage、KnowledgeLink、Version、Proposal 及 SQLite 迁移 | 可以创建、更新、合并、链接、废弃并保留版本 |
| 完成 | 历史证据搜索 | 从 Experience / Memory 线索检索同 scope 的 Evidence |
| 完成 | Knowledge Maintenance 阶段 | 按价值门槛增量维护知识页，不强制生成 Wiki |
| 完成 | Memory Index | 持久化入口索引有固定预算并可重建 |
| 完成 | Context Builder | 任务相关、有界、可解释、可追溯的 Context |
| 完成 | Context Feedback | 使用结果关联到实际注入的 context hash 和版本 |

## 9. 验收场景

至少通过以下端到端场景：

1. **重复知识积累**：多个 Session 对同一系统形成独立 Evidence，Dreaming 产生一份主题页，不生成多个近似页面。
2. **知识更新**：新证据修正旧结论，更新页面并保存旧版本；引用该旧结论的关系得到重新检查。
3. **冲突保留**：两个来源互相矛盾时，保留来源与冲突，不让模型无证据地选边。
4. **按需注入**：查询主题 A 时，不注入无关主题 B 的页面及其完整 Evidence。
5. **显式约束保护**：模型不能修改 user-explicit Memory；只在相关任务中注入适用的约束。
6. **预算可解释**：Context 超预算时保留必需项，明确报告 overflow 和被省略内容。
7. **反馈纠错**：任务结果反馈某条记忆过时后，Dreaming 能回查原始 Evidence、更新记忆并保留版本。
8. **Scope 隔离**：任何历史搜索、知识检索、索引生成和上下文构建都不能读取其他 scope 的数据。
9. **无外部内部包依赖**：单独打包安装后，Memory、Knowledge、Evidence Search、Context Assembly 和持久化能力均可使用。

## 10. 不应该做的事

- 不要改成 Claude Code 的 Markdown 文件存储实现；SQLite 仍然是默认的结构化持久化。
- 不要新增一个独立 Wiki package 或 Context package。
- 不要把所有 Memory 自动转换成 Knowledge 页面。
- 不要每次 Session 都全量注入 Memory 和 Knowledge。
- 不要在 Dreaming 中引入复杂的多 Agent 审批流水线；模型提案、引擎验证、自动提交和版本保留即可。
- 不要把向量相似度或模型质量分数当作事实真实性和授权依据。
- 不要把 Session、应用或 Provider 当作个人 Memory 的隔离边界。
- 不要因为追求通用性而把本 package 拆成一组互相依赖的内部 package。

## References

- [Anthropic — The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory)
- [Claude Code 2.1.88 AutoDream](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/autoDream/autoDream.ts)
- [Claude Code 2.1.88 Consolidation Prompt](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/autoDream/consolidationPrompt.ts)
- [Claude Code 2.1.88 Session Memory](https://github.com/ChinaSiro/claude-code-sourcemap/blob/main/restored-src/src/services/SessionMemory/sessionMemory.ts)
- [Current Dreaming implementation](./src/engine.ts)
- [Current Dreaming model and persistence types](./src/types.ts)
