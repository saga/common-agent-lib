export * from './types.js';
export { DreamingEngine } from './engine.js';
export { evaluateMemoryQuality, validateFeedbackEvent } from './quality.js';
export { parseResult, classifyProposal } from './validation.js';
export { SqliteDreamingStore } from './sqlite-store.js';
export type { SqliteDreamingOptions, AppendExperienceInput, ReviewQueueItem, ProposalReviewReason } from './sqlite-store.js';
export { CopilotDreamingRuntime } from './adapters/copilot.js';
export type {
  CopilotDreamingRuntimeOptions,
  CopilotClientLike,
  CopilotSessionLike,
} from './adapters/copilot.js';
