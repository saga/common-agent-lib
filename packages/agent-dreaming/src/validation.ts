import type {
  DreamingModelResult, DreamingProposal, DreamingQualityAssessment,
  DreamingOptions, DreamingRelationship,
} from './types.js';

export function parseResult(value: unknown, scope: string): DreamingModelResult {
  if (!isObject(value)) throw new Error('Dreaming runtime returned a non-object result.');
  if (!Array.isArray(value.proposals)) throw new Error('Dreaming result proposals must be an array.');
  if (value.proposals.length > 100) throw new Error('Dreaming result exceeds the proposal limit.');
  const proposals = value.proposals.map((item) => parseProposal(item, scope));
  const processedRecordIds = stringArray(value.processedRecordIds, 'processedRecordIds');
  const reviewedMemoryIds = stringArray(value.reviewedMemoryIds ?? [], 'reviewedMemoryIds');
  const notes = value.notes === undefined ? [] : stringArray(value.notes, 'notes');
  return { proposals, processedRecordIds, reviewedMemoryIds, notes };
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
    proposal.proposedRecord = {
      id: requiredString(record.id, 'proposedRecord.id'),
      scope: requiredString(record.scope, 'proposedRecord.scope'),
      content: boundedString(record.content, 'proposedRecord.content', 4_000),
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

