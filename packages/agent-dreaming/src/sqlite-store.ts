import type {
  DreamingCheckpoint, DreamingContextRequest, DreamingContextResult, DreamingEvidence, DreamingEvidenceResolver, DreamingExperience,
  DreamingContextFeedbackInput, DreamingKnowledgeContextFeedbackInput, DreamingKnowledgeFeedbackEvent, DreamingFeedbackEvent, DreamingKnowledgeLink, DreamingKnowledgePage, DreamingKnowledgePageInput, DreamingKnowledgePageVersion, DreamingKnowledgeSearchHit, DreamingKnowledgeSearchRequest, DreamingKnowledgeProposal, DreamingKnowledgeProposalResult, DreamingMemory, DreamingMemoryManifest, DreamingMemoryHistoryStore, DreamingPage,
  DreamingProposal, DreamingRelationship, DreamingRepository, DreamingRun, DreamingRunStore,
  DreamingReviewQueue, DreamingReviewQueueItem, DreamingSearchHit, DreamingSearchRequest, DreamingUserDirectiveInput,
} from './types.js';
import { SqliteDatabase, type SqliteDreamingOptions } from './sqlite/database.js';
import { SqliteExperienceStore } from './sqlite/experiences.js';
import { SqliteMemoryStore } from './sqlite/memories.js';
import { SqliteEvidenceStore } from './sqlite/evidence.js';
import { SqliteFeedbackStore } from './sqlite/feedback.js';
import { SqliteLeaseStore } from './sqlite/leases.js';
import { SqliteReviewQueueStore, type ProposalReviewReason } from './sqlite/review-queue.js';
import { SqliteVectorIndex, type EmbeddingProvider } from './retrieval.js';
import { TransformersJsEmbeddingProvider } from './embedding.js';
import { SqliteDreamingScheduler, type DurableSchedulerOptions } from './scheduler.js';
import { SqliteUserDirectiveStore } from './sqlite/directives.js';
import { SqliteSearchStore } from './sqlite/search.js';
import { SqliteContextStore } from './sqlite/context.js';
import { SqliteKnowledgeStore } from './sqlite/knowledge.js';
import { SqliteKnowledgeFeedbackStore } from './sqlite/knowledge-feedback.js';
import { SqliteMemoryManifestStore } from './sqlite/manifest.js';

export type { SqliteDreamingOptions, ProposalReviewReason };
export type SqliteDreamingStoreOptions = SqliteDreamingOptions & { embeddingProvider?: EmbeddingProvider | false };
export type { DreamingReviewQueueItem as ReviewQueueItem } from './types.js';
export type AppendExperienceInput = Omit<DreamingExperience, 'sequence'> & { sequence?: number };

/**
 * SQLite implementation of the repository, evidence resolver, review queue,
 * run ledger and memory history contracts. Feature logic lives in focused modules.
 */
export class SqliteDreamingStore implements
  DreamingRepository,
  DreamingEvidenceResolver,
  DreamingReviewQueue,
  DreamingRunStore,
  DreamingMemoryHistoryStore {
  private readonly database: SqliteDatabase;
  private readonly experiences: SqliteExperienceStore;
  private readonly memories: SqliteMemoryStore;
  private readonly evidence: SqliteEvidenceStore;
  private readonly feedback: SqliteFeedbackStore;
  private readonly leases: SqliteLeaseStore;
  private readonly reviews: SqliteReviewQueueStore;
  private readonly directives: SqliteUserDirectiveStore;
  private readonly searchStore: SqliteSearchStore;
  private readonly contextStore: SqliteContextStore;
  private readonly knowledgeStore: SqliteKnowledgeStore;
  private readonly knowledgeFeedbackStore: SqliteKnowledgeFeedbackStore;
  private readonly manifestStore: SqliteMemoryManifestStore;

  constructor(options: SqliteDreamingStoreOptions) {
    this.database = new SqliteDatabase(options);
    this.experiences = new SqliteExperienceStore(this.database);
    const vectorIndex = options.embeddingProvider === false ? undefined
      : new SqliteVectorIndex(this.database.db, options.embeddingProvider ?? new TransformersJsEmbeddingProvider());
    this.memories = new SqliteMemoryStore(this.database, vectorIndex);
    this.evidence = new SqliteEvidenceStore(this.database);
    this.feedback = new SqliteFeedbackStore(this.database);
    this.leases = new SqliteLeaseStore(this.database);
    this.reviews = new SqliteReviewQueueStore(this.database, this.memories);
    this.directives = new SqliteUserDirectiveStore(this.database, this.memories);
    this.searchStore = new SqliteSearchStore(this.database);
    this.contextStore = new SqliteContextStore(this.database);
    this.knowledgeStore = new SqliteKnowledgeStore(this.database);
    this.knowledgeFeedbackStore = new SqliteKnowledgeFeedbackStore(this.database);
    this.manifestStore = new SqliteMemoryManifestStore(this.database);
  }

  appendExperience(input: AppendExperienceInput): Promise<DreamingExperience> {
    return this.experiences.appendExperience(input);
  }
  loadExperiences(input: {
    scope: string; afterSequence: number; reviewBefore?: string; limit: number;
  }): Promise<DreamingPage<DreamingExperience>> {
    return this.experiences.loadExperiences(input);
  }
  markExperiencesReviewed(input: {
    scope: string; ids: readonly string[]; reviewedAt: string;
  }): Promise<void> {
    return this.experiences.markExperiencesReviewed(input);
  }
  loadCheckpoint(scope: string): Promise<DreamingCheckpoint> {
    return this.experiences.loadCheckpoint(scope);
  }
  saveCheckpoint(checkpoint: DreamingCheckpoint): Promise<void> {
    return this.experiences.saveCheckpoint(checkpoint);
  }
  createRun(run: DreamingRun): Promise<void> {
    return this.experiences.createRun(run);
  }
  updateRun(run: DreamingRun): Promise<void> {
    return this.experiences.updateRun(run);
  }
  getRun(input: { scope: string; runId: string }): Promise<DreamingRun | undefined> {
    return this.experiences.getRun(input);
  }
  listRuns(input: {
    scope: string; status?: DreamingRun['status']; limit?: number; before?: string;
  }): Promise<DreamingRun[]> {
    return this.experiences.listRuns(input);
  }

  upsertMemory(memory: DreamingMemory): Promise<void> {
    return this.memories.upsertMemory(memory);
  }
  loadMemories(input: {
    scope: string; experienceIds: readonly string[]; reviewBefore?: string;
    expiredBefore?: string; limit: number;
  }): Promise<readonly DreamingMemory[]> {
    return this.memories.loadMemories(input);
  }
  appendRelationship(relationship: DreamingRelationship): Promise<void> {
    return this.memories.appendRelationship(relationship);
  }
  loadRelationships(input: {
    scope: string; memoryIds: readonly string[]; limit: number;
  }): Promise<readonly DreamingRelationship[]> {
    return this.memories.loadRelationships(input);
  }
  markMemoriesReviewed(input: {
    scope: string; ids: readonly string[]; reviewedAt: string;
  }): Promise<void> {
    return this.memories.markMemoriesReviewed(input);
  }
  listMemories(scope: string, limit = 200): Promise<DreamingMemory[]> {
    return this.memories.listMemories(scope, limit);
  }
  listMemoryVersions(input: {
    scope: string; memoryId: string; limit?: number;
  }) {
    return this.memories.listMemoryVersions(input);
  }

  putEvidence(scope: string, item: DreamingEvidence): Promise<void> {
    return this.evidence.putEvidence(scope, item);
  }
  resolve(input: { scope: string; refs: readonly string[] }): Promise<readonly DreamingEvidence[]> {
    return this.evidence.resolve(input);
  }

  saveKnowledgePage(input: DreamingKnowledgePageInput): Promise<DreamingKnowledgePage> {
    return this.knowledgeStore.savePage(input);
  }

  getKnowledgePage(input: { scope: string; pageId: string }): Promise<DreamingKnowledgePage | undefined> {
    return this.knowledgeStore.getPage(input);
  }

  listKnowledgePages(input: { scope: string; status?: DreamingKnowledgePage['status']; limit?: number }): Promise<DreamingKnowledgePage[]> {
    return this.knowledgeStore.listPages(input);
  }

  listKnowledgePagesForMaintenance(input: { scope: string; reviewBefore: string; limit: number }): Promise<DreamingKnowledgePage[]> {
    return this.knowledgeStore.listPagesForMaintenance(input);
  }

  markKnowledgePagesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void> {
    return this.knowledgeStore.markPagesReviewed(input);
  }

  listKnowledgePageVersions(input: { scope: string; pageId: string; limit?: number }): Promise<DreamingKnowledgePageVersion[]> {
    return this.knowledgeStore.listPageVersions(input);
  }

  appendKnowledgeLink(input: Omit<DreamingKnowledgeLink, 'createdAt'>): Promise<DreamingKnowledgeLink> {
    return this.knowledgeStore.appendLink(input);
  }

  listKnowledgeLinks(input: { scope: string; pageIds?: readonly string[]; limit?: number }): Promise<DreamingKnowledgeLink[]> {
    return this.knowledgeStore.listLinks(input);
  }

  searchKnowledge(input: DreamingKnowledgeSearchRequest): Promise<DreamingKnowledgeSearchHit[]> {
    return this.knowledgeStore.search(input);
  }

  commitKnowledgeProposal(input: {
    proposal: DreamingKnowledgeProposal;
    evidence: readonly DreamingEvidence[];
    runId: string;
  }): Promise<DreamingKnowledgeProposalResult> {
    return this.knowledgeStore.commitProposal(input);
  }

  async recordKnowledgeContextFeedback(input: DreamingKnowledgeContextFeedbackInput): Promise<void> {
    if (!input.id.trim() || !input.taskId.trim() || !input.context.id.trim() || !input.context.hash.trim()) {
      throw new TypeError('Knowledge context feedback requires IDs and a context hash.');
    }
    const item = input.context.items.find((candidate) =>
      candidate.id === input.pageId && candidate.sourceType === 'knowledge');
    if (!item || !item.knowledgeVersion) {
      throw new Error('The Knowledge page was not included in the supplied Context Builder result.');
    }
    await this.knowledgeFeedbackStore.record({
      id: input.id,
      scope: input.context.scope,
      pageId: item.id,
      pageVersion: item.knowledgeVersion,
      kind: 'retrieval',
      outcome: input.outcome,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      taskId: input.taskId,
      contextId: input.context.id,
      contextHash: input.context.hash,
    });
  }

  recordKnowledgeFeedback(event: DreamingKnowledgeFeedbackEvent): Promise<void> {
    return this.knowledgeFeedbackStore.record(event);
  }

  loadKnowledgeFeedback(input: {
    scope: string;
    pageIds: readonly string[];
    since: string;
    limit: number;
  }): Promise<readonly DreamingKnowledgeFeedbackEvent[]> {
    return this.knowledgeFeedbackStore.load(input);
  }

  search(input: DreamingSearchRequest): Promise<DreamingSearchHit[]> {
    return this.searchStore.search(input);
  }

  async buildContext(input: DreamingContextRequest): Promise<DreamingContextResult> {
    const [context, persistentManifest] = await Promise.all([
      this.contextStore.build(input),
      this.manifestStore.get(input.scope),
    ]);
    return { ...context, persistentManifest };
  }

  getMemoryManifest(scope: string): Promise<DreamingMemoryManifest> {
    return this.manifestStore.get(scope);
  }

  rebuildMemoryManifest(scope: string): Promise<DreamingMemoryManifest> {
    return this.manifestStore.rebuild(scope);
  }

  applyUserDirective(input: DreamingUserDirectiveInput): Promise<DreamingMemory> {
    return this.directives.applyUserDirective(input);
  }

  recordFeedback(event: DreamingFeedbackEvent): Promise<void> {
    return this.feedback.recordFeedback(event);
  }

  async recordContextFeedback(input: DreamingContextFeedbackInput): Promise<void> {
    if (!input.context.scope.trim() || !input.context.id.trim() || !input.context.hash.trim()) {
      throw new TypeError('A completed Context Builder result is required.');
    }
    if (input.context.id !== `context:${input.context.hash.slice(0, 24)}`) {
      throw new Error('Context ID does not match its content hash.');
    }
    if (!input.taskId.trim()) throw new TypeError('taskId is required.');
    const item = input.context.items.find((candidate) =>
      candidate.id === input.memoryId
      && (candidate.sourceType === 'memory' || candidate.sourceType === 'always-on-memory'));
    if (!item) {
      throw new Error('Feedback can only be recorded for a memory included in the supplied context.');
    }
    if (!item.revision) throw new Error('The included memory has no revision identifier.');

    await this.recordFeedback({
      id: input.id,
      scope: input.context.scope,
      memoryId: item.id,
      kind: 'retrieval',
      outcome: input.outcome,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      taskId: input.taskId,
      contextId: input.context.id,
      contextHash: input.context.hash,
      memoryRevision: item.revision,
    });
  }
  loadFeedback(input: {
    scope: string; memoryIds: readonly string[]; since: string; limit: number;
  }): Promise<readonly DreamingFeedbackEvent[]> {
    return this.feedback.loadFeedback(input);
  }

  acquireLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean> {
    return this.leases.acquireLease(input);
  }
  renewLease(input: { scope: string; owner: string; leaseMs: number }): Promise<boolean> {
    return this.leases.renewLease(input);
  }
  releaseLease(input: { scope: string; owner: string }): Promise<void> {
    return this.leases.releaseLease(input);
  }

  commitProposal(input: {
    proposal: DreamingProposal; evidence: readonly DreamingEvidence[]; runId: string;
  }): Promise<{ applied: boolean; reason?: string }> {
    return this.reviews.commitProposal(input);
  }
  stageProposal(input: {
    proposal: DreamingProposal; evidence: readonly DreamingEvidence[]; runId: string;
    reason: ProposalReviewReason;
  }): Promise<{ staged: boolean; reason?: string }> {
    return this.reviews.stageProposal(input);
  }
  listReviewQueue(input: {
    scope: string; status?: DreamingReviewQueueItem['status']; limit?: number;
  }): Promise<DreamingReviewQueueItem[]> {
    return this.reviews.listReviewQueue(input);
  }
  resolveReview(input: {
    scope: string; proposalId: string; decision: 'approve' | 'reject'; reviewedBy: string;
  }): Promise<DreamingReviewQueueItem['status']> {
    return this.reviews.resolveReview(input);
  }

  createVectorIndex(provider: EmbeddingProvider): SqliteVectorIndex {
    this.database.ensureOpen();
    return new SqliteVectorIndex(this.database.db, provider);
  }

  createScheduler(options: DurableSchedulerOptions = {}): SqliteDreamingScheduler {
    this.database.ensureOpen();
    return new SqliteDreamingScheduler(this.database.db, options);
  }

  async close(): Promise<void> {
    this.database.close();
  }
}
