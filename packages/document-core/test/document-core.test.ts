import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDocumentPages,
  buildSegmentBatches,
  estimateChars,
  getMissingDocumentBatchIds,
  normalizeDocumentBatchResult,
  type DocumentSegment,
  type ParsedDocument,
} from '../src/index.js';

function segment(
  id: string,
  text: string,
  extras: Partial<DocumentSegment> = {},
): DocumentSegment {
  return { id, index: Number(id.replace(/\D/g, '')) || 0, text, kind: 'paragraph', ...extras };
}

function document(
  format: ParsedDocument['format'],
  segments: DocumentSegment[],
): ParsedDocument {
  return {
    format,
    title: 'Test',
    segments,
    meta: {
      charCount: estimateChars(segments),
      segmentCount: segments.length,
      warnings: [],
    },
  };
}

test('batches by character and segment budgets while preserving order', () => {
  const source = [segment('s1', '123'), segment('s2', '45'), segment('s3', '6789'), segment('s4', 'x')];
  const batches = buildSegmentBatches(source, { maxChars: 5, maxSegments: 2 });
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [
    ['s1', 's2'],
    ['s3', 's4'],
  ]);
  assert.equal(estimateChars(source), 10);
});

test('oversize segments remain intact in their own batch', () => {
  const source = [segment('s1', 'x'), segment('s2', 'a'.repeat(20)), segment('s3', 'z')];
  const batches = buildSegmentBatches(source, { maxChars: 5, maxSegments: 5 });
  assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [['s1'], ['s2'], ['s3']]);
  assert.equal(batches[1]?.[0]?.text.length, 20);
});

test('optional context boundary split respects chapter and PDF page changes', () => {
  const source = [
    segment('s1', 'a', { contextPath: 'Chapter 1', page: 1 }),
    segment('s2', 'b', { contextPath: 'Chapter 1', page: 1 }),
    segment('s3', 'c', { contextPath: 'Chapter 2', page: 1 }),
    segment('s4', 'd', { contextPath: 'Chapter 2', page: 2 }),
  ];
  assert.deepEqual(
    buildSegmentBatches(source, { maxChars: 100, maxSegments: 10, splitOnContextChange: true })
      .map((batch) => batch.map((item) => item.id)),
    [['s1', 's2'], ['s3'], ['s4']],
  );
});

test('invalid batch budgets fail early rather than producing empty batches', () => {
  assert.throws(() => buildSegmentBatches([segment('s1', 'x')], { maxSegments: 0 }), /maxSegments/);
  assert.throws(() => buildSegmentBatches([segment('s1', 'x')], { maxChars: Number.NaN }), /maxChars/);
});

test('pagination creates bounded generic pages without mutating source segments', () => {
  const source = [
    segment('s1', 'abc', { kind: 'heading' }),
    segment('s2', 'de'),
    segment('s3', 'gh'),
  ];
  const originalIds = source.map((item) => item.id);
  const pages = buildDocumentPages(document('txt', source), { maxChars: 4, maxSegments: 10 });
  assert.deepEqual(pages.map((page) => page.segments.map((item) => item.id)), [['s1'], ['s2', 's3']]);
  assert.deepEqual(source.map((item) => item.id), originalIds);
  assert.equal(pages[0]?.sectionTitle, 'abc');
  assert.equal(pages[0]?.charCount, 3);
  assert.equal(pages[1]?.title, '阅读页 2');
});

test('EPUB pagination keeps adjacent spine paths together and splits long chapters', () => {
  const source = [
    segment('s1', 'abc', { path: 'ch1.xhtml', contextPath: '第一章' }),
    segment('s2', 'de', { path: 'ch1.xhtml', contextPath: '第一章' }),
    segment('s3', 'fgh', { path: 'ch2.xhtml', contextPath: '第二章' }),
  ];
  const pages = buildDocumentPages(document('epub', source), { maxChars: 4, maxSegments: 10 });
  assert.deepEqual(pages.map((page) => page.segments.map((item) => item.id)), [['s1'], ['s2'], ['s3']]);
  assert.equal(pages[0]?.sectionTitle, '第一章');
  assert.equal(pages[2]?.sectionTitle, '第二章');
});

test('PDF pagination groups adjacent source pages and supports custom labels', () => {
  const source = [
    segment('s1', 'a', { page: 1 }),
    segment('s2', 'b', { page: 1 }),
    segment('s3', 'c', { page: 2 }),
  ];
  const pages = buildDocumentPages(document('pdf', source), {
    labels: { pdfPage: (page) => 'Page ' + page },
  });
  assert.deepEqual(pages.map((page) => page.title), ['Page 1', 'Page 2']);
  assert.deepEqual(pages.map((page) => page.segments.map((item) => item.id)), [['s1', 's2'], ['s3']]);
});

test('pagination validates budgets', () => {
  assert.throws(() => buildDocumentPages(document('txt', [segment('s1', 'x')]), { maxChars: 0 }), /maxChars/);
});

test('normalization keeps only expected non-empty first translations', () => {
  const result = normalizeDocumentBatchResult([
    ['s1', ' translated  '],
    ['s2', '   '],
    ['unknown', 'ignore'],
    ['s1', 'duplicate'],
    ['bad'],
    { id: 's3', text: 'ignore' },
  ], ['s1', 's2']);
  assert.deepEqual([...result.entries()], [['s1', ' translated  ']]);
  assert.deepEqual(getMissingDocumentBatchIds(['s1', 's2', 's3'], result), ['s2', 's3']);
});

test('normalization handles malformed top-level values and missing IDs', () => {
  assert.equal(normalizeDocumentBatchResult(null, ['s1']).size, 0);
  assert.deepEqual(getMissingDocumentBatchIds(['s1'], new Map([['s1', '  ']])), ['s1']);
});
