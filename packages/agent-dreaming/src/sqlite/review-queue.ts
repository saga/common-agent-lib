import type {
  DreamingEvidence, DreamingProposal, DreamingRelationship,
  DreamingReviewQueue, DreamingReviewQueueItem,
} from '../types.js';
import type { SqliteDatabase } from './database.js';
import { decode, encode, type SqliteRow } from './database.js';
import type { SqliteMemoryStore } from './memories.js';

export type ProposalReviewReason =
  | 'mutation' | 'quality-gate' | 'conflict-risk'
  | 'missing-assessment' | 'missing-provenance';

export class SqliteReviewQueueStore implements DreamingReviewQueue {
  constructor(
    private readonly context: SqliteDatabase,
    private readonly memories: SqliteMemoryStore,
  ) {}

  async commitProposal(input: {
    proposal: DreamingProposal;
    evidence: readonly DreamingEvidence[];
    runId: string;
  }): Promise<{ applied: boolean; reason?: string }> {
    this.context.ensureOpen();
    const proposal = input.proposal;
    if (proposal.operation !== 'add' || !proposal.proposedRecord) {
      return { applied: false, reason: 'only-add-can-be-auto-committed' };
    }
    const invalid = this.validateProposal(proposal, input.evidence);
    if (invalid) return { applied: false, reason: invalid };
    const proposedRecord = proposal.proposedRecord;
    if (!proposedRecord) return { applied: false, reason: 'missing-proposed-record' };

    return this.context.transaction(() => {
      const old = this.context.db.prepare(
        'SELECT scope,payload FROM applied_proposals WHERE proposal_id=?'
      ).get(proposal.id) as SqliteRow | undefined;
      if (old) {
        if (old.scope !== proposal.scope) throw new Error('Proposal ID belongs to another scope: ' + proposal.id);
        if (old.payload && String(old.payload) !== encode(proposal)) {
          throw new Error('Conflicting applied proposal ID: ' + proposal.id);
        }
        return { applied: true };
      }

      const existing = this.context.db.prepare('SELECT scope FROM memories WHERE id=?')
        .get(proposedRecord.id) as SqliteRow | undefined;
      if (existing) {
        return {
          applied: false,
          reason: existing.scope === proposal.scope ? 'memory-id-exists' : 'memory-id-belongs-to-another-scope',
        };
      }
      this.context.insertMemory(proposedRecord, 'candidate');
      this.insertRelationships(proposal);
      this.context.db.prepare(
        'INSERT INTO applied_proposals(proposal_id,scope,applied_at,payload) VALUES(?,?,?,?)'
      ).run(proposal.id, proposal.scope, new Date().toISOString(), encode(proposal));
      return { applied: true };
    });
  }

  async stageProposal(input: {
    proposal: DreamingProposal;
    evidence: readonly DreamingEvidence[];
    runId: string;
    reason: ProposalReviewReason;
  }): Promise<{ staged: boolean; reason?: string }> {
    this.context.ensureOpen();
    const proposal = input.proposal;
    if (!proposal.id?.trim() || !proposal.scope?.trim()) {
      throw new TypeError('Proposal id and scope are required');
    }
    if (proposal.proposedRecord && proposal.proposedRecord.scope !== proposal.scope) {
      throw new Error('Proposed record scope does not match proposal scope');
    }
    return this.context.transaction(() => {
      const old = this.context.db.prepare('SELECT * FROM proposals WHERE proposal_id=?')
        .get(proposal.id) as SqliteRow | undefined;
      if (old) {
        const same = old.scope === proposal.scope
          && String(old.payload) === encode(proposal)
          && String(old.evidence) === encode(input.evidence)
          && old.reason === input.reason;
        if (!same) throw new Error('Conflicting proposal ID: ' + proposal.id);
        return { staged: old.status === 'pending' };
      }
      this.context.db.prepare(
        "INSERT INTO proposals(proposal_id,scope,run_id,reason,status,payload,evidence,created_at) VALUES(?,?,?,?,'pending',?,?,?)"
      ).run(
        proposal.id, proposal.scope, input.runId, input.reason,
        encode(proposal), encode(input.evidence), new Date().toISOString(),
      );
      return { staged: true };
    });
  }

  async listReviewQueue(input: {
    scope: string; status?: DreamingReviewQueueItem['status']; limit?: number;
  }): Promise<DreamingReviewQueueItem[]> {
    this.context.ensureOpen();
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const sql = 'SELECT * FROM proposals WHERE scope=? '
      + (input.status ? 'AND status=? ' : '')
      + 'ORDER BY created_at DESC LIMIT ?';
    const rows = (input.status
      ? this.context.db.prepare(sql).all(input.scope, input.status, limit)
      : this.context.db.prepare(sql).all(input.scope, limit)) as SqliteRow[];
    return rows.map((row) => ({
      proposal: decode<DreamingProposal>(row.payload),
      evidence: decode<DreamingEvidence[]>(row.evidence),
      runId: String(row.run_id),
      reason: String(row.reason),
      status: row.status,
      createdAt: String(row.created_at),
      ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
      ...(row.reviewed_by ? { reviewedBy: String(row.reviewed_by) } : {}),
    }));
  }

  async resolveReview(input: {
    scope: string; proposalId: string; decision: 'approve' | 'reject'; reviewedBy: string;
  }): Promise<DreamingReviewQueueItem['status']> {
    this.context.ensureOpen();
    if (!input.reviewedBy.trim()) throw new Error('reviewedBy is required');
    return this.context.transaction(() => {
      const row = this.context.db.prepare(
        'SELECT * FROM proposals WHERE proposal_id=? AND scope=?'
      ).get(input.proposalId, input.scope) as SqliteRow | undefined;
      if (!row) throw new Error('Review proposal not found');
      if (row.status !== 'pending') return row.status;

      const proposal = decode<DreamingProposal>(row.payload);
      const evidence = decode<DreamingEvidence[]>(row.evidence);
      if (input.decision === 'approve') {
        const invalid = this.validateProposal(proposal, evidence);
        if (invalid) throw new Error('Cannot approve proposal: ' + invalid);
        this.applyReviewed(proposal);
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      this.context.db.prepare(
        'UPDATE proposals SET status=?,reviewed_at=?,reviewed_by=? WHERE proposal_id=? AND scope=? AND status=?'
      ).run(status, new Date().toISOString(), input.reviewedBy, input.proposalId, input.scope, 'pending');
      return status;
    });
  }

  private validateProposal(
    proposal: DreamingProposal,
    evidence: readonly DreamingEvidence[],
  ): string | undefined {
    if (!proposal.id?.trim() || !proposal.scope?.trim()) return 'invalid-proposal-identity';
    if (new Set(proposal.targetRecordIds).size !== proposal.targetRecordIds.length) return 'duplicate-targets';
    if (proposal.operation === 'add' && proposal.targetRecordIds.length !== 0) return 'add-must-not-have-targets';
    if (proposal.operation === 'update' && proposal.targetRecordIds.length !== 1) return 'update-requires-one-target';
    if (proposal.operation === 'merge' && proposal.targetRecordIds.length < 2) return 'merge-requires-two-targets';
    if ((proposal.operation === 'supersede' || proposal.operation === 'archive')
      && proposal.targetRecordIds.length < 1) return 'operation-requires-targets';
    if (proposal.operation === 'archive' && proposal.proposedRecord) return 'archive-must-not-have-proposed-record';

    if (proposal.operation !== 'archive') {
      if (!proposal.proposedRecord) return 'missing-proposed-record';
      if (proposal.proposedRecord.scope !== proposal.scope) return 'proposed-record-scope-mismatch';
      if (!proposal.proposedRecord.id?.trim() || !proposal.proposedRecord.content?.trim()) return 'invalid-proposed-record';
      if (!proposal.proposedRecord.sourceRefs.length) return 'missing-provenance';
      if (proposal.proposedRecord.sourceRefs.some((ref) => !proposal.evidenceRefs.includes(ref))) {
        return 'unlisted-provenance';
      }
    }
    if (!proposal.evidenceRefs.length || new Set(proposal.evidenceRefs).size !== proposal.evidenceRefs.length) {
      return 'invalid-evidence-refs';
    }
    const resolvedRefs = new Set(evidence.map((item) => item.ref));
    if (proposal.evidenceRefs.some((ref) => !resolvedRefs.has(ref))) return 'unresolved-evidence';
    if (proposal.relationships?.some((relationship) =>
      relationship.scope !== proposal.scope
      || !relationship.id?.trim()
      || !relationship.fromId?.trim()
      || !relationship.toId?.trim()
      || relationship.fromId === relationship.toId
      || !relationship.sourceRefs.length
      || relationship.sourceRefs.some((ref) => !proposal.evidenceRefs.includes(ref))
    )) return 'invalid-relationship';
    return undefined;
  }

  private insertRelationships(proposal: DreamingProposal): void {
    for (const relationship of proposal.relationships ?? []) {
      const mapEndpoint = (id: string) =>
        proposal.operation === 'update' && id === proposal.proposedRecord?.id
          ? proposal.targetRecordIds[0]!
          : id;
      const fromId = mapEndpoint(relationship.fromId);
      const toId = mapEndpoint(relationship.toId);
      const exists = (id: string) => Boolean(this.context.db.prepare(
        'SELECT 1 FROM memories WHERE id=? AND scope=?'
      ).get(id, proposal.scope));
      if (!exists(fromId) || !exists(toId)) {
        throw new Error('Relationship endpoint missing or outside scope');
      }

      const old = this.context.db.prepare('SELECT * FROM relationships WHERE id=?')
        .get(relationship.id) as SqliteRow | undefined;
      if (old) {
        const same = old.scope === relationship.scope
          && old.from_id === fromId && old.to_id === toId
          && old.kind === relationship.kind
          && String(old.refs) === encode(relationship.sourceRefs);
        if (!same) throw new Error('Conflicting relationship ID: ' + relationship.id);
        continue;
      }
      this.context.db.prepare(
        'INSERT INTO relationships(id,scope,from_id,to_id,kind,refs) VALUES(?,?,?,?,?,?)'
      ).run(
        relationship.id, relationship.scope, fromId, toId,
        relationship.kind, encode(relationship.sourceRefs),
      );
    }
  }

  private applyReviewed(proposal: DreamingProposal): void {
    const targets = proposal.targetRecordIds.map((id) =>
      this.context.db.prepare('SELECT * FROM memories WHERE id=? AND scope=?')
        .get(id, proposal.scope) as SqliteRow | undefined
    );
    if (targets.some((target) => !target)) throw new Error('Review target missing or outside scope');

    const now = new Date().toISOString();
    if (proposal.operation === 'archive') {
      for (let index = 0; index < proposal.targetRecordIds.length; index += 1) {
        const target = targets[index]!;
        this.memories.recordVersionBeforeMutation(target, 'archive');
        this.context.db.prepare(
          "UPDATE memories SET status='archived',updated_at=? WHERE id=? AND scope=?"
        ).run(now, proposal.targetRecordIds[index], proposal.scope);
      }
      return;
    }

    if (proposal.operation === 'add' && proposal.proposedRecord) {
      const existing = this.context.db.prepare('SELECT scope FROM memories WHERE id=?')
        .get(proposal.proposedRecord.id) as SqliteRow | undefined;
      if (existing) throw new Error('Memory ID already exists: ' + proposal.proposedRecord.id);
      this.context.insertMemory(proposal.proposedRecord, 'confirmed');
      this.insertRelationships(proposal);
      return;
    }

    if (proposal.operation === 'update' && proposal.proposedRecord) {
      const target = targets[0]!;
      this.memories.recordVersionBeforeMutation(target, 'update');
      this.context.db.prepare(
        'UPDATE memories SET content=?,refs=?,importance=?,valid_until=?,confidence=?,metadata=?,last_validated_at=?,updated_at=? WHERE id=? AND scope=?'
      ).run(
        proposal.proposedRecord.content,
        encode(proposal.proposedRecord.sourceRefs),
        proposal.proposedRecord.importance,
        proposal.proposedRecord.validUntil ?? target.valid_until,
        proposal.proposedRecord.confidence ?? target.confidence,
        encode(proposal.proposedRecord.metadata ?? decode<Record<string, unknown>>(target.metadata)),
        now,
        now,
        proposal.targetRecordIds[0],
        proposal.scope,
      );
      this.insertRelationships(proposal);
      return;
    }

    if ((proposal.operation === 'merge' || proposal.operation === 'supersede') && proposal.proposedRecord) {
      const existing = this.context.db.prepare('SELECT scope FROM memories WHERE id=?')
        .get(proposal.proposedRecord.id) as SqliteRow | undefined;
      if (existing) throw new Error('Memory ID already exists: ' + proposal.proposedRecord.id);
      this.context.insertMemory(proposal.proposedRecord, 'confirmed');
      for (let index = 0; index < proposal.targetRecordIds.length; index += 1) {
        const target = targets[index]!;
        this.memories.recordVersionBeforeMutation(target, proposal.operation);
        this.context.db.prepare(
          "UPDATE memories SET status='superseded',updated_at=? WHERE id=? AND scope=?"
        ).run(now, proposal.targetRecordIds[index], proposal.scope);
      }
      this.insertRelationships(proposal);
      return;
    }
    throw new Error('Unsupported reviewed proposal');
  }
}
