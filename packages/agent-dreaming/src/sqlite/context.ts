import { createHash } from 'node:crypto';
import type {
  DreamingContextItem, DreamingContextOmission, DreamingContextRequest,
  DreamingContextResult, DreamingSearchHit,
} from '../types.js';
import type { SqliteDatabase } from './database.js';
import { mapEvidence } from './database.js';
import { SqliteSearchStore } from './search.js';
import { SqliteEvidenceStore } from './evidence.js';

type Candidate = {
  item: DreamingContextItem;
  section: string;
  order: number;
};

function roughTokenCount(text: string): number {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) ?? []).length;
  const other = text.length - cjk;
  return Math.ceil(cjk + other / 4);
}

function shorten(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  return text.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

function normalizeContent(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim();
}

function sectionFor(type: DreamingContextItem['sourceType']): string {
  switch (type) {
    case 'always-on-memory': return 'Persistent instructions and key memories';
    case 'memory': return 'Relevant long-term memories';
    case 'experience': return 'Related experiences';
    case 'evidence': return 'Original source evidence';
  }
}

function render(items: readonly Candidate[]): string {
  const sections = new Map<string, string[]>();
  for (const candidate of [...items].sort((a, b) => a.order - b.order)) {
    const lines = sections.get(candidate.section) ?? [];
    const refs = candidate.item.sourceRefs.length ? ` (sources: ${candidate.item.sourceRefs.join(', ')})` : '';
    lines.push(`- [${candidate.item.id}] ${candidate.item.text}${refs}`);
    sections.set(candidate.section, lines);
  }
  return [...sections.entries()]
    .map(([title, lines]) => `## ${title}\n${lines.join('\n')}`)
    .join('\n\n');
}

function contextItemFromHit(
  hit: DreamingSearchHit,
  text: string,
  priority: number,
): Candidate {
  const sourceType = hit.sourceType;
  const item: DreamingContextItem = {
    id: hit.id,
    sourceType,
    text,
    score: hit.score,
    required: false,
    sourceRefs: hit.sourceRefs,
    ...(hit.revision ? { revision: hit.revision } : {}),
    ...(hit.authority ? { authority: hit.authority } : {}),
    ...(hit.memoryType ? { memoryType: hit.memoryType } : {}),
    ...(hit.origin ? { origin: hit.origin } : {}),
  };
  return {
    item,
    section: sectionFor(sourceType),
    order: sourceType === 'memory' ? 100 : sourceType === 'experience' ? 200 : 300,
  };
}

export class SqliteContextStore {
  private readonly search: SqliteSearchStore;
  private readonly evidence: SqliteEvidenceStore;

  constructor(private readonly context: SqliteDatabase) {
    this.search = new SqliteSearchStore(context);
    this.evidence = new SqliteEvidenceStore(context);
  }

  async build(input: DreamingContextRequest): Promise<DreamingContextResult> {
    this.context.ensureOpen();
    if (!input.scope.trim()) throw new TypeError('scope is required');
    if (!input.task.trim()) throw new TypeError('task is required');
    if (input.task.length > 20_000) throw new TypeError('task must not exceed 20000 characters');
    const query = (input.query ?? input.task).trim();
    if (!query) throw new TypeError('query must not be empty');
    if (!Number.isSafeInteger(input.budget.maxUnits) || input.budget.maxUnits < 1) {
      throw new TypeError('budget.maxUnits must be a positive integer');
    }

    const unit = input.budget.unit ?? 'characters';
    const reservedUnits = input.budget.reservedUnits ?? 0;
    if (!Number.isSafeInteger(reservedUnits) || reservedUnits < 0 || reservedUnits >= input.budget.maxUnits) {
      throw new TypeError('budget.reservedUnits must be a non-negative integer smaller than maxUnits');
    }
    const maxItems = input.budget.maxItems ?? 40;
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 500) {
      throw new TypeError('budget.maxItems must be between 1 and 500');
    }
    const measure = input.measure ?? (unit === 'tokens' ? roughTokenCount : (value: string) => value.length);
    const maxItemChars = input.maxItemChars ?? 2_400;
    if (!Number.isSafeInteger(maxItemChars) || maxItemChars < 100 || maxItemChars > 20_000) {
      throw new TypeError('maxItemChars must be between 100 and 20000');
    }

    const alwaysOnLimit = input.alwaysOnLimit ?? 12;
    const searchLimit = input.maxSearchResults ?? 24;
    const maxEvidence = input.maxEvidence ?? 6;
    if (!Number.isSafeInteger(alwaysOnLimit) || alwaysOnLimit < 1 || alwaysOnLimit > 100) {
      throw new TypeError('alwaysOnLimit must be between 1 and 100');
    }
    if (!Number.isSafeInteger(searchLimit) || searchLimit < 1 || searchLimit > 200) {
      throw new TypeError('maxSearchResults must be between 1 and 200');
    }
    if (!Number.isSafeInteger(maxEvidence) || maxEvidence < 0 || maxEvidence > 100) {
      throw new TypeError('maxEvidence must be between 0 and 100');
    }

    const alwaysOn = await this.search.listAlwaysOnMemories({ scope: input.scope, limit: alwaysOnLimit });
    const hits = await this.search.search({
      scope: input.scope, query, limit: searchLimit,
      sourceTypes: ['memory', 'experience', ...(input.includeEvidence === false ? [] : ['evidence' as const])],
    });

    const candidates: Array<Candidate & { priority: number; dedupe: string }> = [];
    const seenIds = new Set<string>();
    for (const hit of alwaysOn) {
      const item: DreamingContextItem = {
        id: hit.id,
        sourceType: 'always-on-memory',
        text: shorten(hit.content, maxItemChars),
        score: hit.score,
        required: hit.authority === 'user-explicit',
        sourceRefs: hit.sourceRefs,
        ...(hit.revision ? { revision: hit.revision } : {}),
        ...(hit.authority ? { authority: hit.authority } : {}),
        ...(hit.memoryType ? { memoryType: hit.memoryType } : {}),
      };
      candidates.push({
        item, section: sectionFor('always-on-memory'), order: 0,
        priority: item.required ? 10_000 : 600 + (hit.importance ?? 0) * 100,
        dedupe: normalizeContent(hit.content),
      });
      seenIds.add(hit.id);
    }

    const memoryHits = hits.filter((hit) => hit.sourceType === 'memory');
    const experienceHits = hits.filter((hit) => hit.sourceType === 'experience');
    const evidenceHits = hits.filter((hit) => hit.sourceType === 'evidence');

    for (const hit of memoryHits) {
      if (seenIds.has(hit.id)) continue;
      const candidate = contextItemFromHit(hit, shorten(hit.content, maxItemChars), 0);
      candidates.push({
        ...candidate,
        priority: 400 + (hit.importance ?? 0) * 100 + hit.score * 100,
        dedupe: normalizeContent(hit.content),
      });
      seenIds.add(hit.id);
    }
    for (const hit of experienceHits) {
      const candidate = contextItemFromHit(hit, shorten(hit.content, maxItemChars), 0);
      candidates.push({
        ...candidate,
        priority: 200 + hit.score * 100,
        dedupe: normalizeContent(hit.content),
      });
    }

    const evidenceRefs = [...new Set([
      ...alwaysOn.flatMap((hit) => [...hit.sourceRefs]),
      ...memoryHits.flatMap((hit) => [...hit.sourceRefs]),
      ...experienceHits.flatMap((hit) => [...hit.sourceRefs]),
      ...evidenceHits.flatMap((hit) => [...hit.sourceRefs]),
    ])].slice(0, maxEvidence);
    const resolvedEvidence = input.includeEvidence === false || maxEvidence === 0
      ? []
      : await this.evidence.resolve({ scope: input.scope, refs: evidenceRefs });

    for (const hit of evidenceHits) {
      const candidate = contextItemFromHit(hit, shorten(hit.content, maxItemChars), 0);
      candidates.push({
        ...candidate,
        priority: 150 + hit.score * 100,
        dedupe: normalizeContent(hit.content),
      });
    }
    for (const evidence of resolvedEvidence) {
      if (evidenceHits.some((hit) => hit.id === evidence.ref)) continue;
      const candidate: DreamingContextItem = {
        id: evidence.ref, sourceType: 'evidence', text: shorten(evidence.content, maxItemChars),
        score: 1, required: false, sourceRefs: [evidence.ref],
        ...(evidence.createdAt ? { revision: evidence.createdAt } : {}),
        ...(evidence.origin ? { origin: evidence.origin } : {}),
      };
      candidates.push({
        item: candidate, section: sectionFor('evidence'), order: 300,
        priority: 125,
        dedupe: normalizeContent(evidence.content),
      });
    }

    const omissions: DreamingContextOmission[] = [];
    const deduped: typeof candidates = [];
    const seenContent = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.dedupe) {
        omissions.push({ id: candidate.item.id, sourceType: candidate.item.sourceType, reason: 'duplicate' });
      } else if (seenContent.has(candidate.dedupe)) {
        omissions.push({ id: candidate.item.id, sourceType: candidate.item.sourceType, reason: 'duplicate' });
      } else {
        seenContent.add(candidate.dedupe);
        deduped.push(candidate);
      }
    }

    deduped.sort((a, b) => b.priority - a.priority || a.order - b.order || a.item.id.localeCompare(b.item.id));
    const availableUnits = input.budget.maxUnits - reservedUnits;
    const selected: typeof deduped = [];
    for (const candidate of deduped) {
      if (selected.length >= maxItems && !candidate.item.required) {
        omissions.push({ id: candidate.item.id, sourceType: candidate.item.sourceType, reason: 'max-items' });
        continue;
      }
      const nextText = render([...selected, candidate]);
      const nextUnits = measure(nextText);
      if (!Number.isFinite(nextUnits) || nextUnits < 0) throw new TypeError('Context measure must return finite non-negative units');
      if (nextUnits <= availableUnits || candidate.item.required) {
        selected.push(candidate);
      } else {
        omissions.push({ id: candidate.item.id, sourceType: candidate.item.sourceType, reason: 'budget-exceeded' });
      }
    }

    selected.sort((a, b) => a.order - b.order || b.priority - a.priority || a.item.id.localeCompare(b.item.id));
    const text = render(selected);
    const usedUnits = measure(text);
    const overflowUnits = Math.max(0, usedUnits - availableUnits);
    const selectedAlwaysOn = selected.filter((candidate) => candidate.item.sourceType === 'always-on-memory');
    const manifestText = render(selectedAlwaysOn);
    const manifestHash = createHash('sha256').update(manifestText).digest('hex');
    const hash = createHash('sha256').update(input.scope).update('\0').update(input.task).update('\0').update(text).digest('hex');
    const createdAt = new Date().toISOString();

    return {
      id: `context:${hash.slice(0, 24)}`,
      scope: input.scope,
      task: input.task,
      text,
      items: selected.map((candidate) => candidate.item),
      omittedItems: omissions,
      manifest: {
        text: manifestText,
        itemIds: selectedAlwaysOn.map((candidate) => candidate.item.id),
        hash: manifestHash,
        truncated: omissions.some((item) => item.sourceType === 'always-on-memory' && item.reason !== 'duplicate'),
      },
      budget: {
        maxUnits: input.budget.maxUnits,
        reservedUnits,
        availableUnits,
        usedUnits,
        overflowUnits,
        unit,
        estimated: unit === 'tokens' && input.measure === undefined,
        exceeded: overflowUnits > 0,
      },
      hash,
      createdAt,
    };
  }
}
