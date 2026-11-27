export type DreamingRunStatus = 'running' | 'completed' | 'failed' | 'skipped';
export type DreamingTrigger = 'startup' | 'interval' | 'record-appended' | 'manual';

export type DreamingMemoryType =
  | 'fact' | 'preference' | 'goal' | 'constraint'
  | 'knowledge' | 'behavior-pattern' | 'ongoing-context';

/** Explicit user instructions outrank all model-derived memories. */
export type DreamingMemoryAuthority = 'derived' | 'user-explicit';

export type DreamingUserDirectiveKind = 'remember' | 'avoid';

export interface DreamingUserDirectiveInput {
  id: string;
  scope: string;
  kind: DreamingUserDirectiveKind;
  instruction: string;
  occurredAt?: string;
  origin?: DreamingOrigin;
  memoryType?: DreamingMemoryType;
}

export interface DreamingUserMessageInput {
  id: string;
  scope: string;
  text: string;
  occurredAt?: string;
  origin?: DreamingOrigin;
}

export interface ParsedDreamingUserDirective {
  kind: DreamingUserDirectiveKind;
  instruction: string;
  memoryType: DreamingMemoryType;
}

/** Provenance for an experience or evidence item; never an isolation boundary. */
export interface DreamingOrigin {
  system: string;
  application?: string;
  channel?: string;
  recordId?: string;
}

export interface DreamingExperience {
  id: string;
  sequence: number;
  scope: string;
  content: string;
  createdAt: string;
  sourceRefs: readonly string[];
  origin?: DreamingOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DreamingMemory {
  id: string;
  scope: string;
  content: string;
  memoryType?: DreamingMemoryType;
  authority?: DreamingMemoryAuthority;
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
  origin?: DreamingOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}

export type DreamingSearchSourceType = 'memory' | 'experience' | 'evidence';

export interface DreamingSearchHit {
  id: string;
  scope: string;
  sourceType: DreamingSearchSourceType;
  content: string;
  score: number;
  sourceRefs: readonly string[];
  createdAt?: string;
  revision?: string;
  kind?: string;
  memoryType?: DreamingMemoryType;
  authority?: DreamingMemoryAuthority;
  status?: DreamingMemory['status'];
  importance?: number;
  confidence?: number;
  origin?: DreamingOrigin;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DreamingSearchRequest {
  scope: string;
  query: string;
  limit?: number;
  sourceTypes?: readonly DreamingSearchSourceType[];
  includeCandidates?: boolean;
}

/** Budget is measured against the complete rendered context, including headers. */
export interface DreamingContextBudget {
  maxUnits: number;
  unit?: 'characters' | 'tokens';
  /** Keep this much capacity unused for the live task and runtime instructions. */
  reservedUnits?: number;
  maxItems?: number;
}

export interface DreamingContextRequest {
  scope: string;
  task: string;
  query?: string;
  budget: DreamingContextBudget;
  /** Maximum durable memories in the always-on index. Explicit memories are prioritized. */
  alwaysOnLimit?: number;
  maxSearchResults?: number;
  maxEvidence?: number;
  maxItemChars?: number;
  includeEvidence?: boolean;
  /** Optional tokenizer for exact model-specific token budgets. */
  measure?: (text: string) => number;
}

export interface DreamingContextItem {
  id: string;
  sourceType: 'always-on-memory' | DreamingSearchSourceType;
  text: string;
  score: number;
  required: boolean;
  sourceRefs: readonly string[];
  revision?: string;
  authority?: DreamingMemoryAuthority;
  memoryType?: DreamingMemoryType;
  origin?: DreamingOrigin;
}

export interface DreamingContextOmission {
  id: string;
  sourceType: DreamingContextItem['sourceType'];
  reason: 'duplicate' | 'budget-exceeded' | 'max-items';
}

export interface DreamingContextResult {
  id: string;
  scope: string;
  task: string;
  text: string;
  items: readonly DreamingContextItem[];
  omittedItems: readonly DreamingContextOmission[];
  manifest: {
    text: string;
    itemIds: readonly string[];
    hash: string;
    truncated: boolean;
  };
  budget: {
    maxUnits: number;
    reservedUnits: number;
    availableUnits: number;
    usedUnits: number;
    overflowUnits: number;
    unit: 'characters' | 'tokens';
    estimated: boolean;
    exceeded: boolean;
  };
  hash: string;
  createdAt: string;
}

export interface DreamingQualityAssessment {
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

export interface DreamingFeedbackEvent {
  id: string;
  scope: string;
  memoryId: string;
  kind: DreamingFeedbackKind;
  outcome: DreamingFeedbackOutcome;
  occurredAt: string;
  sourceRef?: string;
  taskId?: string;
  /** Exact Context Builder result that supplied this memory to a task. */
  contextId?: string;
  contextHash?: string;
  /** Revision timestamp captured in DreamingContextItem.revision. */
  memoryRevision?: string;
}

export interface DreamingContextFeedbackInput {
  /** Stable idempotency key from the host task / feedback event. */
  id: string;
  context: Pick<DreamingContextResult, 'id' | 'scope' | 'hash' | 'items'>;
  memoryId: string;
  taskId: string;
  outcome: 'useful' | 'not-useful' | 'neutral';
  occurredAt?: string;
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
  conflictsWith?: string[];
  relationships?: DreamingRelationship[];
  quality?: DreamingQualityAssessment;
}

export interface DreamingModelResult {
  proposals: DreamingProposal[];
  processedRecordIds: string[];
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

export interface DreamingMemoryVersion {
  scope: string;
  memoryId: string;
  version: number;
  reason: string;
  capturedAt: string;
  snapshot: DreamingMemory;
}

export interface DreamingMemoryHistoryStore {
  listMemoryVersions(input: { scope: string; memoryId: string; limit?: number }): Promise<DreamingMemoryVersion[]>;
}

export interface DreamingRunStore {
  getRun(input: { scope: string; runId: string }): Promise<DreamingRun | undefined>;
  listRuns(input: { scope: string; status?: DreamingRunStatus; limit?: number; before?: string }): Promise<DreamingRun[]>;
}

export interface DreamingRepository {
  loadExperiences(input: { scope: string; afterSequence: number; reviewBefore?: string; limit: number }): Promise<DreamingPage<DreamingExperience>>;
  loadMemories(input: { scope: string; experienceIds: readonly string[]; reviewBefore?: string; expiredBefore?: string; limit: number }): Promise<readonly DreamingMemory[]>;
  loadRelationships(input: { scope: string; memoryIds: readonly string[]; limit: number }): Promise<readonly DreamingRelationship[]>;
  loadCheckpoint(scope: string): Promise<DreamingCheckpoint>;
  markExperiencesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  markMemoriesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  saveCheckpoint(checkpoint: DreamingCheckpoint): Promise<void>;
  createRun(run: DreamingRun): Promise<void>;
  updateRun(run: DreamingRun): Promise<void>;
  commitProposal(input: { proposal: DreamingProposal; evidence: readonly DreamingEvidence[]; runId: string }): Promise<{ applied: boolean; reason?: string }>;
  applyUserDirective?(input: DreamingUserDirectiveInput): Promise<DreamingMemory>;
  stageProposal(input: { proposal: DreamingProposal; evidence: readonly DreamingEvidence[]; runId: string; reason: 'mutation' | 'quality-gate' | 'conflict-risk' | 'missing-assessment' | 'missing-provenance' }): Promise<{ staged: boolean; reason?: string }>;
  recordFeedback(event: DreamingFeedbackEvent): Promise<void>;
  loadFeedback(input: { scope: string; memoryIds: readonly string[]; since: string; limit: number }): Promise<readonly DreamingFeedbackEvent[]>;
  acquireLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean>;
  renewLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean>;
  releaseLease(input: { scope: string; owner: string }): Promise<void>;
}

export interface DreamingEvidenceResolver {
  resolve(input: { scope: string; refs: readonly string[] }): Promise<readonly DreamingEvidence[]>;
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

export interface DreamingReviewQueue {
  listReviewQueue(input: { scope: string; status?: DreamingReviewQueueItem['status']; limit?: number }): Promise<DreamingReviewQueueItem[]>;
  resolveReview(input: { scope: string; proposalId: string; decision: 'approve' | 'reject'; reviewedBy: string }): Promise<DreamingReviewQueueItem['status']>;
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
  memoryReviewIntervalMs?: number;
  autoCandidateThresholds?: Partial<DreamingQualityAssessment>;
  onRun?: (run: Readonly<DreamingRun>) => void | Promise<void>;
  onError?: (error: unknown, scope: string) => void | Promise<void>;
}

export interface DreamingRunInput {
  scope: string;
  trigger?: DreamingTrigger;
  signal?: AbortSignal;
}
