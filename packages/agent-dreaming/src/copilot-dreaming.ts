import type {
  DreamingEvidenceResolver,
  DreamingRepository,
  DreamingRun,
  DreamingRunInput,
  DreamingOptions,
} from './types.js';
import { DreamingEngine } from './engine.js';
import {
  CopilotDreamingRuntime,
  type CopilotDreamingRuntimeOptions,
} from './adapters/copilot.js';

export interface CopilotDreamingInstance {
  readonly engine: DreamingEngine;
  readonly runtime: CopilotDreamingRuntime;
  start(): void;
  stop(): void;
  runNow(scope: string, signal?: AbortSignal): Promise<DreamingRun | undefined>;
  notifyRecordAppended(scope: string): Promise<DreamingRun | undefined>;
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
    stop: () => engine.stop(),
    runNow: (scope, signal) => engine.runNow(scope, signal),
    notifyRecordAppended: (scope) => engine.notifyRecordAppended(scope),
    async shutdown(reason) {
      await engine.shutdown(reason);
      await runtime.close();
    },
  };
}

/** Convenience overload for a repository that also resolves its own evidence. */
export function createSqliteCopilotDreaming(
  store: DreamingRepository & DreamingEvidenceResolver & { close(): Promise<void> },
  options: DreamingOptions,
  runtimeOptions: CopilotDreamingRuntimeOptions = {},
): CopilotDreamingInstance & { store: typeof store } {
  const dreaming = createCopilotDreaming(store, store, options, runtimeOptions);
  return {
    ...dreaming,
    store,
    async shutdown(reason) {
      try {
        await dreaming.shutdown(reason);
      } finally {
        await store.close();
      }
    },
  };
}
