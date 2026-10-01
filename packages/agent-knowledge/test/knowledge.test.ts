import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KnowledgeCatalog,
  KnowledgeEntrySchema,
  extractKnowledgeEntry,
  renderKnowledgeEvidence,
} from '../src/index.js';

const entry = {
  id: 'position-source',
  title: 'Position Source',
  kind: 'architecture-practice',
  summary: 'Use authoritative source and as-of semantics.',
  content: {
    public: 'Check authoritative source, as-of date, and reconciliation.',
    restricted: 'Internal-only answer details.',
  },
  tags: ['finance', 'position'],
  metadata: { workflow: 'assessment' },
  sources: [
    {
      id: 'src-1',
      title: 'Architecture Guide',
      uri: 'https://example.com/guide',
      confidence: 'high' as const,
    },
  ],
};

test('validates a KnowledgeEntry and searches it deterministically', () => {
  const parsed = KnowledgeEntrySchema.parse(entry);
  const catalog = new KnowledgeCatalog([parsed]);
  const evidence = catalog.search({ query: 'authoritative position source' });

  assert.equal(catalog.size, 1);
  assert.equal(evidence.hits[0]?.id, 'position-source');
  assert.match(catalog.render(evidence.hits[0]!), /authoritative source/);
});

test('Chinese queries use lightweight bigram matching', () => {
  const catalog = new KnowledgeCatalog([KnowledgeEntrySchema.parse({
    ...entry,
    id: 'chinese',
    title: '数据源真相',
    summary: '确认权威数据源和时间口径。',
    content: { public: '检查数据源、时间点和对账。' },
    tags: ['数据架构'],
  })]);

  const evidence = catalog.search({ query: '数据源' });
  assert.equal(evidence.hits[0]?.id, 'chinese');
});

test('restricted content is not rendered in public mode', () => {
  const catalog = new KnowledgeCatalog([KnowledgeEntrySchema.parse(entry)]);
  const doc = catalog.find('position-source')!;

  assert.equal(catalog.render(doc, 'public').includes('Internal-only'), false);
  assert.equal(catalog.render(doc, 'full').includes('Internal-only'), true);
});

test('full knowledge rendering includes restricted content when requested', () => {
  const catalog = new KnowledgeCatalog([KnowledgeEntrySchema.parse(entry)]);
  const evidence = catalog.search({ query: 'position' });

  const rendered = renderKnowledgeEvidence(evidence, 'full');
  assert.match(rendered, /Internal-only answer details/);
});

test('knowledge rendering preserves source provenance', () => {
  const catalog = new KnowledgeCatalog([KnowledgeEntrySchema.parse(entry)]);
  const evidence = catalog.search({ query: 'position' });

  const rendered = renderKnowledgeEvidence(evidence);
  assert.match(rendered, /Architecture Guide/);
  assert.match(rendered, /https:\/\/example.com\/guide/);
});

test('extraction output is validated at the boundary', async () => {
  const extractor = {
    async extract() {
      return entry;
    },
  };

  const result = await extractKnowledgeEntry(
    extractor,
    { text: 'raw document' },
  );

  assert.equal(result.id, 'position-source');
});

test('invalid extractor output cannot enter the catalog', async () => {
  const extractor = {
    async extract() {
      return { id: '', title: 'bad' };
    },
  };

  await assert.rejects(
    () => extractKnowledgeEntry(extractor, { text: 'raw document' }),
  );
});
