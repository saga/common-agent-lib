import type {
  DreamingEvidenceResolver,
  DreamingRepository,
  DreamingRun,
  DreamingRunInput,
  DreamingOptions,
  DreamingUserMessageInput,
  DreamingMemory,
  ParsedDreamingUserDirective,
} from './types.js';
import { DreamingEngine } from './engine.js';
import { DreamingWorker } from './worker.js';
import { createId } from './utils.js';
import {
  CopilotDreamingRuntime,
  type CopilotDreamingRuntimeOptions,
} from './adapters/copilot.js';

export interface CopilotDreamingInstance {
  readonly engine: DreamingEngine;
  readonly runtime: CopilotDreamingRuntime;
  readonly worker?: DreamingWorker;
  start(): void;
  stop(): Promise<void>;
  runNow(scope: string, signal?: AbortSignal): Promise<DreamingRun | undefined>;
  notifyRecordAppended(scope: string): Promise<DreamingRun | undefined>;
  applyUserMessage(input: DreamingUserMessageInput): Promise<{
    directive: ParsedDreamingUserDirective;
    memory: DreamingMemory;
  } | undefined>;
  shutdown(reason?: unknown): Promise<void>;
}

/**
 * Ready-to-use Dreaming composition. This is the shortest path for applications
 * using the built-in Copilot SDK adapter; no Agent runtime wrapper is required.
 */
export function createCopilotDreaming(
  repository: DreamingRepository,
  evidenceResolver: DreamingEvidenceResolver,
  options: DreamingOptions,
  runtimeOptions: CopilotDreamingRuntimeOptions = {},
): CopilotDreamingInstance {
  const runtime = new CopilotDreamingRuntime(runtimeOptions);
  const engine = new DreamingEngine(runtime, repository, evidenceResolver, options);
  return {
    engine,
    runtime,
    start: () => engine.start(),
    async stop() { engine.stop(); },
    runNow: (scope, signal) => engine.runNow(scope, signal),
    notifyRecordAppended: (scope) => engine.notifyRecordAppended(scope),
    applyUserMessage: (input) => engine.applyUserMessage(input),
    async shutdown(reason) {
      await engine.shutdown(reason);
      await runtime.close();
    },
  };
}

/** Convenience overload for a repository that also resolves its own evidence. */
export function createSqliteCopilotDreaming(
  store: DreamingRepository & DreamingEvidenceResolver & {
    close(): Promise<void>;
    createScheduler(options?: import('./scheduler.js').DurableSchedulerOptions): import('./scheduler.js').SqliteDreamingScheduler;
  },
  options: DreamingOptions,
  runtimeOptions: CopilotDreamingRuntimeOptions = {},
): CopilotDreamingInstance & { store: typeof store } {
  const dreaming = createCopilotDreaming(store, store, options, runtimeOptions);
  const scheduler = store.createScheduler();
  let started = false;
  const worker = new DreamingWorker(dreaming.engine, scheduler, {
    workerId: createId('dreaming-worker'),
    scopes: options.scopes,
    pollIntervalMs: options.intervalMs ?? 15 * 60_000,
    onError: options.onError,
  });
  return {
    ...dreaming,
    store,
    worker,
    start() { started = true; worker.start(); },
    async stop() {
      started = false;
      await worker.stop();
      dreaming.engine.stop();
    },
    notifyRecordAppended(scope) {
      return started ? dreaming.engine.runNow(scope, undefined) : Promise.resolve(undefined);
    },
    async shutdown(reason) {
      try {
        await dreaming.engine.shutdown(reason);
        await worker.stop();
        await dreaming.runtime.close();
      } finally {
        await store.close();
      }
    },
  };
}
