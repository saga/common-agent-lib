import type {
  DreamingCheckpoint, DreamingEvidence, DreamingEvidenceResolver, DreamingFeedbackEvent, DreamingMemory,
  DreamingMemoryQuality, DreamingModelResult, DreamingOptions, DreamingPage,
  DreamingProposal, DreamingRelationship, DreamingRepository, DreamingRun,
  DreamingKnowledgePage, DreamingKnowledgeLink,
  DreamingRunInput, DreamingRuntime, DreamingUserMessageInput,
} from './types.js';
import { SYSTEM_PROMPT, buildPrompt } from './prompts.js';
import { parseResult } from './validation.js';
import { evaluateMemoryQuality, validateFeedbackEvent } from './quality.js';
import { createId, unrefTimer, unique } from './utils.js';
import { detectUserMemoryDirective } from './user-directives.js';

export class DreamingEngine {
  private readonly owner = createId('dreamer');
  private timer?: ReturnType<typeof setInterval>;
  private stopped = true;
  private readonly active = new Map<string, Promise<DreamingRun | undefined>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly scopes: ReadonlySet<string>;

  constructor(
    private readonly runtime: DreamingRuntime,
    private readonly repository: DreamingRepository,
    private readonly evidenceResolver: DreamingEvidenceResolver,
    private readonly options: DreamingOptions,
  ) {
    if (!options.scopes.length) throw new Error('Dreaming requires at least one scope.');
    if (options.scopes.some((scope) => !scope.trim()) || new Set(options.scopes).size !== options.scopes.length) {
      throw new Error('Dreaming scopes must be non-empty and unique.');
    }
    if (!runtime.id) throw new Error('Dreaming runtime must have a stable id.');
    this.scopes = new Set(options.scopes);
    if (options.maxKnowledgePages !== undefined
      && (!Number.isSafeInteger(options.maxKnowledgePages) || options.maxKnowledgePages < 1 || options.maxKnowledgePages > 100)) {
      throw new Error('maxKnowledgePages must be an integer between 1 and 100.');
    }
    for (const [name, value] of Object.entries(options.autoCandidateThresholds ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`autoCandidateThresholds.${name} must be between 0 and 1.`);
      }
    }
  }

  /** Starts automatic startup + periodic dreaming. Call once when the host starts. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const scope of this.options.scopes) void this.safeRun({ scope, trigger: 'startup' }).catch(() => undefined);
    const interval = Math.max(1_000, this.options.intervalMs ?? 15 * 60_000);
    this.timer = setInterval(() => {
      for (const scope of this.options.scopes) void this.safeRun({ scope, trigger: 'interval' }).catch(() => undefined);
    }, interval);
    unrefTimer(this.timer);
  }

  /** Stop scheduling. Existing runs are allowed to finish. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stop scheduling, abort active runs and wait for lease cleanup. */
  async shutdown(reason: unknown = new Error('Dreaming engine is shutting down.')): Promise<void> {
    this.stop();
    for (const controller of this.controllers.values()) controller.abort(reason);
    await Promise.allSettled([...this.active.values()]);
  }

  /** Call after appending a meaningful record; runs are coalesced per scope. */
  notifyRecordAppended(scope: string): Promise<DreamingRun | undefined> {
    this.assertScope(scope);
    if (this.stopped) return Promise.resolve(undefined);
    return this.safeRun({ scope, trigger: 'record-appended' });
  }

  /** Record feedback after host-side authorization; event IDs are idempotency keys. */
  async recordFeedback(event: DreamingFeedbackEvent): Promise<void> {
    this.assertScope(event.scope);
    validateFeedbackEvent(event);
    await this.repository.recordFeedback(event);
  }

  runNow(scope: string, signal?: AbortSignal): Promise<DreamingRun | undefined> {
    this.assertScope(scope);
    return this.safeRun({ scope, trigger: 'manual', signal });
  }

  /**
   * Process a direct message from the authenticated memory owner.
   * Explicit remember/avoid instructions are persisted immediately, without a
   * model call, quality gate, candidate queue or human review.
   */
  async applyUserMessage(input: DreamingUserMessageInput): Promise<{
    directive: ReturnType<typeof detectUserMemoryDirective> & {};
    memory: DreamingMemory;
  } | undefined> {
    this.assertScope(input.scope);
    const directive = detectUserMemoryDirective(input.text);
    if (!directive) return undefined;
    if (!this.repository.applyUserDirective) {
      throw new Error('The configured Dreaming repository does not support direct user directives.');
    }
    const memory = await this.repository.applyUserDirective({
      id: input.id,
      scope: input.scope,
      kind: directive.kind,
      instruction: directive.instruction,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      memoryType: directive.memoryType,
    });
    return { directive, memory };
  }

  private assertScope(scope: string): void {
    if (!this.scopes.has(scope)) throw new Error(`Unknown dreaming scope: ${scope}`);
  }

  private safeRun(input: DreamingRunInput): Promise<DreamingRun | undefined> {
    const existing = this.active.get(input.scope);
    if (existing) return existing;
    const task = this.runOnce(input).catch(async (error: unknown) => {
      try { await this.options.onError?.(error, input.scope); } catch { /* Preserve the run failure. */ }
      throw error;
    }).finally(() => {
      this.active.delete(input.scope);
      this.controllers.delete(input.scope);
    });
    this.active.set(input.scope, task);
    return task;
  }

  private async emitRun(run: Readonly<DreamingRun>): Promise<void> {
    try {
      await this.options.onRun?.(run);
    } catch (error) {
      try { await this.options.onError?.(error, run.scope); } catch { /* Observer failures must not change run state. */ }
    }
  }

  private async runOnce(input: DreamingRunInput): Promise<DreamingRun | undefined> {
    const scope = input.scope;
    const leaseMs = Math.max(10_000, this.options.leaseMs ?? 5 * 60_000);
    const controller = new AbortController();
    this.controllers.set(scope, controller);
    let acquired = false;
    try {
      acquired = await this.repository.acquireLease({ scope, owner: this.owner, leaseMs });
    } catch (error) {
      this.controllers.delete(scope);
      throw error;
    }
    if (!acquired) {
      this.controllers.delete(scope);
      return undefined;
    }
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let renewal: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (renewal || signal.aborted) return;
      renewal = this.repository.renewLease({ scope, owner: this.owner, leaseMs })
        .then((renewed) => { if (!renewed) controller.abort(new Error('Dreaming lease was lost.')); })
        .catch((error: unknown) => controller.abort(error))
        .then(() => undefined)
        .finally(() => { renewal = undefined; });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    unrefTimer(heartbeat);

    let run: DreamingRun | undefined;
    try {
    const now = new Date().toISOString();
    const checkpoint = await this.repository.loadCheckpoint(scope);
    run = {
      id: createId('dreaming-run'),
      scope,
      status: 'running',
      trigger: input.trigger ?? 'manual',
      startedAt: now,
      fromSequence: checkpoint.afterSequence + 1,
      toSequence: checkpoint.afterSequence,
      processedRecordIds: [],
      appliedProposalIds: [],
      rejectedProposalIds: [],
      pendingProposalIds: [],
      reviewedMemoryIds: [],
      runtimeId: this.runtime.id,
    };
    await this.repository.createRun(run);

      const batchSize = Math.max(1, this.options.batchSize ?? 40);
      const maxBatches = Math.max(1, this.options.maxBatchesPerRun ?? 3);
      const reviewBefore = new Date(Date.now() - (this.options.reviewIntervalMs ?? 30 * 24 * 60 * 60_000)).toISOString();
      let afterSequence = checkpoint.afterSequence;
      let lastModel: string | undefined;
      let lastUsage: Readonly<Record<string, number>> | undefined;

      for (let batch = 0; batch < maxBatches; batch += 1) {
        if (signal.aborted) throw signal.reason ?? new Error('Dreaming aborted.');
        const page = await this.repository.loadExperiences({
          scope, afterSequence, reviewBefore, limit: batchSize,
        });
        if (page.items.length > batchSize) throw new Error('Repository returned more experiences than the requested batch limit.');
        const experiences = [...page.items].sort((a, b) => a.sequence - b.sequence);
        const experienceIds = new Set<string>();
        for (const experience of experiences) {
          if (experience.scope !== scope || !Number.isSafeInteger(experience.sequence) || experience.sequence < 1) {
            throw new Error('Repository returned an invalid experience or scope.');
          }
          if (experienceIds.has(experience.id)) throw new Error('Repository returned duplicate experience IDs.');
          experienceIds.add(experience.id);
        }
        const memoryReviewBefore = new Date(Date.now() - (this.options.memoryReviewIntervalMs ?? 30 * 24 * 60 * 60_000)).toISOString();
        const memories = await this.repository.loadMemories({
          scope,
          experienceIds: experiences.map((item) => item.id),
          reviewBefore: memoryReviewBefore,
          expiredBefore: new Date().toISOString(),
          limit: Math.max(1, this.options.maxMemories ?? 100),
        });
        if (memories.some((item) => item.scope !== scope) || new Set(memories.map((item) => item.id)).size !== memories.length) {
          throw new Error('Repository returned invalid memories for the active scope.');
        }
        const feedbackEvents = memories.length
          ? await this.repository.loadFeedback({
            scope,
            memoryIds: memories.map((item) => item.id),
            since: new Date(Date.now() - 180 * 24 * 60 * 60_000).toISOString(),
            limit: Math.max(100, memories.length * 20),
          })
          : [];
        const loadedMemoryIdsForFeedback = new Set(memories.map((item) => item.id));
        if (feedbackEvents.some((event) =>
          event.scope !== scope || !loadedMemoryIdsForFeedback.has(event.memoryId))) {
          throw new Error('Repository returned feedback outside the loaded memory scope.');
        }
        const qualityByMemory = new Map<string, DreamingMemoryQuality>();
        for (const memory of memories) {
          const events = feedbackEvents.filter((event) => event.memoryId === memory.id);
          if (events.length) qualityByMemory.set(memory.id, evaluateMemoryQuality(events));
        }
        const relationships = await this.repository.loadRelationships({
          scope, memoryIds: memories.map((item) => item.id),
          limit: Math.max(1, this.options.maxRelationships ?? 200),
        });
        if (relationships.some((item) => item.scope !== scope || !item.id || !item.fromId || !item.toId || item.fromId === item.toId)) {
          throw new Error('Repository returned invalid relationships for the active scope.');
        }
        if (!experiences.length && !memories.length) break;
        const refs = unique([
          ...experiences.flatMap((item) => [...item.sourceRefs]),
          ...memories.flatMap((item) => [...item.sourceRefs]),
          ...relationships.flatMap((item) => [...item.sourceRefs]),
        ]);
        const requestedRefs = refs.slice(0, Math.max(1, this.options.maxEvidenceItems ?? 100));
        const requestedRefSet = new Set(requestedRefs);
        const resolvedEvidence = await this.evidenceResolver.resolve({ scope, refs: requestedRefs });
        const evidenceIds = new Set<string>();
        for (const item of resolvedEvidence) {
          if (!item.ref?.trim() || !item.kind?.trim() || typeof item.content !== 'string'
            || !requestedRefSet.has(item.ref) || evidenceIds.has(item.ref)) {
            throw new Error('Evidence resolver returned invalid, duplicate or unrequested evidence.');
          }
          evidenceIds.add(item.ref);
        }
        const evidence = [...resolvedEvidence];
        const evidenceRefs = new Set(evidence.map((item) => item.ref));

        const knowledgeLimit = Math.min(100, Math.max(1, this.options.maxKnowledgePages ?? 30));
        const knowledgePages = this.repository.listKnowledgePages
          ? await this.repository.listKnowledgePages({ scope, status: 'active', limit: knowledgeLimit })
          : [];
        if (knowledgePages.some((page) => page.scope !== scope || page.status !== 'active')) {
          throw new Error('Repository returned invalid or cross-scope active Knowledge pages.');
        }
        const knowledgePageIds = new Set(knowledgePages.map((page) => page.id));
        const rawKnowledgeLinks = this.repository.listKnowledgeLinks
          ? await this.repository.listKnowledgeLinks({ scope, pageIds: [...knowledgePageIds], limit: 200 })
          : [];
        if (rawKnowledgeLinks.some((link) => link.scope !== scope)) {
          throw new Error('Repository returned cross-scope Knowledge links.');
        }
        // Relations to deprecated or superseded pages remain stored but are not supplied as active context.
        const knowledgeLinks = rawKnowledgeLinks.filter((link) =>
          knowledgePageIds.has(link.fromId) && knowledgePageIds.has(link.toId));
        const promptKnowledgePages = knowledgePages.map((page) => ({
          ...page,
          content: page.content.slice(0, 3_500),
        }));
        const prompt = buildPrompt(
          scope, experiences, memories, relationships, evidence, [...qualityByMemory.values()],
          promptKnowledgePages, knowledgeLinks,
        );
        const maxPromptChars = this.options.maxPromptChars ?? 120_000;
        if (!Number.isSafeInteger(maxPromptChars) || maxPromptChars < 1_000) {
          throw new Error('maxPromptChars must be an integer of at least 1000.');
        }
        if (prompt.length > maxPromptChars) {
          throw new Error(`Dreaming prompt exceeds the configured ${maxPromptChars}-character limit.`);
        }
        const response = await this.runtime.generate({
          task: 'memory-dreaming',
          system: SYSTEM_PROMPT,
          prompt,
          responseFormat: 'json',
          signal,
        });
        lastModel = response.model;
        lastUsage = response.usage;
        const result = parseResult(response.output, scope);
        if (signal.aborted) throw signal.reason ?? new Error('Dreaming aborted.');
        const batchIds = new Set(experiences.map((item) => item.id));
        for (const id of result.processedRecordIds) {
          if (!batchIds.has(id)) throw new Error(`Runtime marked an unknown experience as processed: ${id}`);
        }
        const loadedMemoryIds = new Set(memories.map((item) => item.id));
        for (const id of result.reviewedMemoryIds) {
          if (!loadedMemoryIds.has(id)) throw new Error(`Runtime marked an unknown memory as reviewed: ${id}`);
        }
        if (result.reviewedMemoryIds.length) {
          await this.repository.markMemoriesReviewed({
            scope, ids: result.reviewedMemoryIds, reviewedAt: new Date().toISOString(),
          });
          run.reviewedMemoryIds.push(...result.reviewedMemoryIds);
        }

        const memoryIds = new Set(memories.map((item) => item.id));
        for (const proposal of result.proposals) {
          if (signal.aborted) throw signal.reason ?? new Error('Dreaming aborted.');
          if (proposal.scope !== scope) throw new Error('Proposal scope does not match the active scope.');
          if (proposal.targetRecordIds.some((id) => !memoryIds.has(id)) || proposal.conflictsWith?.some((id) => !memoryIds.has(id))) {
            run.rejectedProposalIds.push(proposal.id);
            continue;
          }
          if (proposal.evidenceRefs.length === 0 || proposal.evidenceRefs.some((ref) => !evidenceRefs.has(ref))) {
            run.rejectedProposalIds.push(proposal.id);
            continue;
          }
          if (proposal.operation !== 'archive' && !proposal.proposedRecord?.sourceRefs.length) {
            run.rejectedProposalIds.push(proposal.id);
            continue;
          }
          const allowedRefs = new Set(proposal.evidenceRefs);
          const recordRefs = proposal.proposedRecord?.sourceRefs ?? [];
          const relationshipRefs = proposal.relationships?.flatMap((item) => item.sourceRefs) ?? [];
          if ([...recordRefs, ...relationshipRefs].some((ref) => !allowedRefs.has(ref) || !evidenceRefs.has(ref))) {
            run.rejectedProposalIds.push(proposal.id);
            continue;
          }
          const validRelationshipIds = new Set([...memoryIds, ...(proposal.proposedRecord ? [proposal.proposedRecord.id] : [])]);
          if (proposal.relationships?.some((item) => !validRelationshipIds.has(item.fromId) || !validRelationshipIds.has(item.toId))) {
            run.rejectedProposalIds.push(proposal.id);
            continue;
          }
          const proposalEvidence = evidence.filter((item) => allowedRefs.has(item.ref));
          // All valid proposals are applied automatically. Weak additions remain candidates;
          // existing-memory changes are versioned and protected by explicit-user authority.
          const outcome = await this.repository.commitProposal({
            proposal, evidence: proposalEvidence, runId: run.id,
          });
          if (outcome.applied) run.appliedProposalIds.push(proposal.id);
          else run.rejectedProposalIds.push(proposal.id);
        }

        if (result.knowledgeProposals?.length) {
          for (const proposal of result.knowledgeProposals) {
            const runProposalId = `knowledge:${proposal.id}`;
            if (!this.repository.commitKnowledgeProposal
              || proposal.scope !== scope
              || proposal.evidenceRefs.length === 0
              || proposal.evidenceRefs.some((ref) => !evidenceRefs.has(ref))
              || proposal.targetPageIds.some((id) => !knowledgePageIds.has(id))
              || (proposal.proposedPage && proposal.proposedPage.sourceRefs.some((ref) =>
                !proposal.evidenceRefs.includes(ref) || !evidenceRefs.has(ref)))) {
              run.rejectedProposalIds.push(runProposalId);
              continue;
            }
            const proposalEvidence = evidence.filter((item) => proposal.evidenceRefs.includes(item.ref));
            const outcome = await this.repository.commitKnowledgeProposal({
              proposal, evidence: proposalEvidence, runId: run.id,
            });
            if (outcome.applied) {
              run.appliedProposalIds.push(runProposalId);
              if (proposal.confidence >= 0.82) {
                if (proposal.operation === 'create' || proposal.operation === 'merge'
                  || proposal.operation === 'supersede') {
                  if (proposal.proposedPage) knowledgePageIds.add(proposal.proposedPage.id);
                }
                if (proposal.operation === 'merge' || proposal.operation === 'supersede'
                  || proposal.operation === 'deprecate') {
                  for (const targetId of proposal.targetPageIds) knowledgePageIds.delete(targetId);
                }
              }
            } else {
              run.rejectedProposalIds.push(runProposalId);
            }
          }
        }

        run.processedRecordIds.push(...result.processedRecordIds);
        if (result.processedRecordIds.length) {
          await this.repository.markExperiencesReviewed({
            scope, ids: result.processedRecordIds, reviewedAt: new Date().toISOString(),
          });
        }
        const processedIds = new Set(result.processedRecordIds);
        let contiguousSequence = afterSequence;
        for (const experience of experiences) {
          // Re-review records at or before the checkpoint must not block ingestion
          // of newer experiences; they are maintenance work, not checkpoint gaps.
          if (experience.sequence <= afterSequence) continue;
          if (!processedIds.has(experience.id)) break;
          contiguousSequence = experience.sequence;
        }
        if (contiguousSequence > afterSequence) {
          afterSequence = contiguousSequence;
          run.toSequence = Math.max(run.toSequence, afterSequence);
          await this.repository.saveCheckpoint({
            scope, afterSequence, lastRunAt: new Date().toISOString(), lastRunId: run.id,
          });
        }
        if (!page.hasMore || result.processedRecordIds.length === 0) break;
      }

      run.status = 'completed';
      run.finishedAt = new Date().toISOString();
      run.model = lastModel;
      run.usage = lastUsage;
      await this.repository.updateRun(run);
      await this.emitRun(run);
      return run;
    } catch (error) {
      if (run) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        run.finishedAt = new Date().toISOString();
        await this.repository.updateRun(run);
        await this.emitRun(run);
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (renewal) await renewal;
      await this.repository.releaseLease({ scope, owner: this.owner });
    }
  }
}
