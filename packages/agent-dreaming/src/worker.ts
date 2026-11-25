import type { DreamingEngine } from './engine.js';
import type { SqliteDreamingScheduler } from './scheduler.js';

export interface DreamingWorkerOptions {
  workerId: string;
  scopes: readonly string[];
  pollIntervalMs?: number;
  batchSize?: number;
  onError?: (error: unknown, scope: string) => void | Promise<void>;
}

/**
 * Polls the durable SQLite schedule and invokes the engine.
 * The job lease is the recovery mechanism; the engine's scope lease is a second
 * guard against overlapping work from manual and scheduled triggers.
 */
export class DreamingWorker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private active?: Promise<void>;

  constructor(
    private readonly engine: DreamingEngine,
    private readonly scheduler: SqliteDreamingScheduler,
    private readonly options: DreamingWorkerOptions,
  ) {
    if (!options.workerId.trim()) throw new TypeError('workerId is required.');
    if (!options.scopes.length || options.scopes.some((scope) => !scope.trim())) {
      throw new TypeError('At least one non-empty scope is required.');
    }
    if (new Set(options.scopes).size !== options.scopes.length) throw new TypeError('Scopes must be unique.');
  }

  /** Idempotently create recurring jobs and start polling. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const scope of this.options.scopes) {
      this.scheduler.schedule({
        id: `dream:${scope}`,
        scope,
        intervalMs: this.options.pollIntervalMs ?? 15 * 60_000,
      });
    }
    void this.tick();
  }

  async runOnce(): Promise<number> {
    const jobs = this.scheduler.claim(this.options.workerId, this.options.batchSize ?? 10);
    let completed = 0;
    for (const job of jobs) {
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        if (!this.scheduler.renew({ id: job.id, owner: this.options.workerId })) {
          controller.abort(new Error('Durable scheduler lease was lost.'));
        }
      }, this.scheduler.heartbeatIntervalMs);
      heartbeat.unref?.();
      try {
        await this.engine.runNow(job.scope, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (this.scheduler.complete({ id: job.id, owner: this.options.workerId })) completed += 1;
      } catch (error) {
        this.scheduler.fail({ id: job.id, owner: this.options.workerId, error });
        try { await this.options.onError?.(error, job.scope); } catch { /* Observer errors do not affect job state. */ }
      } finally {
        clearInterval(heartbeat);
      }
    }
    return completed;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.active;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    this.active = this.runOnce().then(() => undefined).catch(async (error) => {
      try { await this.options.onError?.(error, '*'); } catch { /* Preserve worker liveness. */ }
    });
    await this.active;
    this.active = undefined;
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.tick(); }, 1_000);
    this.timer.unref?.();
  }
}
