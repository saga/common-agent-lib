# @saga/agent-knowledge

把多个 Agent 项目里反复出现的 Knowledge 处理拆成一个领域无关的最小层。

## 公共模型

核心层只有：

- `KnowledgeEntry)：真正存储/发布的知识单元
- `KnowledgeSource)：来源与 provenance
- `KnowledgeContent)：public / restricted 两层内容
- `KnowledgeDocument：为检索准备的投影
- `KnowledgeHit / KnowledgeEvidence：检索结果及其来源

业务项目可以扩展 `metadata` 和具体 `kind`，不要把金融、面试、Member、Learner 等字段硬塞进公共 Schema。

## 抽取

公共库不绑定 LLM：

```ts
const extractor: KnowledgeExtractor = {
  async extract(input) {
    return await myLLMExtractStructuredKnowledge(input.text);
  },
};

const entry = await extractKnowledgeEntry(
  extractor,
  {
    text: rawDocument,
    source: {
      id: 'doc-1',
      title: 'Architecture guide',
    },
  },
);
```

通用 pipeline：

```text
raw document
  ↓
extractor（LLM / local model / rules）
  ↓
Zod validation
  ↓
KnowledgeEntry
  ↓
persistent store
  ↓
KnowledgeCatalog
```

公共库只负责“结果是否合法”。模型选什么、怎么抽取、从哪些章节取值，都由应用控制。

## 使用

```ts
const catalog = new KnowledgeCatalog(entries);

const evidence = catalog.search({
  query: 'point-in-time position source',
  tags: ['finance'],
  limit: 5,
});

const context = renderKnowledgeEvidence(evidence);
```

默认检索是确定性的：

- metadata filter
- lexical matching
- tag matching
- exact phrase bonus
- 中文二字片段匹配

这样小规模知识库容易解释、容易测试，也不需要 embedding runtime。

大规模项目可以在 Catalog 外面替换成：

- BM25
- embedding / vector
- graph retrieval
- hybrid retrieval

它们都继续消费 `KnowledgeEntry` / `KnowledgeDocument`，不需要改变业务知识表示。

## Knowledge 与 Evidence

Knowledge 不等于当前任务事实：

```text
Knowledge
  = 通用、可复用的知识

Evidence
  = 当前 Investigation / Business Execution 真正查到的事实
```

公共库只提供 Knowledge。

