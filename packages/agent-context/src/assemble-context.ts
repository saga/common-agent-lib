export type ContextMetadataValue = string | number | boolean | null;

/** Stable pointer back to the data source from which a context item was derived. */
export interface ContextSourceRef {
  id: string;
  kind?: string;
  label?: string;
  uri?: string;
  revision?: string;
}

/**
 * A piece of context already selected and authorized by the host application.
 * The assembler treats text as opaque data: it does not retrieve, authorize,
 * fact-check, rewrite or promote the certainty of an item.
 */
export interface ContextItem {
  id: string;
  text: string;
  /** Larger values win when optional items compete for budget. Defaults to 0. */
  priority?: number;
  /** Required items are retained even when they cause the output to exceed budget. */
  required?: boolean;
  /** Explicit cross-source deduplication key. First-class IDs must still be unique. */
  dedupeKey?: string;
  /** Broad origin label, e.g. recent-memory, long-term-memory, knowledge, task or evidence. */
  sourceType?: 'instruction' | 'task' | 'recent-memory' | 'long-term-memory' | 'knowledge' | 'evidence' | 'document' | 'other';
  /** Host-calibrated confidence; carried through, never interpreted by the assembler. */
  confidence?: number;
  /** Freshness metadata is descriptive; host retrieval decides eligibility and priority. */
  lastValidatedAt?: string;
  validUntil?: string;
  /** Provenance is carried through to the result; it is not automatically rendered. */
  sources?: readonly ContextSourceRef[];
  metadata?: Readonly<Record<string, ContextMetadataValue>>;
}
