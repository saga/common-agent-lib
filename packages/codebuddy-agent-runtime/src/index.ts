import { existsSync, rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildCodeBuddyContextWindowOption,
  normalizeCodeBuddyContextWindow,
  type CodeBuddyContextWindowModel,
} from './context-window.js';

export {
  buildCodeBuddyContextWindowOption,
  formatCodeBuddyContextWindow,
  normalizeCodeBuddyContextWindow,
  resolveCodeBuddyContextWindow,
} from './context-window.js';
export type {
  CodeBuddyContextWindowModel,
  CodeBuddyContextWindowOption,
  NormalizedCodeBuddyContextWindow,
} from './context-window.js';

export type CodeBuddyEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type CodeBuddyThinking =
  | { type: 'disabled' }
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens?: number };

export interface CodeBuddyUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export interface CodeBuddyTaskInput {
  prompt: string;
  systemPrompt?: string;
  model?: string;
  fallbackModel?: string;
  cwd?: string;
  /**
   * Optional per-invocation context-window tier in tokens. Leave unset to retain the
   * model's configured default. When set, contextWindowModel is required so this runtime
   * can validate against supportedLengths and maxInputTokens before applying the override.
   */
  contextWindow?: number;
  contextWindowModel?: CodeBuddyContextWindowModel;
  timeoutMs?: number;
  signal?: AbortSignal;
  thinking?: CodeBuddyThinking;
  effort?: CodeBuddyEffort;
  /** JSON Schema for structured output. The SDK's StructuredOutput tool requires an object schema. */
  schema?: Record<string, unknown>;
  maxTurns?: number;
  /** Resume a prior CodeBuddy query session. This opts into session persistence unless explicitly disabled. */
  resumeSessionId?: string;
  /** Opt into the SDK's session persistence behavior for this query. Defaults to false for new one-shot tasks. */
  persistSession?: boolean;
  /** Extra SDK options such as hooks. Runtime safety defaults are applied after these values. */
  sdkOptions?: Record<string, unknown>;
  onText?: (text: string) => void;
  onEvent?: (event: unknown) => void;
  onSessionId?: (sessionId: string) => void;
}

export interface CodeBuddyTaskResult {
  text: string;
  structuredOutput?: unknown;
  usage?: CodeBuddyUsage;
  sessionId?: string;
  messageCount: number;
  durationMs: number;
}

export interface CodeBuddyQueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => unknown;
}

export interface CodeBuddyQueryInput {
  prompt: string;
  options: Record<string, unknown>;
}

export type CodeBuddyQueryFactory = (input: CodeBuddyQueryInput) => CodeBuddyQueryHandle | Promise<CodeBuddyQueryHandle>;

/** Combine instructions and task input because query() accepts a single prompt string. */
export function buildCodeBuddyPrompt(prompt: string, systemPrompt = ''): string {
  return [
    systemPrompt.trim() ? 'SYSTEM INSTRUCTIONS:\n' + systemPrompt.trim() : '',
    'USER REQUEST:\n' + prompt,
  ].filter(Boolean).join('\n\n');
}

/**
 * Build conservative defaults for application tasks. SDK filesystem settings are not loaded,
 * normal tasks have no tools, and structured-output tasks may use only StructuredOutput.
 */
export function buildCodeBuddyOptions(
  input: Pick<
    CodeBuddyTaskInput,
    'model' | 'fallbackModel' | 'cwd' | 'thinking' | 'effort' | 'schema' | 'maxTurns' | 'resumeSessionId' | 'persistSession' | 'sdkOptions'
  >,
  contextWindowSeeded = false,
): Record<string, unknown> {
  const hasSchema = Boolean(input.schema);
  const canUseTool = async (toolName: string) => {
    if (hasSchema && toolName === 'StructuredOutput') return { behavior: 'allow' as const };
    return { behavior: 'deny' as const, message: 'This CodeBuddy task does not allow tool execution: ' + toolName };
  };

  return {
    ...(input.sdkOptions ?? {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.fallbackModel ? { fallbackModel: input.fallbackModel } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    // Only the isolated temporary context-window workspace opts into project settings.
    // Normal requests keep the previous no-settings/Skills/MCP behavior.
    settingSources: contextWindowSeeded ? ['project'] : [],
    permissionMode: 'default',
    persistSession: input.persistSession ?? Boolean(input.resumeSessionId),
    ...(input.resumeSessionId ? { resume: input.resumeSessionId } : {}),
    thinking: input.thinking ?? (hasSchema ? { type: 'adaptive' } : { type: 'disabled' }),
    effort: input.effort ?? (hasSchema ? 'medium' : 'low'),
    tools: hasSchema ? ['StructuredOutput'] : [],
    allowedTools: hasSchema ? ['StructuredOutput'] : [],
    maxTurns: input.maxTurns ?? (hasSchema ? 5 : 1),
    canUseTool,
    ...(hasSchema ? {
      outputFormat: { type: 'json_schema', schema: input.schema },
      // CodeBuddy CLI currently needs the native schema flag for constrained JSON output.
      extraArgs: { 'json-schema': JSON.stringify(input.schema) },
    } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveCount(value: unknown): number | undefined {
  const parsed = nonNegativeNumber(value);
  return parsed !== undefined && parsed > 0 ? Math.round(parsed) : undefined;
}

/** Normalize the SDK result usage without inventing unavailable cost data. */
export function parseCodeBuddyUsage(result: unknown): CodeBuddyUsage | undefined {
  const raw = asRecord(result);
  const usage = asRecord(raw.usage);
  if (!raw.usage || typeof raw.usage !== 'object') return undefined;

  const inputTokens = positiveCount(usage.input_tokens) ?? 0;
  const outputTokens = positiveCount(usage.output_tokens) ?? 0;
  const cacheReadTokens = positiveCount(usage.cache_read_input_tokens) ?? 0;
  const cacheCreationTokens = positiveCount(usage.cache_creation_input_tokens) ?? 0;
  if (inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens === 0) return undefined;

  const totalCostUsd = nonNegativeNumber(raw.total_cost_usd);
  const durationMs = nonNegativeNumber(raw.duration_ms);
  const numTurns = positiveCount(raw.num_turns);
  const totalInput = inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: totalInput + outputTokens,
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
  };
}

function extractText(message: Record<string, unknown>): string[] {
  if (message.type !== 'assistant') return [];
  const body = asRecord(message.message);
  if (!Array.isArray(body.content)) return [];
  return body.content.flatMap((part) => {
    const block = asRecord(part);
    return block.type === 'text' && typeof block.text === 'string' && block.text.length > 0
      ? [block.text]
      : [];
  });
}

function readSessionId(message: Record<string, unknown>): string | undefined {
  const body = asRecord(message.message);
  const session = asRecord(message.session);
  const candidates = [message.session_id, message.sessionId, session.id, body.session_id];
  return candidates.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function parseJsonText(text: string): unknown | undefined {
  const trimmed = text.trim();
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    : trimmed;
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    return undefined;
  }
}

export function resolveCodeBuddyStructuredOutput(structuredOutput: unknown, text: string): unknown {
  if (structuredOutput !== undefined && structuredOutput !== null) return structuredOutput;
  return parseJsonText(text);
}

export class CodeBuddyTaskError extends Error {
  readonly code: 'timeout' | 'aborted' | 'sdk-error';

  constructor(code: CodeBuddyTaskError['code'], message: string) {
    super(message);
    this.name = 'CodeBuddyTaskError';
    this.code = code;
  }
}

async function defaultQueryFactory(input: CodeBuddyQueryInput): Promise<CodeBuddyQueryHandle> {
  const sdk = await import('@tencent-ai/agent-sdk');
  return sdk.query(input as Parameters<typeof sdk.query>[0]) as unknown as CodeBuddyQueryHandle;
}

/**
 * A small runtime adapter for text and schema-constrained CodeBuddy tasks.
 * It owns prompt/options defaults, event consumption, timeout/abort and usage normalization;
 * application workflow, persistence, authorization and final schema validation remain outside.
 */
function createContextWindowSeedWorkspace(
  contextWindow: number,
  sourceCwd: string,
): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), 'saga-codebuddy-context-window-'));
  try {
    const configDir = join(cwd, '.codebuddy');
    mkdirSync(configDir, { recursive: true });
    // Preserve only project model definitions so the temporary cwd resolves the same model.
    // models.json may contain credentials, so the temporary copy is owner-readable only.
    const sourceModels = join(resolve(sourceCwd), '.codebuddy', 'models.json');
    if (existsSync(sourceModels)) {
      writeFileSync(join(configDir, 'models.json'), readFileSync(sourceModels), { mode: 0o600 });
    }
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({ contextWindow }, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch (error) {
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

export class CodeBuddyAgentRuntime {
  constructor(private readonly queryFactory: CodeBuddyQueryFactory = defaultQueryFactory) {}

  async run(input: CodeBuddyTaskInput): Promise<CodeBuddyTaskResult> {
    if (!input.prompt.trim()) throw new TypeError('CodeBuddy prompt must not be empty');
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0)) {
      throw new TypeError('timeoutMs must be a positive finite number');
    }
    if (input.schema && input.schema.type !== 'object') {
      throw new TypeError('CodeBuddy structured output schema must have type: "object"');
    }
    if (input.signal?.aborted) throw new CodeBuddyTaskError('aborted', 'CodeBuddy task was aborted before it started');
    if (input.resumeSessionId !== undefined && !input.resumeSessionId.trim()) {
      throw new TypeError('resumeSessionId must be a non-empty session ID');
    }
    if (input.resumeSessionId && input.persistSession === false) {
      throw new TypeError('resumeSessionId requires persistSession to remain enabled');
    }
    if (input.resumeSessionId && input.contextWindow !== undefined) {
      throw new TypeError('resuming a CodeBuddy session with a contextWindow override is not supported by this adapter');
    }

    // CodeBuddy Agent SDK query() does not expose contextWindow as an SDK option.
    // For explicit opt-in only, use CodeBuddy's documented settings.json seed in an
    // isolated temporary project directory. The no-override path stays byte-for-byte
    // equivalent in behavior and never loads host-level settings.
    let contextWorkspace: { cwd: string; cleanup: () => void } | undefined;
    if (input.contextWindow !== undefined) {
      const capability = normalizeCodeBuddyContextWindow(input.contextWindowModel);
      if (!capability || !capability.supportedLengths.includes(input.contextWindow)) {
        throw new TypeError('contextWindow is not a supported tier for the selected CodeBuddy model');
      }
      contextWorkspace = createContextWindowSeedWorkspace(input.contextWindow, input.cwd ?? process.cwd());
    }

    try {
      const startedAt = Date.now();
      const prompt = buildCodeBuddyPrompt(input.prompt, input.systemPrompt);
      const options = buildCodeBuddyOptions({
        ...input,
        cwd: contextWorkspace?.cwd ?? input.cwd,
      }, Boolean(contextWorkspace));
      // The timeout covers SDK import/query initialization as well as message consumption.
      // A query factory can be async even though the SDK's query() itself returns a handle.
      let query: CodeBuddyQueryHandle | undefined;
      let interruptionKind: 'timeout' | 'aborted' | undefined;
      let rejectInterruption!: (error: CodeBuddyTaskError) => void;
      const interruption = new Promise<never>((_resolve, reject) => {
        rejectInterruption = reject;
      });
      let interruptRequested = false;
      const requestInterrupt = (): void => {
        if (!query || interruptRequested) return;
        interruptRequested = true;
        try {
          void Promise.resolve(query.interrupt?.()).catch(() => undefined);
        } catch {
          // Keep the timeout/abort outcome authoritative even if interrupt throws synchronously.
        }
      };
      const triggerInterruption = (kind: 'timeout' | 'aborted'): void => {
        if (interruptionKind) return;
        interruptionKind = kind;
        requestInterrupt();
        rejectInterruption(new CodeBuddyTaskError(
          kind,
          kind === 'timeout'
            ? 'CodeBuddy task timed out after ' + input.timeoutMs + 'ms; interruption was requested but process shutdown is not confirmed'
            : 'CodeBuddy task was aborted; interruption was requested but process shutdown is not confirmed',
        ));
      };

      let timeout: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;
      if (input.timeoutMs !== undefined) {
        timeout = setTimeout(() => triggerInterruption('timeout'), input.timeoutMs);
      }
      if (input.signal) {
        abortListener = () => triggerInterruption('aborted');
        input.signal.addEventListener('abort', abortListener, { once: true });
        // Close the race between the initial preflight check and listener registration.
        if (input.signal.aborted) abortListener();
      }

      // If startup settles after timeout/abort already returned to the caller, still
      // request interruption as soon as the SDK handle becomes available.
      const queryPromise = Promise.resolve()
        .then(() => this.queryFactory({ prompt, options }))
        .then((created) => {
          query = created;
          if (interruptionKind) requestInterrupt();
          return created;
        });

      let text = '';
      let structuredOutput: unknown;
      let usage: CodeBuddyUsage | undefined;
      let sessionId: string | undefined;
      let messageCount = 0;
      let iterator: AsyncIterator<unknown> | undefined;

      try {
        const createdQuery = await Promise.race([queryPromise, interruption]);
        if (interruptionKind) requestInterrupt();
        iterator = createdQuery[Symbol.asyncIterator]();

        const consumption = (async () => {
          try {
            for (;;) {
              // Race each pending iterator read against timeout/abort. Some SDK versions
              // keep next() pending even after interrupt(), so a plain for-await loop can
              // continue running after the request has already timed out.
              const next = await Promise.race([iterator!.next(), interruption]);
              if (next.done) break;

              messageCount += 1;
              const event = asRecord(next.value);
              input.onEvent?.(next.value);

              const foundSessionId = readSessionId(event);
              if (foundSessionId && foundSessionId !== sessionId) {
                sessionId = foundSessionId;
                input.onSessionId?.(foundSessionId);
              }

              for (const chunk of extractText(event)) {
                text += (text ? '\n' : '') + chunk;
                input.onText?.(chunk);
              }

              if (event.type === 'result') {
                if (event.is_error === true || (Array.isArray(event.errors) && event.errors.length > 0)) {
                  throw new Error('CodeBuddy execution failed: ' + String((event.errors as unknown[] | undefined)?.[0] ?? 'unknown error'));
                }
                if (typeof event.subtype === 'string' && event.subtype !== 'success') {
                  throw new Error('CodeBuddy execution failed: ' + event.subtype);
                }
                if ('structured_output' in event) structuredOutput = event.structured_output;
                usage = parseCodeBuddyUsage(event);
              }
            }
          } finally {
            // Stop local consumption promptly. This is separate from process shutdown:
            // the SDK's interrupt() is best effort and may not close a wedged iterator.
            if (interruptionKind && iterator?.return) {
              void Promise.resolve(iterator.return()).catch(() => undefined);
            }
          }
        })();

        await Promise.race([consumption, interruption]);
      } catch (error) {
        if (error instanceof CodeBuddyTaskError) throw error;
        // Stream/callback failures must not leave an SDK query running in the background.
        requestInterrupt();
        if (iterator?.return) void Promise.resolve(iterator.return()).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        throw new CodeBuddyTaskError('sdk-error', 'CodeBuddy Agent SDK call failed: ' + message);
      } finally {
        if (timeout) clearTimeout(timeout);
        if (abortListener && input.signal) input.signal.removeEventListener('abort', abortListener);
      }

      const resolvedStructuredOutput = resolveCodeBuddyStructuredOutput(structuredOutput, text);
      return {
        text: text.trim(),
        ...(resolvedStructuredOutput !== undefined ? { structuredOutput: resolvedStructuredOutput } : {}),
        ...(usage ? { usage } : {}),
        ...(sessionId ? { sessionId } : {}),
        messageCount,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      contextWorkspace?.cleanup();
    }
  }
}
