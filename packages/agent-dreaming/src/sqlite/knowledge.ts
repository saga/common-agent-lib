import type {
  DreamingKnowledgeLink, DreamingKnowledgeLinkKind, DreamingKnowledgePage,
  DreamingKnowledgePageInput, DreamingKnowledgePageVersion,
  DreamingKnowledgeSearchHit, DreamingKnowledgeSearchRequest,
  DreamingKnowledgeProposal, DreamingKnowledgeProposalResult, DreamingEvidence,
} from '../types.js';
import type { SqliteDatabase } from './database.js';
import { decode, encode, mapKnowledgePage, type SqliteRow } from './database.js';

const LINK_KINDS: readonly DreamingKnowledgeLinkKind[] = [
  'related-to', 'supports', 'contradicts', 'derived-from', 'supersedes',
];

function assertLimit(limit: number, max = 200): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new TypeError(`limit must be an integer between 1 and ${max}`);
  }
  return limit;
}

function textTerms(query: string): string[] {
  const terms = query.normalize('NFKC').match(/[A-Za-z0-9_]+/gu) ?? [];
  return [...new Set(terms.map((term) => term.toLocaleLowerCase()))].slice(0, 12);
}

function cjkTerms(query: string): string[] {
  const runs = query.normalize('NFKC').match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu) ?? [];
  const terms = new Set<string>();
  for (const run of runs) {
    if ([...run].length === 1) terms.add(run);
    for (let i = 0; i < run.length - 1; i += 1) {
      terms.add(run.slice(i, i + 2));
      if (terms.size >= 12) return [...terms];
    }
  }
  return [...terms];
}

export class SqliteKnowledgeStore {
  constructor(private readonly context: SqliteDatabase) {}

  private validateEvidence(scope: string, refs: readonly string[], allowExpired = false): void {
    const uniqueRefs = [...new Set(refs)];
    if (!uniqueRefs.length || uniqueRefs.length !== refs.length || uniqueRefs.some((ref) => !ref.trim())) {
      throw new TypeError('Knowledge pages and links require unique, non-empty evidence references.');
    }
    if (uniqueRefs.length > 900) throw new TypeError('Knowledge provenance is limited to 900 references per operation.');
    const found = this.context.db.prepare(
      `SELECT ref,expires_at FROM evidence WHERE scope=? AND ref IN (${uniqueRefs.map(() => '?').join(',')})`
    ).all(scope, ...uniqueRefs) as SqliteRow[];
    const available = new Set(found.map((row) => String(row.ref)));
    const missing = uniqueRefs.filter((ref) => !available.has(ref));
    if (missing.length) throw new Error('Knowledge provenance is missing or outside scope: ' + missing.join(', '));
    if (!allowExpired) {
      const now = Date.now();
      const expired = found.filter((row) => row.expires_at && Date.parse(String(row.expires_at)) <= now)
        .map((row) => String(row.ref));
      if (expired.length) throw new Error('Knowledge provenance has expired Evidence: ' + expired.join(', '));
    }
  }

  /** Demote active pages whose immutable source Evidence has expired. */
  private demoteExpiredEvidencePages(scope: string, pageId?: string, limit = 500): number {
    const now = new Date().toISOString();
    const rows = this.context.db.prepare(
      `SELECT k.* FROM knowledge_pages k
       WHERE k.scope=? AND k.status='active' AND (? IS NULL OR k.id=?)
         AND EXISTS (
           SELECT 1 FROM json_each(k.refs) source
           JOIN evidence e ON e.ref=source.value AND e.scope=k.scope
           WHERE e.expires_at IS NOT NULL AND e.expires_at<=?
         )
       ORDER BY k.updated_at ASC,k.id LIMIT ?`
    ).all(scope, pageId ?? null, pageId ?? null, now, limit) as SqliteRow[];
    for (const row of rows) {
      const page = mapKnowledgePage(row);
      const expiredRows = this.context.db.prepare(
        `SELECT e.ref FROM json_each(?) source
         JOIN evidence e ON e.ref=source.value AND e.scope=?
         WHERE e.expires_at IS NOT NULL AND e.expires_at<=?
         ORDER BY e.ref`
      ).all(String(row.refs), scope, now) as SqliteRow[];
      const expiredEvidenceRefs = expiredRows.map((item) => String(item.ref));
      this.savePageInTransaction({
        id: page.id, scope: page.scope, title: page.title, summary: page.summary,
        content: page.content, status: 'draft', tags: page.tags, sourceRefs: page.sourceRefs,
        metadata: {
          ...(page.metadata ?? {}),
          evidenceExpiryRequiresReview: true,
          expiredEvidenceRefs,
          evidenceExpiryDetectedAt: now,
        },
        reason: 'source-evidence-expired: ' + expiredEvidenceRefs.join(', '),
      });
    }
    return rows.length;
  }

  async synchronizeExpiredEvidence(scope: string): Promise<number> {
    this.context.ensureOpen();
    if (!scope.trim()) throw new TypeError('scope is required.');
    return this.context.transaction(() => this.demoteExpiredEvidencePages(scope));
  }

  private validatePageInput(input: DreamingKnowledgePageInput): void {
    if (!input.id.trim() || !input.scope.trim() || !input.title.trim() || !input.summary.trim() || !input.content.trim()) {
      throw new TypeError('Knowledge page id, scope, title, summary and content are required.');
    }
    if (input.title.length > 500 || input.summary.length > 4_000 || input.content.length > 100_000) {
      throw new TypeError('Knowledge page exceeds its title, summary or content size limit.');
    }
    const status = input.status ?? 'active';
    if (!['active', 'draft', 'deprecated', 'superseded'].includes(status)) {
      throw new TypeError('Invalid Knowledge page status.');
    }
    if (input.tags?.some((tag) => !tag.trim() || tag.length > 100) || (input.tags?.length ?? 0) > 50) {
      throw new TypeError('Knowledge tags must be non-empty and at most 100 characters; maximum 50 tags.');
    }
  }

  async savePage(input: DreamingKnowledgePageInput): Promise<DreamingKnowledgePage> {
    this.context.ensureOpen();
    this.validatePageInput(input);
    return this.context.transaction(() => this.savePageInTransaction(input));
  }

  private savePageInTransaction(input: DreamingKnowledgePageInput): DreamingKnowledgePage {
    const old = this.context.db.prepare('SELECT * FROM knowledge_pages WHERE id=?')
      .get(input.id) as SqliteRow | undefined;
    if (old && old.scope !== input.scope) throw new Error('Knowledge page ID belongs to another scope: ' + input.id);
    const tags = [...new Set(input.tags ?? [])];
    const metadata = input.metadata ?? {};
    const status = input.status ?? 'active';
    this.validateEvidence(input.scope, input.sourceRefs, status !== 'active');
    const same = old
      && old.title === input.title.trim()
      && old.summary === input.summary.trim()
      && old.content === input.content.trim()
      && old.status === status
      && String(old.tags) === encode(tags)
      && String(old.refs) === encode(input.sourceRefs)
      && String(old.metadata) === encode(metadata);
    if (same) return mapKnowledgePage(old);

    const now = new Date().toISOString();
    let version = 1;
    let createdAt = now;
    if (old) {
      const previous = mapKnowledgePage(old);
      version = previous.version + 1;
      createdAt = previous.createdAt;
      this.context.db.prepare(
        'INSERT INTO knowledge_page_versions(scope,page_id,version,reason,captured_at,payload) VALUES(?,?,?,?,?,?)'
      ).run(input.scope, input.id, previous.version, input.reason?.trim() || 'revise', now, encode(previous));
      this.context.db.prepare(
        'UPDATE knowledge_pages SET title=?,summary=?,content=?,status=?,tags=?,refs=?,version=?,updated_at=?,metadata=?,last_reviewed_at=NULL WHERE id=? AND scope=?'
      ).run(input.title.trim(), input.summary.trim(), input.content.trim(), status,
        encode(tags), encode(input.sourceRefs), version, now, encode(metadata), input.id, input.scope);
    } else {
      this.context.db.prepare(
        'INSERT INTO knowledge_pages(id,scope,title,summary,content,status,tags,refs,version,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'
      ).run(input.id, input.scope, input.title.trim(), input.summary.trim(), input.content.trim(),
        status, encode(tags), encode(input.sourceRefs), version, createdAt, now, encode(metadata));
    }
    return mapKnowledgePage(
      this.context.db.prepare('SELECT * FROM knowledge_pages WHERE id=? AND scope=?')
        .get(input.id, input.scope) as SqliteRow,
    );
  }

  async getPage(input: { scope: string; pageId: string }): Promise<DreamingKnowledgePage | undefined> {
    this.context.ensureOpen();
    if (!input.scope.trim() || !input.pageId.trim()) throw new TypeError('scope and pageId are required.');
    this.context.transaction(() => this.demoteExpiredEvidencePages(input.scope, input.pageId, 1));
    const row = this.context.db.prepare('SELECT * FROM knowledge_pages WHERE id=? AND scope=?')
      .get(input.pageId, input.scope) as SqliteRow | undefined;
    return row ? mapKnowledgePage(row) : undefined;
  }

  async listPages(input: { scope: string; status?: DreamingKnowledgePage['status']; limit?: number }): Promise<DreamingKnowledgePage[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit ?? 100, 1_000);
    this.context.transaction(() => this.demoteExpiredEvidencePages(input.scope));
    const rows = input.status
      ? this.context.db.prepare('SELECT * FROM knowledge_pages WHERE scope=? AND status=? ORDER BY updated_at DESC LIMIT ?')
        .all(input.scope, input.status, limit) as SqliteRow[]
      : this.context.db.prepare('SELECT * FROM knowledge_pages WHERE scope=? ORDER BY updated_at DESC LIMIT ?')
        .all(input.scope, limit) as SqliteRow[];
    return rows.map(mapKnowledgePage);
  }

  async listPagesForMaintenance(input: { scope: string; reviewBefore: string; limit: number }): Promise<DreamingKnowledgePage[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit, 100);
    this.context.transaction(() => this.demoteExpiredEvidencePages(input.scope));
    if (!input.scope.trim() || !Number.isFinite(Date.parse(input.reviewBefore))) {
      throw new TypeError('Knowledge maintenance query requires a scope and valid reviewBefore timestamp.');
    }
    const rows = this.context.db.prepare(
      "SELECT * FROM knowledge_pages WHERE scope=? AND (" +
      "status='active' OR (status='draft' AND json_extract(metadata,'$.evidenceExpiryRequiresReview')=1 " +
      "AND (last_reviewed_at IS NULL OR last_reviewed_at<?))) " +
      "ORDER BY CASE WHEN status='draft' THEN -1 " +
      "WHEN EXISTS (SELECT 1 FROM knowledge_feedback f WHERE f.scope=knowledge_pages.scope " +
      "AND f.page_id=knowledge_pages.id AND f.page_version=knowledge_pages.version AND f.occurred_at>=? " +
      "AND f.outcome IN ('not-useful','contradicts','incorrect','outdated','rejected') " +
      "GROUP BY f.scope,f.page_id HAVING COUNT(*)>=2) THEN 0 " +
      "WHEN last_reviewed_at IS NULL OR last_reviewed_at<? OR updated_at>last_reviewed_at THEN 1 ELSE 2 END, " +
      "COALESCE(last_reviewed_at,updated_at) ASC,updated_at DESC LIMIT ?"
    ).all(input.scope, input.reviewBefore, input.reviewBefore, input.reviewBefore, limit) as SqliteRow[];
    return rows.map(mapKnowledgePage);
  }

  async markPagesReviewed(input: { scope: string; ids: readonly string[]; reviewedAt: string }): Promise<void> {
    this.context.ensureOpen();
    if (!input.scope.trim() || !Number.isFinite(Date.parse(input.reviewedAt))) {
      throw new TypeError('Knowledge review update requires a scope and valid timestamp.');
    }
    const ids = [...new Set(input.ids)];
    if (!ids.length) return;
    if (ids.length > 100) throw new TypeError('At most 100 Knowledge pages may be marked reviewed at once.');
    this.context.transaction(() => {
      const update = this.context.db.prepare(
        "UPDATE knowledge_pages SET last_reviewed_at=? WHERE scope=? AND id=? AND (status='active' OR (status='draft' AND json_extract(metadata,'$.evidenceExpiryRequiresReview')=1))"
      );
      for (const id of ids) update.run(input.reviewedAt, input.scope, id);
    });
  }

  async listPageVersions(input: { scope: string; pageId: string; limit?: number }): Promise<DreamingKnowledgePageVersion[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit ?? 50, 500);
    const rows = this.context.db.prepare(
      'SELECT * FROM knowledge_page_versions WHERE scope=? AND page_id=? ORDER BY version DESC LIMIT ?'
    ).all(input.scope, input.pageId, limit) as SqliteRow[];
    return rows.map((row) => ({
      scope: String(row.scope), pageId: String(row.page_id), version: Number(row.version),
      reason: String(row.reason), capturedAt: String(row.captured_at),
      snapshot: decode<DreamingKnowledgePage>(row.payload),
    }));
  }

  async appendLink(input: Omit<DreamingKnowledgeLink, 'createdAt'>): Promise<DreamingKnowledgeLink> {
    this.context.ensureOpen();
    if (!input.id.trim() || !input.scope.trim() || !input.fromId.trim() || !input.toId.trim()) {
      throw new TypeError('Knowledge link identity, scope and endpoints are required.');
    }
    if (input.fromId === input.toId) throw new Error('Knowledge self-links are not allowed.');
    if (!LINK_KINDS.includes(input.kind)) throw new TypeError('Unsupported Knowledge link kind.');
    return this.context.transaction(() => this.appendLinkInTransaction(input));
  }

  private appendLinkInTransaction(input: Omit<DreamingKnowledgeLink, 'createdAt'>): DreamingKnowledgeLink {
    const endpoints = this.context.db.prepare(
      'SELECT id FROM knowledge_pages WHERE scope=? AND id IN (?,?)'
    ).all(input.scope, input.fromId, input.toId) as SqliteRow[];
    if (new Set(endpoints.map((row) => String(row.id))).size !== 2) {
      throw new Error('Knowledge link endpoints must both exist in the same scope.');
    }
    this.validateEvidence(input.scope, input.sourceRefs);
    const old = this.context.db.prepare('SELECT * FROM knowledge_links WHERE id=?')
      .get(input.id) as SqliteRow | undefined;
    if (old) {
      const same = old.scope === input.scope && old.from_id === input.fromId
        && old.to_id === input.toId && old.kind === input.kind
        && String(old.refs) === encode(input.sourceRefs);
      if (!same) throw new Error('Conflicting Knowledge link ID: ' + input.id);
      return { ...input, createdAt: String(old.created_at) };
    }
    const createdAt = new Date().toISOString();
    this.context.db.prepare(
      'INSERT INTO knowledge_links(id,scope,from_id,to_id,kind,refs,created_at) VALUES(?,?,?,?,?,?,?)'
    ).run(input.id, input.scope, input.fromId, input.toId, input.kind, encode(input.sourceRefs), createdAt);
    return { ...input, createdAt };
  }

  async commitProposal(input: {
    proposal: DreamingKnowledgeProposal;
    evidence: readonly DreamingEvidence[];
    runId: string;
  }): Promise<DreamingKnowledgeProposalResult> {
    this.context.ensureOpen();
    const proposal = input.proposal;
    if (!proposal.id.trim() || !proposal.scope.trim() || !input.runId.trim()) {
      throw new TypeError('Knowledge proposal id, scope and runId are required.');
    }
    if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) {
      throw new TypeError('Knowledge proposal confidence must be between 0 and 1.');
    }
    if (!proposal.rationale.trim() || !proposal.evidenceRefs.length
      || new Set(proposal.evidenceRefs).size !== proposal.evidenceRefs.length
      || proposal.evidenceRefs.some((ref) => !ref.trim())) {
      throw new TypeError('Knowledge proposal requires a rationale and unique, non-empty evidenceRefs.');
    }
    const suppliedRefs = new Set(input.evidence.map((item) => item.ref));
    if (proposal.evidenceRefs.some((ref) => !suppliedRefs.has(ref))) {
      throw new Error('Knowledge proposal evidence payload is incomplete.');
    }
    if (proposal.proposedPage) {
      if (proposal.proposedPage.scope !== proposal.scope
        || !proposal.proposedPage.sourceRefs.length
        || proposal.proposedPage.sourceRefs.some((ref) => !proposal.evidenceRefs.includes(ref))) {
        throw new Error('Proposed Knowledge page scope or provenance is invalid.');
      }
      this.validatePageInput(proposal.proposedPage);
    }
    if (proposal.targetPageIds.some((id) => !id.trim())
      || new Set(proposal.targetPageIds).size !== proposal.targetPageIds.length) {
      throw new TypeError('Knowledge targetPageIds must be unique and non-empty.');
    }

    return this.context.transaction(() => {
      // Expired Evidence can support revalidation decisions, but not newly active content.
      this.validateEvidence(proposal.scope, proposal.evidenceRefs, true);
      const payload = encode(proposal);
      const existingProposal = this.context.db.prepare(
        'SELECT scope,payload FROM applied_knowledge_proposals WHERE proposal_id=?'
      ).get(proposal.id) as SqliteRow | undefined;
      if (existingProposal) {
        if (existingProposal.scope !== proposal.scope || existingProposal.payload !== payload) {
          throw new Error('Conflicting Knowledge proposal ID: ' + proposal.id);
        }
        return { applied: true, reason: 'already-applied' };
      }

      const targets = proposal.targetPageIds.map((pageId) => {
        const row = this.context.db.prepare(
          'SELECT * FROM knowledge_pages WHERE id=? AND scope=?'
        ).get(pageId, proposal.scope) as SqliteRow | undefined;
        if (!row) throw new Error('Knowledge proposal target is missing or outside scope: ' + pageId);
        return mapKnowledgePage(row);
      });
      const targetIds = new Set(proposal.targetPageIds);
      const highConfidence = proposal.confidence >= 0.82;
      const evidenceRefs = [...proposal.evidenceRefs];
      const canMaintainTarget = (page: DreamingKnowledgePage) =>
        page.status === 'active'
        || (page.status === 'draft' && page.metadata?.evidenceExpiryRequiresReview === true);

      const annotated = (
        page: DreamingKnowledgePageInput,
        status: DreamingKnowledgePageInput['status'],
        id?: string,
      ): DreamingKnowledgePageInput => ({
        ...page,
        ...(id ? { id } : {}),
        status,
        sourceRefs: [...new Set(page.sourceRefs)],
        metadata: {
          ...(page.metadata ?? {}),
          maintenanceProposalId: proposal.id,
          maintenanceRationale: proposal.rationale,
        },
        reason: proposal.rationale,
      });
      const changeStatus = (page: DreamingKnowledgePage, status: 'superseded' | 'deprecated') =>
        this.savePageInTransaction({
          id: page.id, scope: page.scope, title: page.title, summary: page.summary,
          content: page.content, status, tags: page.tags,
          sourceRefs: [...new Set([...page.sourceRefs, ...evidenceRefs])],
          metadata: { ...(page.metadata ?? {}), maintenanceProposalId: proposal.id, maintenanceRationale: proposal.rationale },
          reason: proposal.rationale,
        });
      const addDerivedLinks = (fromId: string, targetIds: readonly string[]) => {
        for (const [index, toId] of targetIds.entries()) {
          this.appendLinkInTransaction({
            id: `knowledge-link:${proposal.id}:derived:${index}`,
            scope: proposal.scope, fromId, toId, kind: 'derived-from', sourceRefs: evidenceRefs,
          });
        }
      };
      const insertProposalLedger = () => this.context.db.prepare(
        'INSERT INTO applied_knowledge_proposals(proposal_id,scope,run_id,applied_at,payload) VALUES(?,?,?,?,?)'
      ).run(proposal.id, proposal.scope, input.runId, new Date().toISOString(), payload);

      // Low-confidence proposals can add a draft, but cannot mutate the active graph.
      if (!highConfidence) {
        if (!proposal.proposedPage || !['create', 'revise', 'merge', 'supersede'].includes(proposal.operation)) {
          return { applied: false, reason: 'confidence-too-low' };
        }
        const draftId = proposal.operation === 'create'
          ? proposal.proposedPage.id : `knowledge-draft:${proposal.id}`;
        if (proposal.operation === 'create' && this.context.db.prepare(
          'SELECT 1 AS found FROM knowledge_pages WHERE id=?'
        ).get(draftId)) {
          throw new Error('Knowledge create page ID already exists: ' + draftId);
        }
        const draft = this.savePageInTransaction(annotated(proposal.proposedPage, 'draft', draftId));
        if (targets.length) addDerivedLinks(draft.id, targets.map((target) => target.id));
        insertProposalLedger();
        return { applied: true, reason: 'saved-as-draft' };
      }

      switch (proposal.operation) {
        case 'create': {
          if (!proposal.proposedPage || targets.length) throw new Error('Knowledge create proposal is malformed.');
          if (this.context.db.prepare('SELECT 1 AS found FROM knowledge_pages WHERE id=?')
            .get(proposal.proposedPage.id)) throw new Error('Knowledge create page ID already exists.');
          this.savePageInTransaction(annotated(proposal.proposedPage, 'active'));
          break;
        }
        case 'revise': {
          if (targets.length !== 1 || !proposal.proposedPage
            || proposal.proposedPage.id !== targets[0]?.id || !targets[0] || !canMaintainTarget(targets[0])) {
            throw new Error('Knowledge revise requires one active target and the same proposed page ID.');
          }
          this.savePageInTransaction(annotated(proposal.proposedPage, 'active'));
          break;
        }
        case 'merge': {
          if (targets.length < 2 || !proposal.proposedPage
            || targetIds.has(proposal.proposedPage.id) || targets.some((page) => !canMaintainTarget(page))) {
            throw new Error('Knowledge merge requires at least two active targets and a distinct output page.');
          }
          if (this.context.db.prepare('SELECT 1 AS found FROM knowledge_pages WHERE id=?')
            .get(proposal.proposedPage.id)) throw new Error('Knowledge merge output page ID already exists.');
          const merged = this.savePageInTransaction(annotated(proposal.proposedPage, 'active'));
          for (const [index, target] of targets.entries()) {
            changeStatus(target, 'superseded');
            this.appendLinkInTransaction({
              id: `knowledge-link:${proposal.id}:supersedes:${index}`,
              scope: proposal.scope, fromId: merged.id, toId: target.id,
              kind: 'supersedes', sourceRefs: evidenceRefs,
            });
          }
          break;
        }
        case 'link': {
          if (targets.length !== 2 || !proposal.link
            || !targetIds.has(proposal.link.fromId) || !targetIds.has(proposal.link.toId)
            || proposal.link.fromId === proposal.link.toId) {
            throw new Error('Knowledge link proposal requires two valid targets and endpoints.');
          }
          this.appendLinkInTransaction({
            id: `knowledge-link:${proposal.id}`, scope: proposal.scope,
            fromId: proposal.link.fromId, toId: proposal.link.toId,
            kind: proposal.link.kind, sourceRefs: evidenceRefs,
          });
          break;
        }
        case 'supersede': {
          if (!proposal.proposedPage || !targets.length
            || targetIds.has(proposal.proposedPage.id) || targets.some((page) => !canMaintainTarget(page))) {
            throw new Error('Knowledge supersede requires a replacement page and active targets.');
          }
          if (this.context.db.prepare('SELECT 1 AS found FROM knowledge_pages WHERE id=?')
            .get(proposal.proposedPage.id)) throw new Error('Knowledge replacement page ID already exists.');
          const replacement = this.savePageInTransaction(annotated(proposal.proposedPage, 'active'));
          for (const [index, target] of targets.entries()) {
            changeStatus(target, 'superseded');
            this.appendLinkInTransaction({
              id: `knowledge-link:${proposal.id}:supersedes:${index}`,
              scope: proposal.scope, fromId: replacement.id, toId: target.id,
              kind: 'supersedes', sourceRefs: evidenceRefs,
            });
          }
          break;
        }
        case 'deprecate': {
          if (!targets.length || targets.some((page) => !canMaintainTarget(page))) {
            throw new Error('Knowledge deprecate requires active target pages.');
          }
          for (const target of targets) changeStatus(target, 'deprecated');
          break;
        }
      }

      insertProposalLedger();
      return { applied: true };
    });
  }

  async listLinks(input: { scope: string; pageIds?: readonly string[]; limit?: number }): Promise<DreamingKnowledgeLink[]> {
    this.context.ensureOpen();
    const limit = assertLimit(input.limit ?? 200, 1_000);
    const pageIds = [...new Set(input.pageIds ?? [])];
    if (pageIds.length > 500) throw new TypeError('At most 500 pageIds may be queried at once.');
    const rows = pageIds.length
      ? this.context.db.prepare(
        `SELECT * FROM knowledge_links WHERE scope=? AND
         (from_id IN (${pageIds.map(() => '?').join(',')}) OR to_id IN (${pageIds.map(() => '?').join(',')}))
         ORDER BY created_at,id LIMIT ?`
      ).all(input.scope, ...pageIds, ...pageIds, limit) as SqliteRow[]
      : this.context.db.prepare('SELECT * FROM knowledge_links WHERE scope=? ORDER BY created_at,id LIMIT ?')
        .all(input.scope, limit) as SqliteRow[];
    return rows.map((row) => ({
      id: String(row.id), scope: String(row.scope), fromId: String(row.from_id), toId: String(row.to_id),
      kind: row.kind as DreamingKnowledgeLinkKind, sourceRefs: decode<string[]>(row.refs), createdAt: String(row.created_at),
    }));
  }

  async search(input: DreamingKnowledgeSearchRequest): Promise<DreamingKnowledgeSearchHit[]> {
    this.context.ensureOpen();
    if (!input.scope.trim() || !input.query.trim()) throw new TypeError('Knowledge search requires scope and query.');
    this.context.transaction(() => this.demoteExpiredEvidencePages(input.scope));
    if (input.query.length > 4_000) throw new TypeError('Knowledge query must not exceed 4000 characters.');
    const limit = assertLimit(input.limit ?? 10);
    const terms = textTerms(input.query);
    const cjk = cjkTerms(input.query);
    const statuses = input.includeInactive === true ? "('active','draft','deprecated','superseded')" : "('active')";
    const results = new Map<string, DreamingKnowledgeSearchHit>();

    if (terms.length) {
      const fts = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
      const rows = this.context.db.prepare(
        `SELECT k.*, bm25(knowledge_search) AS search_rank
         FROM knowledge_search JOIN knowledge_pages k
           ON k.id=knowledge_search.id AND k.scope=knowledge_search.scope
         WHERE knowledge_search.scope=? AND knowledge_search MATCH ?
           AND k.status IN ${statuses}
           AND NOT EXISTS (
             SELECT 1 FROM json_each(k.refs) source
             JOIN evidence e ON e.ref=source.value AND e.scope=k.scope
             WHERE e.expires_at IS NOT NULL AND e.expires_at<=?
           )
         ORDER BY bm25(knowledge_search),k.updated_at DESC LIMIT ?`
      ).all(input.scope, fts, new Date().toISOString(), limit) as SqliteRow[];
      for (const row of rows) {
        const rank = Number(row.search_rank);
        results.set(String(row.id), this.mapHit(row, 1 + Math.min(1, Math.abs(rank) * 10_000)));
      }
    }

    if (cjk.length) {
      const predicates = cjk.map(() => '(instr(title,?)>0 OR instr(summary,?)>0 OR instr(content,?)>0 OR instr(tags,?)>0)').join(' OR ');
      const score = cjk.map(() => '(CASE WHEN instr(title,?)>0 THEN 3 ELSE 0 END + CASE WHEN instr(summary,?)>0 THEN 2 ELSE 0 END + CASE WHEN instr(content,?)>0 THEN 1 ELSE 0 END + CASE WHEN instr(tags,?)>0 THEN 1 ELSE 0 END)').join(' + ');
      const params = cjk.flatMap((term) => [term,term,term,term]);
      const scores = cjk.flatMap((term) => [term,term,term,term]);
      const rows = this.context.db.prepare(
        `SELECT k.*,(${score}) AS matched_score FROM knowledge_pages k
         WHERE k.scope=? AND k.status IN ${statuses}
           AND NOT EXISTS (
             SELECT 1 FROM json_each(k.refs) source
             JOIN evidence e ON e.ref=source.value AND e.scope=k.scope
             WHERE e.expires_at IS NOT NULL AND e.expires_at<=?
           )
           AND (${predicates})
         ORDER BY matched_score DESC,k.updated_at DESC LIMIT ?`
      ).all(...scores, input.scope, new Date().toISOString(), ...params, limit) as SqliteRow[];
      for (const row of rows) {
        const hit = this.mapHit(row, Number(row.matched_score) / (cjk.length * 7));
        const old = results.get(hit.id);
        if (!old || old.score < hit.score) results.set(hit.id, hit);
      }
    }
    const direct = [...results.values()].sort((a,b) => b.score-a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0,limit);
    if (input.expandLinks !== true || !direct.length) return direct;

    const maxDepth = input.maxDepth ?? 1;
    const maxPages = input.maxPages ?? Math.min(30, Math.max(limit, 10));
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || maxDepth > 2) {
      throw new TypeError('maxDepth must be an integer between 0 and 2.');
    }
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50) {
      throw new TypeError('maxPages must be an integer between 1 and 50.');
    }
    if (maxDepth === 0) return direct.slice(0, maxPages);
    const expanded = new Map(direct.map((hit) => [hit.id, hit]));
    let frontier = direct.map((hit) => ({ id: hit.id, score: hit.score }));
    for (let depth = 1; depth <= maxDepth && expanded.size < maxPages && frontier.length; depth += 1) {
      const ids = [...new Set(frontier.map((item) => item.id))].slice(0, 50);
      const marks = ids.map(() => '?').join(',');
      const links = this.context.db.prepare(
        `SELECT * FROM knowledge_links WHERE scope=? AND
         (from_id IN (${marks}) OR to_id IN (${marks}))
         ORDER BY created_at,id LIMIT ?`
      ).all(input.scope, ...ids, ...ids, 200) as SqliteRow[];
      const scoreByNeighbor = new Map<string, { score: number; via: string }>();
      const frontierScores = new Map(frontier.map((item) => [item.id, item.score]));
      for (const link of links) {
        const kind = String(link.kind) as DreamingKnowledgeLinkKind;
        if (input.relationKinds?.length && !input.relationKinds.includes(kind)) continue;
        const from = String(link.from_id);
        const to = String(link.to_id);
        const parent = frontierScores.has(from) ? from : frontierScores.has(to) ? to : undefined;
        if (!parent) continue;
        const neighbor = parent === from ? to : from;
        if (expanded.has(neighbor)) continue;
        const score = (frontierScores.get(parent) ?? 0) * (kind === 'supports' ? 0.8 : 0.65);
        const previous = scoreByNeighbor.get(neighbor);
        if (!previous || previous.score < score) scoreByNeighbor.set(neighbor, { score, via: String(link.id) });
      }
      if (!scoreByNeighbor.size) break;
      const neighborIds = [...scoreByNeighbor.keys()].slice(0, maxPages - expanded.size);
      const placeholders = neighborIds.map(() => '?').join(',');
      const rows = this.context.db.prepare(
        `SELECT * FROM knowledge_pages WHERE scope=? AND status='active' AND id IN (${placeholders})
          AND NOT EXISTS (
            SELECT 1 FROM json_each(knowledge_pages.refs) source
            JOIN evidence e ON e.ref=source.value AND e.scope=knowledge_pages.scope
            WHERE e.expires_at IS NOT NULL AND e.expires_at<=?
          )`
      ).all(input.scope, ...neighborIds, new Date().toISOString()) as SqliteRow[];
      const next: Array<{ id: string; score: number }> = [];
      for (const row of rows) {
        const id = String(row.id);
        const related = scoreByNeighbor.get(id);
        if (!related) continue;
        const hit = this.mapHit(row, related.score);
        expanded.set(id, { ...hit, relationDepth: depth, relatedVia: related.via });
        next.push({ id, score: related.score });
      }
      frontier = next;
    }
    return [...expanded.values()]
      .sort((a, b) => (a.relationDepth ?? 0) - (b.relationDepth ?? 0) || b.score - a.score)
      .slice(0, maxPages);
  }

  private mapHit(row: SqliteRow, score: number): DreamingKnowledgeSearchHit {
    return {
      id: String(row.id), scope: String(row.scope), title: String(row.title),
      summary: String(row.summary), content: String(row.content), score,
      status: row.status as DreamingKnowledgePage['status'],
      tags: decode<string[]>(row.tags), sourceRefs: decode<string[]>(row.refs),
      version: Number(row.version), updatedAt: String(row.updated_at),
      metadata: decode<Record<string, unknown>>(row.metadata),
    };
  }
}
