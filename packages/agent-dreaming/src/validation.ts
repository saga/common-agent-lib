import type {
  DreamingModelResult, DreamingProposal, DreamingQualityAssessment,
  DreamingOptions, DreamingRelationship, DreamingMemoryType, DreamingKnowledgeProposal,
  DreamingKnowledgePageInput, DreamingKnowledgeLinkKind,
} from './types.js';

export function parseResult(value: unknown, scope: string): DreamingModelResult {
  if (!isObject(value)) throw new Error('Dreaming runtime returned a non-object result.');
  if (!Array.isArray(value.proposals)) throw new Error('Dreaming result proposals must be an array.');
  if (value.proposals.length > 100) throw new Error('Dreaming result exceeds the proposal limit.');
  const proposals = value.proposals.map((item) => parseProposal(item, scope));
  const processedRecordIds = stringArray(value.processedRecordIds, 'processedRecordIds');
  const reviewedMemoryIds = stringArray(value.reviewedMemoryIds ?? [], 'reviewedMemoryIds');
  const knowledgeProposals = value.knowledgeProposals === undefined
    ? []
    : parseKnowledgeProposals(value.knowledgeProposals, scope);
  const notes = value.notes === undefined ? [] : stringArray(value.notes, 'notes');
  return { proposals, processedRecordIds, reviewedMemoryIds, knowledgeProposals, notes };
}

function parseProposal(value: unknown, scope: string): DreamingProposal {
  if (!isObject(value)) throw new Error('Invalid dreaming proposal.');
  const operation = value.operation;
  if (!['add', 'update', 'merge', 'supersede', 'archive'].includes(String(operation))) {
    throw new Error('Invalid dreaming proposal operation.');
  }
  const proposal: DreamingProposal = {
    id: requiredString(value.id, 'proposal.id'),
    scope: requiredString(value.scope, 'proposal.scope'),
    operation: operation as DreamingProposal['operation'],
    targetRecordIds: stringArray(value.targetRecordIds ?? [], 'targetRecordIds'),
    rationale: requiredString(value.rationale, 'proposal.rationale'),
    evidenceRefs: stringArray(value.evidenceRefs, 'evidenceRefs'),
    ...(value.conflictsWith === undefined ? {} : { conflictsWith: stringArray(value.conflictsWith, 'conflictsWith') }),
    ...(value.relationships === undefined ? {} : { relationships: parseRelationships(value.relationships, scope) }),
    ...(value.quality === undefined ? {} : { quality: parseQuality(value.quality) }),
  };
  if (value.proposedRecord !== undefined) {
    if (!isObject(value.proposedRecord)) throw new Error('proposedRecord must be an object.');
    const record = value.proposedRecord;
    const memoryType = record.memoryType === undefined ? undefined : parseMemoryType(record.memoryType);
    proposal.proposedRecord = {
      id: requiredString(record.id, 'proposedRecord.id'),
      scope: requiredString(record.scope, 'proposedRecord.scope'),
      content: boundedString(record.content, 'proposedRecord.content', 4_000),
      ...(memoryType ? { memoryType } : {}),
      status: record.status === 'confirmed' || record.status === 'superseded' ? record.status : 'candidate',
      importance: typeof record.importance === 'number' ? Math.max(0, Math.min(1, record.importance)) : 0.5,
      sourceRefs: stringArray(record.sourceRefs ?? [], 'proposedRecord.sourceRefs'),
    };
  }
  if (proposal.scope !== scope) throw new Error('Proposal scope does not match the active scope.');
  if (proposal.operation === 'add' && !proposal.proposedRecord) throw new Error('add proposal requires proposedRecord.');
  if (['update', 'merge', 'supersede'].includes(proposal.operation) && !proposal.proposedRecord) {
    throw new Error(`${proposal.operation} proposal requires proposedRecord.`);
  }
  if (proposal.operation === 'merge' && proposal.targetRecordIds.length < 2) {
    throw new Error('merge proposal requires at least two targets.');
  }
  if (proposal.operation !== 'add' && proposal.targetRecordIds.length === 0) {
    throw new Error('non-add proposal requires targets.');
  }
  if (proposal.proposedRecord && proposal.proposedRecord.status !== 'candidate') {
    proposal.proposedRecord.status = 'candidate';
  }
  if (proposal.proposedRecord && proposal.proposedRecord.scope !== scope) {
    throw new Error('Proposed record scope does not match the active scope.');
  }
  return proposal;
}

function parseKnowledgeProposals(value: unknown, scope: string): DreamingKnowledgeProposal[] {
  if (!Array.isArray(value) || value.length > 30) {
    throw new Error('knowledgeProposals must be an array containing at most 30 proposals.');
  }
  return value.map((item): DreamingKnowledgeProposal => {
    if (!isObject(item)) throw new Error('Invalid Knowledge proposal.');
    const allowed = ['create', 'revise', 'merge', 'link', 'supersede', 'deprecate'] as const;
    if (typeof item.operation !== 'string' || !allowed.includes(item.operation as typeof allowed[number])) {
      throw new Error('Invalid Knowledge proposal operation.');
    }
    const operation = item.operation as DreamingKnowledgeProposal['operation'];
    const targetPageIds = stringArray(item.targetPageIds ?? [], 'targetPageIds');
    const evidenceRefs = stringArray(item.evidenceRefs, 'knowledgeProposal.evidenceRefs');
    if (!evidenceRefs.length || evidenceRefs.some((ref) => !ref.trim())) {
      throw new Error('Knowledge proposals require non-empty evidenceRefs.');
    }
    if (typeof item.confidence !== 'number' || !Number.isFinite(item.confidence)
      || item.confidence < 0 || item.confidence > 1) {
      throw new Error('Knowledge proposal confidence must be between 0 and 1.');
    }
    const proposal: DreamingKnowledgeProposal = {
      id: requiredString(item.id, 'knowledgeProposal.id'),
      scope: requiredString(item.scope, 'knowledgeProposal.scope'),
      operation,
      targetPageIds,
      rationale: requiredString(item.rationale, 'knowledgeProposal.rationale'),
      evidenceRefs,
      confidence: item.confidence,
    };
    if (proposal.scope !== scope) throw new Error('Knowledge proposal scope does not match the active scope.');
    if (item.proposedPage !== undefined) {
      if (!isObject(item.proposedPage)) throw new Error('proposedPage must be an object.');
      const page = item.proposedPage;
      const tags = page.tags === undefined ? [] : stringArray(page.tags, 'proposedPage.tags');
      const sourceRefs = stringArray(page.sourceRefs, 'proposedPage.sourceRefs');
      const status = page.status ?? 'active';
      if (!['active', 'draft', 'deprecated', 'superseded'].includes(String(status))) {
        throw new Error('Invalid proposed Knowledge page status.');
      }
      if (page.metadata !== undefined && !isObject(page.metadata)) throw new Error('proposedPage.metadata must be an object.');
      const parsedPage: DreamingKnowledgePageInput = {
        id: requiredString(page.id, 'proposedPage.id'),
        scope: requiredString(page.scope, 'proposedPage.scope'),
        title: boundedString(page.title, 'proposedPage.title', 500),
        summary: boundedString(page.summary, 'proposedPage.summary', 4_000),
        content: boundedString(page.content, 'proposedPage.content', 100_000),
        status: status as DreamingKnowledgePageInput['status'],
        tags,
        sourceRefs,
        ...(page.metadata ? { metadata: page.metadata as Record<string, unknown> } : {}),
        reason: proposal.rationale,
      };
      if (parsedPage.scope !== scope) throw new Error('Proposed Knowledge page scope does not match the active scope.');
      if (!sourceRefs.length || sourceRefs.some((ref) => !evidenceRefs.includes(ref))) {
        throw new Error('Proposed Knowledge page provenance must be included in evidenceRefs.');
      }
      proposal.proposedPage = parsedPage;
    }
    if (item.link !== undefined) {
      if (!isObject(item.link)) throw new Error('Knowledge link must be an object.');
      const kind = item.link.kind;
      if (typeof kind !== 'string'
        || !(['related-to', 'supports', 'contradicts', 'derived-from', 'supersedes'] as string[]).includes(kind)) {
        throw new Error('Invalid Knowledge link kind.');
      }
      proposal.link = {
        fromId: requiredString(item.link.fromId, 'link.fromId'),
        toId: requiredString(item.link.toId, 'link.toId'),
        kind: kind as DreamingKnowledgeLinkKind,
      };
    }
    if (operation === 'create' && (targetPageIds.length || !proposal.proposedPage)) {
      throw new Error('Knowledge create requires a page and no targets.');
    }
    if (operation === 'revise' && (targetPageIds.length !== 1 || !proposal.proposedPage
      || proposal.proposedPage.id !== targetPageIds[0])) {
      throw new Error('Knowledge revise requires one target and a proposed page with the same ID.');
    }
    if (operation === 'merge' && (targetPageIds.length < 2 || !proposal.proposedPage
      || targetPageIds.includes(proposal.proposedPage.id))) {
      throw new Error('Knowledge merge requires at least two targets and a distinct output page.');
    }
    if (operation === 'link' && (targetPageIds.length !== 2 || !proposal.link
      || !targetPageIds.includes(proposal.link.fromId) || !targetPageIds.includes(proposal.link.toId)
      || proposal.link.fromId === proposal.link.toId)) {
      throw new Error('Knowledge link requires two targets and matching link endpoints.');
    }
    if (operation === 'supersede' && (!targetPageIds.length || !proposal.proposedPage
      || targetPageIds.includes(proposal.proposedPage.id))) {
      throw new Error('Knowledge supersede requires active targets and a distinct replacement page.');
    }
    if (operation === 'deprecate' && !targetPageIds.length) {
      throw new Error('Knowledge deprecate requires at least one target.');
    }
    return proposal;
  });
}

function parseMemoryType(value: unknown): DreamingMemoryType {
  const allowed: readonly DreamingMemoryType[] = [
    'fact', 'preference', 'goal', 'constraint', 'knowledge', 'behavior-pattern', 'ongoing-context',
  ];
  if (typeof value !== 'string' || !allowed.includes(value as DreamingMemoryType)) {
    throw new Error('proposedRecord.memoryType must be a supported memory type.');
  }
  return value as DreamingMemoryType;
}

function parseQuality(value: unknown): DreamingQualityAssessment {
  if (!isObject(value)) throw new Error('quality must be an object.');
  const score = (field: keyof DreamingQualityAssessment): number => {
    const item = value[field];
    if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1) {
      throw new Error(`quality.${field} must be a number between 0 and 1.`);
    }
    return item;
  };
  return {
    confidence: score('confidence'),
    durability: score('durability'),
    specificity: score('specificity'),
    contradictionRisk: score('contradictionRisk'),
  };
}

export function classifyProposal(
  proposal: DreamingProposal,
  configured: DreamingOptions['autoCandidateThresholds'],
): { autoCandidate: boolean; reason: 'mutation' | 'quality-gate' | 'conflict-risk' | 'missing-assessment' | 'missing-provenance' } {
  if (proposal.operation !== 'add') return { autoCandidate: false, reason: 'mutation' };
  if (proposal.conflictsWith?.length) return { autoCandidate: false, reason: 'conflict-risk' };
  if (!proposal.proposedRecord?.sourceRefs.length) return { autoCandidate: false, reason: 'missing-provenance' };
  if (!proposal.quality) return { autoCandidate: false, reason: 'missing-assessment' };
  const thresholds = {
    confidence: configured?.confidence ?? 0.8,
    durability: configured?.durability ?? 0.6,
    specificity: configured?.specificity ?? 0.6,
    contradictionRisk: configured?.contradictionRisk ?? 0.2,
  };
  if (proposal.quality.contradictionRisk > thresholds.contradictionRisk) {
    return { autoCandidate: false, reason: 'conflict-risk' };
  }
  const passes = proposal.quality.confidence >= thresholds.confidence
    && proposal.quality.durability >= thresholds.durability
    && proposal.quality.specificity >= thresholds.specificity;
  return passes
    ? { autoCandidate: true, reason: 'quality-gate' }
    : { autoCandidate: false, reason: 'quality-gate' };
}

function parseRelationships(value: unknown, scope: string): DreamingRelationship[] {
  if (!Array.isArray(value)) throw new Error('relationships must be an array.');
  return value.map((item): DreamingRelationship => {
    if (!isObject(item)) throw new Error('Invalid dreaming relationship.');
    const relationship: DreamingRelationship = {
      id: requiredString(item.id, 'relationship.id'),
      scope: requiredString(item.scope, 'relationship.scope'),
      fromId: requiredString(item.fromId, 'relationship.fromId'),
      toId: requiredString(item.toId, 'relationship.toId'),
      kind: requiredString(item.kind, 'relationship.kind'),
      sourceRefs: stringArray(item.sourceRefs ?? [], 'relationship.sourceRefs'),
    };
    if (relationship.scope !== scope) throw new Error('Relationship scope does not match the active scope.');
    if (relationship.fromId === relationship.toId) throw new Error('Self-referential relationships are not allowed.');
    return relationship;
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string.`);
  return value;
}
function boundedString(value: unknown, field: string, maxLength: number): string {
  const result = requiredString(value, field);
  if (result.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters.`);
  return result;
}
function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return [...new Set(value as string[])];
}

