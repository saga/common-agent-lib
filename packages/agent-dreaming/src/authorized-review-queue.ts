import type { DreamingReviewQueue, DreamingReviewQueueItem } from './types.js';
import {
  assertDreamingAuthorized,
  type DreamingActor,
  type DreamingAuthorizationPolicy,
} from './authorization.js';

/** Review facade that requires an authenticated actor for every read or decision. */
export class AuthorizedDreamingReviewQueue {
  constructor(
    private readonly queue: DreamingReviewQueue,
    private readonly policy: DreamingAuthorizationPolicy,
  ) {}

  async list(input: {
    actor: DreamingActor;
    scope: string;
    status?: DreamingReviewQueueItem['status'];
    limit?: number;
  }): Promise<DreamingReviewQueueItem[]> {
    await assertDreamingAuthorized(this.policy, {
      actor: input.actor, scope: input.scope, action: 'review:read',
    });
    return this.queue.listReviewQueue({
      scope: input.scope,
      ...(input.status ? { status: input.status } : {}),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
  }

  async resolve(input: {
    actor: DreamingActor;
    scope: string;
    proposalId: string;
    decision: 'approve' | 'reject';
  }): Promise<DreamingReviewQueueItem['status']> {
    await assertDreamingAuthorized(this.policy, {
      actor: input.actor,
      scope: input.scope,
      action: 'review:resolve',
      resourceId: input.proposalId,
    });
    return this.queue.resolveReview({
      scope: input.scope,
      proposalId: input.proposalId,
      decision: input.decision,
      reviewedBy: input.actor.subject,
    });
  }
}
