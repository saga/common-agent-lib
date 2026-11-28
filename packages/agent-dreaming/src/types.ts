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


export type DreamingKnowledgeStatus = 'active' | 'draft' | 'deprecated' | 'superseded';
export type DreamingKnowledgeLinkKind =
  | 'related-to' | 'supports' | 'contradicts' | 'derived-from' | 'supersedes';

/** A reusable topic page backed by immutable source evidence. */
export interface DreamingKnowledgePage {
  id: string;
  scope: string;
  title: string;
  summary: string;
  content: string;
  status: DreamingKnowledgeStatus;
  tags: readonly string[];
  sourceRefs: readonly string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  lastReviewedAt?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DreamingKnowledgePageInput {
  id: string;
  scope: string;
  title: string;
  summary: string;
  content: string;
  status?: DreamingKnowledgeStatus;
  tags?: readonly string[];
  sourceRefs: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
  reason?: string;
}

export interface DreamingKnowledgeProposal {
  id: string;
  scope: string;
  operation: 'create' | 'revise' | 'merge' | 'link' | 'supersede' | 'deprecate';
  targetPageIds: string[];
  proposedPage?: DreamingKnowledgePageInput;
  link?: { fromId: string; toId: string; kind: DreamingKnowledgeLinkKind };
  rationale: string;
  evidenceRefs: string[];
  confidence: number;
}

export interface DreamingKnowledgeProposalResult {
  applied: boolean;
  reason?: string;
}

export interface DreamingKnowledgeLink {
  id: string;
  scope: string;
  fromId: string;
  toId: string;
  kind: DreamingKnowledgeLinkKind;
  sourceRefs: readonly string[];
  createdAt: string;
}

export interface DreamingKnowledgePageVersion {
  scope: string;
  pageId: string;
  version: number;
  reason: string;
  capturedAt: string;
  snapshot: DreamingKnowledgePage;
}

export interface DreamingKnowledgeSearchRequest {
  scope: string;
  query: string;
  limit?: number;
  includeInactive?: boolean;
  /** Expand direct hits through the scope-local Knowledge graph. Disabled by default. */
  expandLinks?: boolean;
  /** Maximum graph traversal depth (0-2). */
  maxDepth?: number;
  /** Hard cap for direct + expanded pages (1-50). */
  maxPages?: number;
  relationKinds?: readonly DreamingKnowledgeLinkKind[];
}

export interface DreamingKnowledgeSearchHit {
  id: string;
  scope: string;
  title: string;
  summary: string;
  content: string;
  score: number;
  status: DreamingKnowledgeStatus;
  tags: readonly string[];
  sourceRefs: readonly string[];
  version: number;
  updatedAt: string;
  metadata?: Readonly<Record<string, unknown>>;
  /** 0 for a direct hit, otherwise the bounded graph traversal depth. */
  relationDepth?: number;
  relatedVia?: string;
}

export interface DreamingMemoryManifest {
  scope: string;
  version: number;
  hash: string;
  /** Compact JSON index for explicit Memory, important Memory and active Knowledge. */
  content: string;
  itemIds: readonly string[];
  stale: boolean;
  truncated: boolean;
  builtAt: string;
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

/** A scope-bound historical transcript / trace returned by a host adapter. */
export interface DreamingHistoryRecord {
  id: string;
  scope: string;
  content: string;
  createdAt: string;
  /** Must resolve to source Evidence already owned by this scope in the package. */
  sourceRefs: readonly string[];
  origin?: DreamingOrigin;
}

/**
 * The host authenticates and authorizes access to its history system.
 * The package still validates scope, references, ranking and context budgets.
 */
export interface DreamingHistorySourceAdapter {
  search(input: {
    scope: string;
    query: string;
    task: string;
    limit: number;
  }): Promise<readonly DreamingHistoryRecord[]>;
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
  sourceType: 'always-on-memory' | 'knowledge' | 'history' | DreamingSearchSourceType;
  text: string;
  score: number;
  required: boolean;
  sourceRefs: readonly string[];
  revision?: string;
  authority?: DreamingMemoryAuthority;
  memoryType?: DreamingMemoryType;
  origin?: DreamingOrigin;
  knowledgeVersion?: number;
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
  /** Persisted scope-wide index; task-specific manifest remains in manifest. */
  persistentManifest?: DreamingMemoryManifest;
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

export interface DreamingKnowledgeFeedbackEvent {
  id: string;
  scope: string;
  pageId: string;
  pageVersion: number;
  kind: DreamingFeedbackKind;
  outcome: DreamingFeedbackOutcome;
  occurredAt: string;
  taskId?: string;
  contextId?: string;
  contextHash?: string;
  sourceRef?: string;
}

export interface DreamingKnowledgeContextFeedbackInput {
  id: string;
  context: Pick<DreamingContextResult, 'id' | 'scope' | 'hash' | 'items'>;
  pageId: string;
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
  knowledgeProposals?: DreamingKnowledgeProposal[];
  reviewedKnowledgePageIds?: string[];
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
  reviewedKnowledgePageIds?: string[];
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
  /** Cheap count used only to coalesce record-appended triggers before model invocation. */
  countUnprocessedExperiences?(scope: string): Promise<number>;
  loadMemories(input: { scope: string; experienceIds: readonly string[]; reviewBefore?: string; expiredBefore?: string; limit: number }): Promise<readonly DreamingMemory[]>;
  loadRelationships(input: { scope: string; memoryIds: readonly string[]; limit: number }): Promise<readonly DreamingRelationship[]>;
  loadCheckpoint(scope: string): Promise<DreamingCheckpoint>;
  markExperiencesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  markMemoriesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  saveCheckpoint(checkpoint: DreamingCheckpoint): Promise<void>;
  createRun(run: DreamingRun): Promise<void>;
  updateRun(run: DreamingRun): Promise<void>;
  commitProposal(input: { proposal: DreamingProposal; evidence: readonly DreamingEvidence[]; runId: string }): Promise<{ applied: boolean; reason?: string }>;
  listKnowledgePages?(input: { scope: string; status?: DreamingKnowledgeStatus; limit?: number }): Promise<DreamingKnowledgePage[]>;
  listKnowledgePagesForMaintenance?(input: { scope: string; reviewBefore: string; limit: number }): Promise<DreamingKnowledgePage[]>;
  markKnowledgePagesReviewed?(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void>;
  recordKnowledgeFeedback?(event: DreamingKnowledgeFeedbackEvent): Promise<void>;
  loadKnowledgeFeedback?(input: { scope: string; pageIds: readonly string[]; since: string; limit: number }): Promise<readonly DreamingKnowledgeFeedbackEvent[]>;
  listKnowledgeLinks?(input: { scope: string; pageIds?: readonly string[]; limit?: number }): Promise<DreamingKnowledgeLink[]>;
  commitKnowledgeProposal?(input: { proposal: DreamingKnowledgeProposal; evidence: readonly DreamingEvidence[]; runId: string }): Promise<DreamingKnowledgeProposalResult>;
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
  /** Number of active Knowledge pages supplied to one Dreaming batch (1-100). */
  maxKnowledgePages?: number;
  /** Minimum new Experience records before record-appended invokes the model (default 2). */
  minNewExperiencesToTrigger?: number;
  /** Re-review active Knowledge pages after this interval; defaults to 90 days. */
  knowledgeReviewIntervalMs?: number;
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
