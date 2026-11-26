import type {
  DreamingFeedbackEvent, DreamingFeedbackKind, DreamingMemoryQuality, DreamingReviewEffectiveness,
} from './types.js';

const FEEDBACK_HALF_LIFE_MS = 90 * 24 * 60 * 60_000;
const FEEDBACK_WINDOW_MS = 180 * 24 * 60 * 60_000;

/** Deterministic, recency-weighted quality summary. It never changes memory state. */
export function evaluateMemoryQuality(
  events: readonly DreamingFeedbackEvent[],
  now: Date | string = new Date(),
): DreamingMemoryQuality {
  const evaluatedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(evaluatedAt.getTime())) throw new Error('Invalid quality evaluation time.');
  const uniqueEvents = new Map<string, DreamingFeedbackEvent>();
  const identity = events[0] ? { scope: events[0].scope, memoryId: events[0].memoryId } : undefined;
  for (const event of events) {
    if (identity && (event.scope !== identity.scope || event.memoryId !== identity.memoryId)) {
      throw new Error('Quality evaluation accepts events for one memory and scope only.');
    }
    validateFeedbackEvent(event);
    const previous = uniqueEvents.get(event.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) {
      throw new Error(`Conflicting feedback event ID: ${event.id}`);
    }
    uniqueEvents.set(event.id, event);
  }
  const cutoff = evaluatedAt.getTime() - FEEDBACK_WINDOW_MS;
  const recent = [...uniqueEvents.values()].filter((event) => {
    const timestamp = Date.parse(event.occurredAt);
    return timestamp >= cutoff && timestamp <= evaluatedAt.getTime();
  });
  const weight = (event: DreamingFeedbackEvent) =>
    Math.pow(0.5, (evaluatedAt.getTime() - Date.parse(event.occurredAt)) / FEEDBACK_HALF_LIFE_MS);
  const weightedRate = (selected: DreamingFeedbackEvent[], positive: (event: DreamingFeedbackEvent) => boolean) => {
    const total = selected.reduce((sum, event) => sum + weight(event), 0);
    if (!total) return undefined;
    const positives = selected.reduce((sum, event) => sum + (positive(event) ? weight(event) : 0), 0);
    return positives / total;
  };
  const retrieval = recent.filter((event) => event.kind === 'retrieval' && event.outcome !== 'neutral');
  const evidence = recent.filter((event) => event.kind === 'evidence');
  const corrections = recent.filter((event) => event.kind === 'user-correction');
  const humanRejections = recent.filter((event) => event.kind === 'human-review' && event.outcome === 'rejected');
  const usefulness = weightedRate(retrieval, (event) => event.outcome === 'useful');
  const evidenceSupport = weightedRate(evidence, (event) => event.outcome === 'supports');
  const latestHumanReview = recent
    .filter((event) => event.kind === 'human-review')
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];
  const latestAcceptedReview = latestHumanReview
    && (latestHumanReview.outcome === 'confirmed' || latestHumanReview.outcome === 'edited')
    ? latestHumanReview
    : undefined;
  let reviewEffectiveness: DreamingReviewEffectiveness | undefined;
  if (latestAcceptedReview) {
    const reviewTime = Date.parse(latestAcceptedReview.occurredAt);
    const baseline = retrieval.filter((event) => Date.parse(event.occurredAt) < reviewTime);
    const followUp = retrieval.filter((event) => Date.parse(event.occurredAt) > reviewTime);
    // Compare raw cohort rates; global recency weights would systematically discount the older baseline.
    const cohortRate = (items: DreamingFeedbackEvent[]) =>
      items.filter((event) => event.outcome === 'useful').length / items.length;
    const baselineUsefulness = baseline.length ? cohortRate(baseline) : undefined;
    const followUpUsefulness = followUp.length ? cohortRate(followUp) : undefined;
    if (baseline.length >= 3 && followUp.length >= 3
      && baselineUsefulness !== undefined && followUpUsefulness !== undefined) {
      const delta = Number((followUpUsefulness - baselineUsefulness).toFixed(3));
      reviewEffectiveness = {
        reviewedAt: latestAcceptedReview.occurredAt,
        baselineSampleCount: baseline.length,
        followUpSampleCount: followUp.length,
        baselineUsefulness: Number(baselineUsefulness.toFixed(3)),
        followUpUsefulness: Number(followUpUsefulness.toFixed(3)),
        delta,
        trend: delta >= 0.15 ? 'improving' : delta <= -0.15 ? 'declining' : 'stable',
      };
    }
  }
  const reasons: string[] = [];
  if (retrieval.length >= 5 && usefulness !== undefined && usefulness < 0.4) reasons.push('low-retrieval-usefulness');
  if (evidence.length >= 3 && evidenceSupport !== undefined && evidenceSupport < 0.6) reasons.push('contradicting-evidence');
  if (corrections.length >= 2) reasons.push('repeated-user-correction');
  if (humanRejections.length > 0) reasons.push('human-rejected');
  if (reviewEffectiveness?.trend === 'declining') reasons.push('post-review-usefulness-declined');
  const first = recent.reduce((min, event) => Math.min(min, Date.parse(event.occurredAt)), evaluatedAt.getTime());
  return {
    memoryId: recent[0]?.memoryId ?? events[0]?.memoryId ?? '',
    evaluatedAt: evaluatedAt.toISOString(),
    windowStart: new Date(Math.max(cutoff, first)).toISOString(),
    sampleCount: recent.length,
    effectiveSampleCount: Number(recent.reduce((sum, event) => sum + weight(event), 0).toFixed(3)),
    ...(usefulness === undefined ? {} : { usefulness: Number(usefulness.toFixed(3)) }),
    ...(evidenceSupport === undefined ? {} : { evidenceSupport: Number(evidenceSupport.toFixed(3)) }),
    correctionCount: corrections.length,
    humanRejectionCount: humanRejections.length,
    ...(reviewEffectiveness ? { reviewEffectiveness } : {}),
    recommendation: reasons.length ? 'review' : 'none',
    reasons,
  };
}

export function validateFeedbackEvent(event: DreamingFeedbackEvent): void {
  requiredString(event.id, 'feedback.id');
  requiredString(event.scope, 'feedback.scope');
  requiredString(event.memoryId, 'feedback.memoryId');
  if (!Number.isFinite(Date.parse(event.occurredAt))) throw new Error('feedback.occurredAt must be a valid timestamp.');
  const allowed: Record<DreamingFeedbackKind, readonly string[]> = {
    retrieval: ['useful', 'not-useful', 'neutral'],
    evidence: ['supports', 'contradicts'],
    'user-correction': ['incorrect', 'outdated', 'not-applicable'],
    'human-review': ['confirmed', 'rejected', 'edited'],
  };
  if (!Object.prototype.hasOwnProperty.call(allowed, event.kind)
    || !allowed[event.kind].includes(event.outcome)) {
    throw new Error('Feedback kind and outcome do not match.');
  }
  if (event.sourceRef !== undefined) requiredString(event.sourceRef, 'feedback.sourceRef');
  if (event.taskId !== undefined) requiredString(event.taskId, 'feedback.taskId');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value;
}
