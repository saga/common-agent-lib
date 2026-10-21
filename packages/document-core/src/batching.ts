import type { DocumentSegment } from './types.js';

export interface BatchBudget {
  /** Maximum source characters in a batch; measured in UTF-16 code units. */
  maxChars: number;
  /** Maximum segments in one batch. */
  maxSegments: number;
  /** Split when section path or PDF page changes. */
  splitOnContextChange?: boolean;
}

export const DEFAULT_BUDGET: BatchBudget = {
  maxChars: 3000,
  maxSegments: 24,
  splitOnContextChange: false,
};

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(name + ' must be a positive safe integer.');
  }
}

/**
 * Greedy, stable-order batching. A single segment larger than maxChars is kept
 * as one batch rather than split in the middle of a sentence or identifier.
 */
export function buildSegmentBatches(
  segments: readonly DocumentSegment[],
  budget: Partial<BatchBudget> = {},
): DocumentSegment[][] {
  const resolved = { ...DEFAULT_BUDGET, ...budget };
  positiveInteger('maxChars', resolved.maxChars);
  positiveInteger('maxSegments', resolved.maxSegments);

  const batches: DocumentSegment[][] = [];
  let current: DocumentSegment[] = [];
  let chars = 0;

  for (const segment of segments) {
    const size = segment.text.length;
    const first = current[0];
    const overChars = current.length > 0 && chars + size > resolved.maxChars;
    const overCount = current.length >= resolved.maxSegments;
    const currentGroup = first
      ? (first.contextPath || '') + '|page:' + (first.page ?? '')
      : '';
    const nextGroup = (segment.contextPath || '') + '|page:' + (segment.page ?? '');
    const overContext = current.length > 0 &&
      resolved.splitOnContextChange === true &&
      currentGroup !== nextGroup;

    if (overChars || overCount || overContext) {
      batches.push(current);
      current = [];
      chars = 0;
    }

    current.push(segment);
    chars += size;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

export function estimateChars(segments: readonly Pick<DocumentSegment, 'text'>[]): number {
  return segments.reduce((total, segment) => total + segment.text.length, 0);
}
