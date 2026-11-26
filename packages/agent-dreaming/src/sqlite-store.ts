import type {
  DreamingCheckpoint, DreamingEvidence, DreamingEvidenceResolver, DreamingExperience,
  DreamingFeedbackEvent, DreamingMemory, DreamingMemoryHistoryStore, DreamingPage,
  DreamingProposal, DreamingRelationship, DreamingRepository, DreamingRun, DreamingRunStore,
  DreamingReviewQueue, DreamingReviewQueueItem,
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

  recordFeedback(event: DreamingFeedbackEvent): Promise<void> {
    return this.feedback.recordFeedback(event);
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
