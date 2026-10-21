export type ContextMetadataValue = string | number | boolean | null;

/** Stable pointer back to the data source from which a context item was derived. */
export interface ContextSourceRef {
  id: string;
  kind?: string;
  label?: string;
  uri?: string;
  revision?: string;
}

/**
 * A piece of context already selected and authorized by the host application.
 * The assembler treats text as opaque data: it does not retrieve, authorize,
 * fact-check, rewrite or promote the certainty of an item.
 */
export interface ContextItem {
  id: string;
  text: string;
  /** Larger values win when optional items compete for budget. Defaults to 0. */
  priority?: number;
  /** Required items are retained even when they cause the output to exceed budget. */
  required?: boolean;
  /** Explicit cross-source deduplication key. First-class IDs must still be unique. */
  dedupeKey?: string;
  /** Provenance is carried through to the result; it is not automatically rendered. */
  sources?: readonly ContextSourceRef[];
  metadata?: Readonly<Record<string, ContextMetadataValue>>;
}

/** Sections define stable rendering order; priorities affect selection, not rendering. */
export interface ContextSection {
  id: string;
  title?: string;
  priority?: number;
  /** Makes every non-empty item in the section required. */
  required?: boolean;
  items: readonly ContextItem[];
  /** Defaults to a blank line. */
  itemSeparator?: string;
}

export interface ContextBudget {
  /** Maximum measured units for the complete rendered context, including section headers. */
  maxUnits: number;
  /** Descriptive unit name. Defaults to UTF-16 code units when the default estimator is used. */
  unit?: string;
}

export type ContextLengthEstimator = (renderedText: string) => number;
export type ContextSectionHeaderRenderer = (section: ContextSection) => string | undefined;

export interface AssembleContextInput {
  sections: readonly ContextSection[];
  budget: ContextBudget;
  /** Optional token/length estimator supplied by the caller. Must return finite, non-negative units. */
  measure?: ContextLengthEstimator;
  /** Defaults to two newline characters. */
  sectionSeparator?: string;
  /** Defaults to Markdown "## {title or id}". Return undefined or an empty string to omit headers. */
  renderSectionHeader?: ContextSectionHeaderRenderer;
}

export type ContextOmissionReason = 'duplicate' | 'empty-content' | 'budget-exceeded';

export interface IncludedContextItem {
  sectionId: string;
  sectionTitle: string;
  item: ContextItem;
  effectivePriority: number;
  required: boolean;
}

export interface OmittedContextItem {
  sectionId: string;
  sectionTitle: string;
  item: ContextItem;
  reason: ContextOmissionReason;
  /** Set for duplicate items; points to the item that won deduplication. */
  duplicateOf?: string;
}

export interface ContextAssemblyIssue {
  code: 'required-context-exceeds-budget';
  message: string;
  requiredItemIds: string[];
  requiredUnits: number;
  maxUnits: number;
  overflowUnits: number;
}

export interface ContextAssemblyResult {
  /** Rendered in original section/item order, regardless of selection priority. */
  text: string;
  includedItems: IncludedContextItem[];
  omittedItems: OmittedContextItem[];
  budget: {
    maxUnits: number;
    usedUnits: number;
    remainingUnits: number;
    overflowUnits: number;
    unit: string;
    exceeded: boolean;
  };
  issues: ContextAssemblyIssue[];
}

export class ContextAssemblyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextAssemblyInputError';
  }
}

interface Candidate extends IncludedContextItem {
  sectionIndex: number;
  itemIndex: number;
  dedupeKey?: string;
}

interface OmittedCandidate extends OmittedContextItem {
  sectionIndex: number;
  itemIndex: number;
}

function validPriority(value: number | undefined, label: string): number {
  const priority = value ?? 0;
  if (!Number.isFinite(priority)) {
    throw new ContextAssemblyInputError(label + ' priority must be a finite number.');
  }
  return priority;
}

function isContextItemArray(value: unknown): value is readonly ContextItem[] {
  return Array.isArray(value);
}

function requiredOf(section: ContextSection, item: ContextItem): boolean {
  return section.required === true || item.required === true;
}

function comparePreference(left: Candidate, right: Candidate): number {
  if (left.required !== right.required) return left.required ? -1 : 1;
  if (left.effectivePriority !== right.effectivePriority) {
    return right.effectivePriority - left.effectivePriority;
  }
  return left.sectionIndex - right.sectionIndex || left.itemIndex - right.itemIndex;
}

function compareStableOrder(left: {sectionIndex: number; itemIndex: number}, right: {sectionIndex: number; itemIndex: number}): number {
  return left.sectionIndex - right.sectionIndex || left.itemIndex - right.itemIndex;
}

function measureText(text: string, measure?: ContextLengthEstimator): number {
  const units = measure ? measure(text) : text.length;
  if (!Number.isFinite(units) || units < 0) {
    throw new ContextAssemblyInputError('Context length estimator must return a finite, non-negative number.');
  }
  return units;
}

function renderContext(
  sections: readonly ContextSection[],
  candidates: readonly Candidate[],
  sectionSeparator: string,
  renderSectionHeader?: ContextSectionHeaderRenderer,
): string {
  const included = new Map<number, Set<number>>();
  for (const candidate of candidates) {
    let indexes = included.get(candidate.sectionIndex);
    if (!indexes) {
      indexes = new Set<number>();
      included.set(candidate.sectionIndex, indexes);
    }
    indexes.add(candidate.itemIndex);
  }

  const renderedSections: string[] = [];
  sections.forEach((section, sectionIndex) => {
    const selectedIndexes = included.get(sectionIndex);
    if (!selectedIndexes?.size) return;

    const items = section.items
      .filter((_, itemIndex) => selectedIndexes.has(itemIndex))
      .map((item) => item.text);
    const body = items.join(section.itemSeparator ?? '\n\n');
    const header = renderSectionHeader
      ? renderSectionHeader(section)
      : '## ' + (section.title?.trim() || section.id);
    renderedSections.push(header?.trim() ? header.trim() + '\n' + body : body);
  });

  return renderedSections.join(sectionSeparator);
}

/**
 * Deterministically assembles host-selected context. Required items are never
 * silently dropped; when required content exceeds the budget, it is preserved
 * and the result explicitly reports the overflow. Optional items are considered
 * by effective priority (section + item), then by stable input order.
 */
export function assembleContext(input: AssembleContextInput): ContextAssemblyResult {
  if (!Array.isArray(input.sections)) {
    throw new ContextAssemblyInputError('sections must be an array.');
  }
  if (!input.budget || !Number.isFinite(input.budget.maxUnits) || input.budget.maxUnits <= 0) {
    throw new ContextAssemblyInputError('budget.maxUnits must be a finite positive number.');
  }

  const sectionIds = new Set<string>();
  const itemIds = new Set<string>();
  const candidates: Candidate[] = [];
  const omitted: OmittedCandidate[] = [];

  input.sections.forEach((section, sectionIndex) => {
    if (!section || typeof section.id !== 'string' || !section.id.trim()) {
      throw new ContextAssemblyInputError('Every context section needs a non-empty id.');
    }
    if (sectionIds.has(section.id)) {
      throw new ContextAssemblyInputError('Duplicate context section id: ' + section.id);
    }
    sectionIds.add(section.id);
    if (!isContextItemArray(section.items)) {
      throw new ContextAssemblyInputError('Context section ' + section.id + ' must have an items array.');
    }
    const sectionPriority = validPriority(section.priority, 'Section ' + section.id);

    section.items.forEach((item, itemIndex) => {
      if (!item || typeof item.id !== 'string' || !item.id.trim()) {
        throw new ContextAssemblyInputError('Every context item needs a non-empty id.');
      }
      if (itemIds.has(item.id)) {
        throw new ContextAssemblyInputError('Duplicate context item id: ' + item.id);
      }
      itemIds.add(item.id);
      if (typeof item.text !== 'string') {
        throw new ContextAssemblyInputError('Context item ' + item.id + ' text must be a string.');
      }
      const isRequired = requiredOf(section, item);
      const title = section.title?.trim() || section.id;

      if (!item.text.trim()) {
        if (isRequired) {
          throw new ContextAssemblyInputError('Required context item ' + item.id + ' has empty content.');
        }
        omitted.push({
          sectionId: section.id, sectionTitle: title, item, reason: 'empty-content', sectionIndex, itemIndex,
        });
        return;
      }

      const itemPriority = validPriority(item.priority, 'Item ' + item.id);
      candidates.push({
        sectionId: section.id,
        sectionTitle: title,
        item,
        required: isRequired,
        effectivePriority: sectionPriority + itemPriority,
        sectionIndex,
        itemIndex,
        ...(item.dedupeKey?.trim() ? {dedupeKey: item.dedupeKey.trim()} : {}),
      });
    });
  });

  // Deduplicate only when the host supplied an explicit key. Pick the required,
  // highest-priority, earliest item and report every dropped duplicate.
  const dedupeGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = candidate.dedupeKey;
    if (!key) continue;
    const group = dedupeGroups.get(key) ?? [];
    group.push(candidate);
    dedupeGroups.set(key, group);
  }

  const duplicateIds = new Set<string>();
  for (const group of dedupeGroups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort(comparePreference);
    const winner = ranked[0]!;
    for (const duplicate of ranked.slice(1)) {
      duplicateIds.add(duplicate.item.id);
      omitted.push({
        sectionId: duplicate.sectionId,
        sectionTitle: duplicate.sectionTitle,
        item: duplicate.item,
        reason: 'duplicate',
        duplicateOf: winner.item.id,
        sectionIndex: duplicate.sectionIndex,
        itemIndex: duplicate.itemIndex,
      });
    }
  }
  const uniqueCandidates = candidates.filter((candidate) => !duplicateIds.has(candidate.item.id));
  const required = uniqueCandidates.filter((candidate) => candidate.required);
  const optional = uniqueCandidates.filter((candidate) => !candidate.required).sort(comparePreference);
  const sectionSeparator = input.sectionSeparator ?? '\n\n';

  let selected = [...required];
  let text = renderContext(input.sections, selected, sectionSeparator, input.renderSectionHeader);
  const requiredUnits = measureText(text, input.measure);
  const maxUnits = input.budget.maxUnits;
  const requiredExceeded = requiredUnits > maxUnits;
  const issues: ContextAssemblyIssue[] = [];

  if (requiredExceeded) {
    issues.push({
      code: 'required-context-exceeds-budget',
      message: 'Required context exceeds the configured budget; all required items were retained and optional items were omitted.',
      requiredItemIds: required.map((candidate) => candidate.item.id),
      requiredUnits,
      maxUnits,
      overflowUnits: requiredUnits - maxUnits,
    });
    for (const candidate of optional) {
      omitted.push({
        sectionId: candidate.sectionId,
        sectionTitle: candidate.sectionTitle,
        item: candidate.item,
        reason: 'budget-exceeded',
        sectionIndex: candidate.sectionIndex,
        itemIndex: candidate.itemIndex,
      });
    }
  } else {
    for (const candidate of optional) {
      const next = [...selected, candidate];
      const nextText = renderContext(input.sections, next, sectionSeparator, input.renderSectionHeader);
      if (measureText(nextText, input.measure) <= maxUnits) {
        selected = next;
        text = nextText;
      } else {
        omitted.push({
          sectionId: candidate.sectionId,
          sectionTitle: candidate.sectionTitle,
          item: candidate.item,
          reason: 'budget-exceeded',
          sectionIndex: candidate.sectionIndex,
          itemIndex: candidate.itemIndex,
        });
      }
    }
  }

  text = renderContext(input.sections, selected, sectionSeparator, input.renderSectionHeader);
  const usedUnits = measureText(text, input.measure);
  const overflowUnits = Math.max(0, usedUnits - maxUnits);
  const includedItems = selected
    .sort(compareStableOrder)
    .map(({sectionIndex: _sectionIndex, itemIndex: _itemIndex, dedupeKey: _dedupeKey, ...candidate}) => candidate);

  return {
    text,
    includedItems,
    omittedItems: omitted
      .sort(compareStableOrder)
      .map(({sectionIndex: _sectionIndex, itemIndex: _itemIndex, ...item}) => item),
    budget: {
      maxUnits,
      usedUnits,
      remainingUnits: Math.max(0, maxUnits - usedUnits),
      overflowUnits,
      unit: input.budget.unit ?? (input.measure ? 'custom units' : 'UTF-16 code units'),
      exceeded: overflowUnits > 0,
    },
    issues,
  };
}
