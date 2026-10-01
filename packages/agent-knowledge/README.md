# @saga/agent-knowledge

把多个 Agent 项目里反复出现的 Knowledge 处理拆成一个领域无关的最小层。

## 数据模型

核心层只有：

- KnowledgeEntry：真正存储/发布的知识单元
- KnowledgeSource：来源与 provenance
- KnowledgeContent：public / restricted 两层内容
- KnowledgeDocument：为检索准备的投影
- KnowledgeHit / KnowledgeEvidence：检索结果及其来源

业务项目可以在外面扩展 metadata 和具体 kind，不把金融、面试、Member 等字段塞进公共模型。

## 抽取

公共库不绑定 LLM：

~~~ts
const extractor: KnowledgeExtractor = {
  async extract(input) {
    return await myLLMExtractStructuredKnowledge(input.text);
  },
};

const entry = await extractKnowledge(
  extractor,
  { text: rawDocument, source },
  KnowledgeEntrySchema,
);
~~~

推荐 pipeline：

~~~text
raw document
  ↓
extractor
  ↓
Zod validation
  ↓
KnowledgeEntry
  ↓
persistent store
  ↓
KnowledgeCatalog
~~~

所以公共库负责“抽取结果是否合法”，而不是决定使用哪个模型。

## 使用

~~~ts
const catalog = new KnowledgeCatalog(entries);

const evidence = catalog.search({
  query: 'point-in-time position source',
  tags: ['finance'],
  limit: 5,
});

for (const hit of evidence.hits) {
  console.log(hit.title, formatKnowledgeSources(hit.sources));
}
~~~

### 为什么默认不是 Vector RAG

小规模、人工整理的知识库先使用确定性检索：

- 可解释
- 容易测试
- 不需要 embedding runtime
- 出问题容易定位

BM25、embedding、graph retrieval 都可以作为 catalog 外部实现，不需要改变 KnowledgeEntry 契约。

## 与现有项目的对应

- ai-interview-questions：KnowledgeNode 是领域模型，KnowledgeDocument 是检索投影；Question / Concept Graph 仍留在项目内。
- agentic-data-architect：ArchitectureKnowledge 的 source / confidence / timeSensitivity 可以映射到 KnowledgeSource / metadata。
- team-member-copilot-agent：filesystem knowledge provider 可以把文件解析成 KnowledgeEntry，再由应用决定如何绑定 Team / Member。
