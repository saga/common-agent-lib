import type { DocumentSegment, ParsedDocument } from './types.js';

export interface DocumentPageOptions {
  maxChars?: number;
  maxSegments?: number;
  labels?: Partial<DocumentPageLabels>;
}

export interface DocumentPageLabels {
  untitledChapter: (oneBasedIndex: number) => string;
  pdfPage: (sourcePage: number) => string;
  documentTitle: string;
  documentPage: (oneBasedIndex: number) => string;
  splitSuffix: (oneBasedIndex: number, total: number) => string;
}

export interface DocumentReaderPage {
  /** Navigation key within this pagination result; not a persisted document ID. */
  id: string;
  title: string;
  sectionTitle: string;
  segments: DocumentSegment[];
  charCount: number;
}

const DEFAULT_PAGE_OPTIONS = {
  maxChars: 10_000,
  maxSegments: 80,
};

const DEFAULT_LABELS: DocumentPageLabels = {
  untitledChapter: (index) => '第 ' + index + ' 章',
  pdfPage: (page) => 'PDF 第 ' + page + ' 页',
  documentTitle: '文档',
  documentPage: (index) => '阅读页 ' + index,
  splitSuffix: (index, total) => ' · ' + index + '/' + total,
};

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(name + ' must be a positive safe integer.');
  }
}

function headingTitle(segments: readonly DocumentSegment[]): string | undefined {
  return segments.find((segment) => segment.kind === 'heading')?.text.trim().slice(0, 100) || undefined;
}

function splitGroup(
  segments: DocumentSegment[],
  title: string,
  groupId: string,
  budget: { maxChars: number; maxSegments: number },
  labels: DocumentPageLabels,
): DocumentReaderPage[] {
  const chunks: DocumentSegment[][] = [];
  let current: DocumentSegment[] = [];
  let chars = 0;

  for (const segment of segments) {
    if (current.length > 0 &&
      (chars + segment.text.length > budget.maxChars || current.length >= budget.maxSegments)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += segment.text.length;
  }
  if (current.length > 0) chunks.push(current);

  return chunks.map((chunk, index) => ({
    id: groupId + ':' + index,
    title: title + (chunks.length > 1 ? labels.splitSuffix(index + 1, chunks.length) : ''),
    sectionTitle: title,
    segments: chunk,
    charCount: chunk.reduce((sum, segment) => sum + segment.text.length, 0),
  }));
}

/**
 * Create virtual reader pages without changing source segment order or IDs.
 * EPUB groups follow adjacent spine paths; PDF groups follow adjacent source
 * page numbers. Other formats are split only by the supplied reading budget.
 */
export function buildDocumentPages(
  document: ParsedDocument,
  options: DocumentPageOptions = {},
): DocumentReaderPage[] {
  const budget = { ...DEFAULT_PAGE_OPTIONS, ...options };
  positiveInteger('maxChars', budget.maxChars);
  positiveInteger('maxSegments', budget.maxSegments);
  const labels: DocumentPageLabels = { ...DEFAULT_LABELS, ...options.labels };
  const segments = document.segments;
  if (segments.length === 0) return [];

  if (document.format === 'epub') {
    const groups: Array<{ path: string; segments: DocumentSegment[] }> = [];
    for (const segment of segments) {
      const path = segment.path || segment.contextPath || 'epub-body';
      const previous = groups[groups.length - 1];
      if (!previous || previous.path !== path) groups.push({ path, segments: [segment] });
      else previous.segments.push(segment);
    }

    const pages: DocumentReaderPage[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const title = group.segments[0]?.contextPath ||
        headingTitle(group.segments) ||
        labels.untitledChapter(index + 1);
      pages.push(...splitGroup(group.segments, title, 'epub-' + index, budget, labels));
    }
    return pages;
  }

  if (document.format === 'pdf') {
    const groups: Array<{ page: number | undefined; segments: DocumentSegment[] }> = [];
    for (const segment of segments) {
      const page = segment.page;
      const previous = groups[groups.length - 1];
      if (!previous || previous.page !== page) groups.push({ page, segments: [segment] });
      else previous.segments.push(segment);
    }

    const pages: DocumentReaderPage[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const title = group.page
        ? labels.pdfPage(group.page)
        : labels.documentPage(index + 1);
      pages.push(...splitGroup(group.segments, title, 'pdf-' + (group.page ?? index), budget, labels));
    }
    return pages;
  }

  const chunks = splitGroup(segments, labels.documentTitle, 'document', budget, labels);
  return chunks.map((page, index) => {
    const heading = headingTitle(page.segments);
    const title = (heading ? heading + ' · ' : '') + labels.documentPage(index + 1);
    return {
      ...page,
      title,
      sectionTitle: heading || labels.documentPage(index + 1),
    };
  });
}
