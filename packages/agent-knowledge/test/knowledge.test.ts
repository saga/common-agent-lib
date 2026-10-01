import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  KnowledgeCatalog,
  KnowledgeEntrySchema,
  extractKnowledge,
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

test('restricted content is not rendered in public mode', () => {
  const catalog = new KnowledgeCatalog([KnowledgeEntrySchema.parse(entry)]);
  const doc = catalog.find('position-source')!;

  assert.equal(catalog.render(doc, 'public').includes('Internal-only'), false);
  assert.equal(catalog.render(doc, 'full').includes('Internal-only'), true);
});

test('extraction output is validated at the boundary', async () => {
  const extractor = {
    async extract() {
      return entry;
    },
  };

  const result = await extractKnowledge(
    extractor,
    { text: 'raw document' },
    KnowledgeEntrySchema,
  );

  assert.equal(result.id, 'position-source');
});
