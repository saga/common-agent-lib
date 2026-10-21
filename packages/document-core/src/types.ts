/**
 * Canonical document representation shared by document parsers, readers and
 * long-running document workflows. This module has no browser or Node runtime
 * dependencies.
 */

export type DocumentFormat =
  | 'txt'
  | 'md'
  | 'html'
  | 'srt'
  | 'vtt'
  | 'json'
  | 'pdf'
  | 'docx'
  | 'epub';

export type SegmentKind =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'caption'
  | 'code'
  | 'quote'
  | 'other';

export interface DocumentSegment {
  /** Stable source identity used to attach translations to the original segment. */
  id: string;
  /** Original order within the source document. */
  index: number;
  /** Trimmed source text. */
  text: string;
  kind: SegmentKind;
  /** EPUB spine path or DOCX part name, when available. */
  path?: string;
  /** Heading level 1-6. */
  level?: number;
  /** Original PDF list marker, not part of the translatable text. */
  marker?: string;
  /** One-based source PDF page where available. */
  page?: number;
  /** Chapter or section path used as context metadata. */
  contextPath?: string;
  /** Subtitle cue time range. */
  start?: string;
  end?: string;
}

export interface ParsedDocument {
  format: DocumentFormat;
  title: string;
  segments: DocumentSegment[];
  meta: {
    charCount: number;
    segmentCount: number;
    warnings: string[];
  };
}

/** Minimal parser input. Binary parsers receive an ArrayBuffer. */
export interface DocumentInput {
  fileName: string;
  mime?: string;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}
