import * as z from 'zod';

export const KnowledgeConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type KnowledgeConfidence = z.infer<typeof KnowledgeConfidenceSchema>;

export const KnowledgeTimeSensitivitySchema = z.enum([
  'stable',
  'contextual',
  'time-sensitive',
]);
export type KnowledgeTimeSensitivity = z.infer<typeof KnowledgeTimeSensitivity>;

export const KnowledgeSourceSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  uri: z.string().optional(),
  publisher: z.string().optional(),
  sourceType: z.string().optional(),
  publishedAt: z.string().optional(),
  reviewedAt: z.string().optional(),
  confidence: KnowledgeConfidenceSchema.optional(),
  timeSensitivity: KnowledgeTimeSensitivitySchema.optional(),
  note: z.string().optional(),
}).strict();
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

export const KnowledgeContentSchema = z.object({
  /** 模型普通回答可以看到的内容。 */
  public: z.string(),
  /** 只有应用明确选择 full 模式才允许进入模型上下文。 */
  restricted: z.string().optional(),
}).strict();
export type KnowledgeContent = z.infer<typeof KnowledgeContentSchema>;

export const KnowledgeEntrySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string().min(1),
  content: KnowledgeContentSchema,
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  status: z.enum(['active', 'draft', 'deprecated']).default('active'),
  sources: z.array(KnowledgeSourceSchema).default([]),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
}).strict();
export type KnowledgeEntry = z.infer<typeof KnowledgeEntrySchema>;

export const KnowledgeBankSchema = z.array(KnowledgeEntrySchema);
export type KnowledgeBank = z.infer<typeof KnowledgeBankSchema>;

export interface KnowledgeExtractionInput {
  /** 要抽取的原始文本/文档内容。 */
  text: string;
  /** 文档来源；建议应用始终传入，用于后续 provenance。 */
  source?: KnowledgeSource;
  /** 领域应用自己的附加上下文，不进入公共 Schema。 */
  context?: Record<string, unknown>;
}

export interface KnowledgeExtractor<T = unknown> {
  extract(input: KnowledgeExtractionInput): Promise<T>;
}

/**
 * Extraction 只定义契约，不绑定 LLM。
 * 调用方可以用 Copilot、其它模型或规则脚本实现 extract。
 *
 * schema 是真正的边界：模型返回的对象只有通过 schema.parse()
 * 才能进入后面的 KnowledgeEntry / Catalog。
 */
export async function extractKnowledge<T>(
  extractor: KnowledgeExtractor<unknown>,
  input: KnowledgeExtractionInput,
  schema: z.ZodType<T>,
): Promise<T> {
  const raw = await extractor.extract(input);
  return schema.parse(raw);
}

/** 直接抽取一个公共 KnowledgeEntry 的便捷封装。 */
export async function extractKnowledgeEntry(
  extractor: KnowledgeExtractor<unknown>,
  input: KnowledgeExtractionInput,
): Promise<KnowledgeEntry> {
  return extractKnowledge(extractor, input, KnowledgeEntrySchema);
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  kind: string;
  text: string;
  restrictedText?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  sources: KnowledgeSource[];
}

export interface KnowledgeSearchQuery {
  query: string;
  limit?: number;
  kind?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface KnowledgeHit {
  id: string;
  title: string;
  kind: string;
  content: string;
  restrictedContent?: string;
  score: number;
  tags: string[];
  metadata: Record<string, unknown>;
  sources: KnowledgeSource[];
}

export interface KnowledgeEvidence {
  query: string;
  hits: KnowledgeHit[];
}

export type KnowledgeRenderMode = 'public' | 'full';

export function toKnowledgeDocument(entry: KnowledgeEntry): KnowledgeDocument {
  return {
    id: entry.id,
    title: entry.title,
    kind: entry.kind,
    text: [entry.title, entry.summary, entry.content.public, ...entry.tags].join('\n'),
    ...(entry.content.restricted ? { restrictedText: entry.content.restricted } : {}),
    tags: entry.tags,
    metadata: entry.metadata,
    sources: entry.sources,
  };
}

/**
 * 小规模知识库默认使用确定性检索。
 * 不引入 vector DB，也不要求 embedding；项目以后可以在外面替换 index。
 */
export class KnowledgeCatalog {
  private readonly documents: KnowledgeDocument[];

  constructor(entries: KnowledgeEntry[]) {
    this.documents = entries
      .map((entry) => KnowledgeEntrySchema.parse(entry))
      .map(toKnowledgeDocument);
  }

  static fromJson(value: unknown): KnowledgeCatalog {
    return new KnowledgeCatalog(KnowledgeBankSchema.parse(value));
  }

  get size(): number {
    return this.documents.length;
  }

  find(id: string): KnowledgeDocument | undefined {
    return this.documents.find((document) => document.id === id);
  }

  search(query: KnowledgeSearchQuery): KnowledgeEvidence {
    const limit = Math.max(1, query.limit ?? 5);
    const terms = tokenize(query.query);
    const requiredTags = new Set(query.tags ?? []);

    const hits = this.documents
      .filter((document) => {
        if (query.kind && document.kind !== query.kind) return false;
        if (
          requiredTags.size > 0 &&
          ![...requiredTags].every((tag) => document.tags.includes(tag))
        ) {
          return false;
        }
        if (query.metadata) {
          for (const [key, value] of Object.entries(query.metadata)) {
            if (document.metadata[key] !== value) return false;
          }
        }
        return true;
      })
      .map((document) => {
        const haystack = new Set(tokenize(document.text));
        let lexical = 0;
        for (const term of terms) {
          if (haystack.has(term)) lexical += 1;
        }

        const queryText = query.query.trim().toLocaleLowerCase();
        const lower = document.text.toLocaleLowerCase();
        const exactPhrase = queryText.length > 0 && lower.includes(queryText);
        const tagHit = document.tags.some((tag) => terms.includes(tag.toLocaleLowerCase()));

        const score = lexical + (exactPhrase ? 1.5 : 0) + (tagHit ? 0.5 : 0);
        return { document, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
      .slice(0, limit)
      .map(({ document, score }) => ({
        id: document.id,
        title: document.title,
        kind: document.kind,
        content: document.text,
        ...(document.restrictedText ? { restrictedContent: document.restrictedText } : {}),
        score,
        tags: document.tags,
        metadata: document.metadata,
        sources: document.sources,
      }));

    return { query: query.query, hits };
  }

  render(
    hit: KnowledgeHit | KnowledgeDocument,
    mode: KnowledgeRenderMode = 'public',
  ): string {
    const publicText = 'content' in hit ? hit.content : hit.text;
    if (mode === 'public') return publicText;

    const restricted = 'restrictedText' in hit ? hit.restrictedText : undefined;
    return restricted ? publicText + '\n' + restricted : publicText;
  }
}

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const wordTokens = normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  const cjkChars = [...normalized].filter((char) => /[\u3400-\u9fff]/u.test(char));
  const cjkTokens: string[] = [];
  for (let index = 0; index < cjkChars.length - 1; index += 1) {
    cjkTokens.push(cjkChars[index] + cjkChars[index + 1]);
  }

  return [...new Set([...wordTokens, ...cjkTokens])];
}

export function formatKnowledgeSources(sources: KnowledgeSource[]): string[] {
  return sources.map((source) => {
    const publisher = source.publisher ? '（' + source.publisher + '）' : '';
    const uri = source.uri ? ' ' + source.uri : '';
    return (source.title + publisher + uri).trim();
  });
}

/**
 * 给 Agent 或 UI 生成带来源的知识片段。
 * 这不是 Evidence renderer；它只是明确告诉使用方“这是 Knowledge，以及来源是什么”。
 */
export function renderKnowledgeEvidence(
  evidence: KnowledgeEvidence,
  mode: KnowledgeRenderMode = 'public',
): string {
  if (!evidence.hits.length) return '';

  return [
    '## Knowledge',
    ...evidence.hits.map((hit) => {
      const sourceLines = formatKnowledgeSources(hit.sources);
      return [
        '### ' + hit.title,
        renderHitContent(hit, mode),
        sourceLines.length ? 'Sources:\n' + sourceLines.map((line) => '- ' + line).join('\n') : '',
      ].filter(Boolean).join('\n');
    }),
  ].join('\n\n');
}

function renderHitContent(
  hit: KnowledgeHit,
  mode: KnowledgeRenderMode,
): string {
  if (mode === 'public') return hit.content;
  return hit.restrictedContent
    ? hit.content + '\\n' + hit.restrictedContent
    : hit.content;
}
