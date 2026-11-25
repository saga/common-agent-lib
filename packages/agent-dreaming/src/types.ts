export type DreamingRunStatus = 'running' | 'completed' | 'failed' | 'skipped';
export type DreamingTrigger = 'startup' | 'interval' | 'record-appended' | 'manual';

export interface DreamingExperience {
  id: string;
  sequence: number;
  scope: string;
  content: string;
  createdAt: string;
  sourceRefs: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DreamingMemory {
  id: string;
  scope: string;
  content: string;
  status: 'candidate' | 'confirmed' | 'superseded' | 'archived';
  importance: number;
  sourceRefs: readonly string[];
  lastValidatedAt?: string;
  validUntil?: string;
  confidence?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DreamingRelationship {
  id: string;
  scope: string;
  fromId: string;
  toId: string;
  kind: string;
  sourceRefs: readonly string[];
}

export interface DreamingEvidence {
  ref: string;
  content: string;
  kind: string;
  createdAt?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DreamingQualityAssessment {
  /** Model estimate for triage only; never a trust or promotion signal. */
  confidence: number;
  durability: number;
  specificity: number;
  contradictionRisk: number;
}

export type DreamingFeedbackKind = 'retrieval' | 'evidence' | 'user-correction' | 'human-review';
export type DreamingFeedbackOutcome =
  | 'useful' | 'not-useful' | 'neutral'
  | 'supports' | 'contradicts'
  | 'incorrect' | 'outdated' | 'not-applicable'
  | 'confirmed' | 'rejected' | 'edited';

/** Immutable, host-authenticated feedback about one memory. */
export interface DreamingFeedbackEvent {
  id: string;
  scope: string;
  memoryId: string;
  kind: DreamingFeedbackKind;
  outcome: DreamingFeedbackOutcome;
  occurredAt: string;
  sourceRef?: string;
  taskId?: string;
}

export interface DreamingReviewEffectiveness {
  reviewedAt: string;
  baselineSampleCount: number;
  followUpSampleCount: number;
  baselineUsefulness: number;
  followUpUsefulness: number;
  delta: number;
  trend: 'improving' | 'declining' | 'stable';
}

export interface DreamingMemoryQuality {
  memoryId: string;
  evaluatedAt: string;
  windowStart: string;
  sampleCount: number;
  effectiveSampleCount: number;
  usefulness?: number;
  evidenceSupport?: number;
  correctionCount: number;
  humanRejectionCount: number;
  reviewEffectiveness?: DreamingReviewEffectiveness;
  recommendation: 'none' | 'review';
  reasons: string[];
}

export interface DreamingProposal {
  id: string;
  scope: string;
  operation: 'add' | 'update' | 'merge' | 'supersede' | 'archive';
  targetRecordIds: string[];
  proposedRecord?: DreamingMemory;
  rationale: string;
  evidenceRefs: string[];
  /** Existing memories the model believes are contradicted by this proposal. */
  conflictsWith?: string[];
  relationships?: DreamingRelationship[];
  quality?: DreamingQualityAssessment;
}

export interface DreamingModelResult {
  proposals: DreamingProposal[];
  processedRecordIds: string[];
  /** Existing memories actually checked against current evidence. */
  reviewedMemoryIds: string[];
  notes?: string[];
}

export interface DreamingRuntimeRequest {
  task: 'memory-dreaming';
  system: string;
  prompt: string;
  responseFormat: 'json';
  signal?: AbortSignal;
}

export interface DreamingRuntimeResponse {
  output: unknown;
  model?: string;
  usage?: Readonly<Record<string, number>>;
}

/** Implement this small adapter with Copilot SDK, CodeBuddy SDK, pi.dev, etc. */
export interface DreamingRuntime {
  readonly id: string;
  generate(request: DreamingRuntimeRequest): Promise<DreamingRuntimeResponse>;
}

export interface DreamingCheckpoint {
  scope: string;
  afterSequence: number;
  lastRunAt?: string;
  lastRunId?: string;
}

export interface DreamingRun {
  id: string;
  scope: string;
  status: DreamingRunStatus;
  trigger: DreamingTrigger;
  startedAt: string;
  finishedAt?: string;
  fromSequence: number;
  toSequence: number;
  processedRecordIds: string[];
  appliedProposalIds: string[];
  rejectedProposalIds: string[];
  pendingProposalIds: string[];
  reviewedMemoryIds: string[];
  error?: string;
  runtimeId: string;
  model?: string;
  usage?: Readonly<Record<string, number>>;
}

export interface DreamingPage<T> {
  items: T[];
  hasMore: boolean;
}

/** A durable snapshot captured before a memory is changed or archived. */
export interface DreamingMemoryVersion {
  scope: string;
  memoryId: string;
  version: number;
  reason: string;
  capturedAt: string;
  snapshot: DreamingMemory;
}

export interface DreamingMemoryHistoryStore {
  listMemoryVersions(input: {
    scope: string;
    memoryId: string;
    limit?: number;
  }): Promise<DreamingMemoryVersion[]>;
}

/** Queryable run ledger for operational dashboards and recovery tooling. */
export interface DreamingRunStore {
  getRun(input: { scope: string; runId: string }): Promise<DreamingRun | undefined>;
  listRuns(input: {
    scope: string;
    status?: DreamingRunStatus;
    limit?: number;
    before?: string;
  }): Promise<DreamingRun[]>;
}

export interface DreamingRepository {
  /** Return new records and records due for re-review, ordered by sequence ascending. */
  loadExperiences(input: {
    scope: string;
    afterSequence: number;
    reviewBefore?: string;
    limit: number;
  }): Promise<DreamingPage<DreamingExperience>>;
  /** Return the most relevant memories for this batch, bounded by limit. */
  /** Include relevant memories plus those due for periodic or expiry review. */
  loadMemories(input: {
    scope: string;
    experienceIds: readonly string[];
    reviewBefore?: string;
    expiredBefore?: string;
    limit: number;
  }): Promise<readonly DreamingMemory[]>;
  loadRelationships(input: { scope: string; memoryIds: readonly string[]; limit: number }): Promise<readonly DreamingRelationship[]>;
  loadCheckpoint(scope: string): Promise<DreamingCheckpoint>;
  /** Persist review timestamps so the same old experience is not selected on every tick. */
  markExperiencesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  markMemoriesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  saveCheckpoint(checkpoint: DreamingCheckpoint): Promise<void>;
  createRun(run: DreamingRun): Promise<void>;
  updateRun(run: DreamingRun): Promise<void>;
  /**
   * Must resolve scope/evidence/targets, enforce host policy and atomically apply
   * the proposal. proposal.id must be an idempotency key.
   */
  commitProposal(input: {
    proposal: DreamingProposal;
    evidence: readonly DreamingEvidence[];
    runId: string;
  }): Promise<{ applied: boolean; reason?: string }>;
  /** Persist non-automatic proposals in a durable review queue; idempotent by proposal.id. */
  stageProposal(input: {
    proposal: DreamingProposal;
    evidence: readonly DreamingEvidence[];
    runId: string;
    reason: 'mutation' | 'quality-gate' | 'conflict-risk' | 'missing-assessment' | 'missing-provenance';
  }): Promise<{ staged: boolean; reason?: string }>;
  /** Store immutable, idempotent feedback events. The host validates actor authorization and memory ownership. */
  recordFeedback(event: DreamingFeedbackEvent): Promise<void>;
  /** Load bounded feedback for selected memories within the requested time window. */
  loadFeedback(input: {
    scope: string;
    memoryIds: readonly string[];
    since: string;
    limit: number;
  }): Promise<readonly DreamingFeedbackEvent[]>;
  /** Distributed lease: only one worker may dream a scope at a time. */
  acquireLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean>;
  renewLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean>;
  releaseLease(input: { scope: string; owner: string }): Promise<void>;
}

export interface DreamingEvidenceResolver {
  resolve(input: {
    scope: string;
    refs: readonly string[];
  }): Promise<readonly DreamingEvidence[]>;
}

export interface DreamingReviewQueueItem {
  proposal: DreamingProposal;
  evidence: DreamingEvidence[];
  runId: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

/** Durable review operations. The host must authorize the reviewer before resolving a proposal. */
export interface DreamingReviewQueue {
  listReviewQueue(input: {
    scope: string;
    status?: DreamingReviewQueueItem['status'];
    limit?: number;
  }): Promise<DreamingReviewQueueItem[]>;
  resolveReview(input: {
    scope: string;
    proposalId: string;
    decision: 'approve' | 'reject';
    reviewedBy: string;
  }): Promise<DreamingReviewQueueItem['status']>;
}

export interface DreamingOptions {
  scopes: readonly string[];
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerRun?: number;
  maxMemories?: number;
  maxRelationships?: number;
  maxEvidenceItems?: number;
  maxPromptChars?: number;
  leaseMs?: number;
  reviewIntervalMs?: number;
  /** Re-review memories that have not been validated recently. Defaults to 30 days. */
  memoryReviewIntervalMs?: number;
  autoCandidateThresholds?: Partial<DreamingQualityAssessment>;
  /** Called after each persisted run; suitable for logs/metrics. */
  onRun?: (run: Readonly<DreamingRun>) => void | Promise<void>;
  onError?: (error: unknown, scope: string) => void | Promise<void>;
}

export interface DreamingRunInput {
  scope: string;
  trigger?: DreamingTrigger;
  signal?: AbortSignal;
}
