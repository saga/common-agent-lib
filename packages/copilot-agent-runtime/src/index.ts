import {
  CopilotClient,
  type CopilotSession,
} from '@github/copilot-sdk';

export type CopilotCreateSessionConfig =
  Parameters<CopilotClient['createSession']>[0];

export type CopilotResumeSessionConfig =
  Parameters<CopilotClient['resumeSession']>[1];

export type CopilotSessionResult =
  Awaited<ReturnType<CopilotClient['createSession']>>;

/** Per-model usage collected for one logical turn from Copilot session metrics. */
export interface CopilotModelUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  totalNanoAiu?: number;
}

/** Difference between two cumulative Copilot session usage snapshots. */
export interface CopilotUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalNanoAiu?: number;
  totalPremiumRequestCost?: number;
  models?: Record<string, CopilotModelUsageDelta>;
}

const COPILOT_SESSION_NOT_FOUND = /session not found|no such session|unknown session|does not exist|has been deleted/i;

/** Copilot SDK sometimes returns a plain Error for a missing resumable session. */
export function isCopilotSessionNotFound(error: unknown): boolean {
  return error instanceof Error && COPILOT_SESSION_NOT_FOUND.test(error.message);
}

/** Read cumulative usage without making session.usage a hard compile-time dependency on SDK typings. */
export async function getCopilotSessionUsageMetrics(
  session: CopilotSession,
): Promise<Record<string, unknown> | undefined> {
  try {
    const usage = (session as unknown as { usage?: { getMetrics?: () => Promise<unknown> } }).usage;
    if (!usage?.getMetrics) return undefined;
    const metrics = await usage.getMetrics();
    return metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function numericDelta(after: unknown, before: unknown): number | undefined {
  if (typeof after !== 'number' || !Number.isFinite(after)) return undefined;
  if (typeof before !== 'number' || !Number.isFinite(before)) return undefined;
  return Math.max(0, after - before);
}

/** Convert cumulative Copilot usage metrics into the incremental usage of one turn. */
export function diffCopilotUsageMetrics(
  after: Record<string, unknown> | undefined,
  before: Record<string, unknown> | undefined,
): CopilotUsageDelta | undefined {
  if (!after) return undefined;
  const result: CopilotUsageDelta = {};
  for (const field of ['totalNanoAiu', 'totalPremiumRequestCost', 'inputTokens', 'outputTokens', 'totalTokens'] as const) {
    const value = numericDelta(after[field], before?.[field]);
    if (value !== undefined) result[field] = value;
  }

  const afterModels = after.modelMetrics;
  const beforeModels = before?.modelMetrics;
  if (afterModels && typeof afterModels === 'object') {
    const models: Record<string, CopilotModelUsageDelta> = {};
    for (const [model, raw] of Object.entries(afterModels as Record<string, unknown>)) {
      const afterModel = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      const beforeModel = beforeModels && typeof beforeModels === 'object'
        ? (beforeModels as Record<string, unknown>)[model]
        : undefined;
      const beforeModelObject = beforeModel && typeof beforeModel === 'object'
        ? beforeModel as Record<string, unknown>
        : {};
      const afterUsage = afterModel.usage && typeof afterModel.usage === 'object'
        ? afterModel.usage as Record<string, unknown>
        : {};
      const beforeUsage = beforeModelObject.usage && typeof beforeModelObject.usage === 'object'
        ? beforeModelObject.usage as Record<string, unknown>
        : {};
      const modelDiff: CopilotModelUsageDelta = {};
      for (const field of ['inputTokens', 'outputTokens'] as const) {
        const value = numericDelta(afterUsage[field], beforeUsage[field]);
        if (value !== undefined) modelDiff[field] = value;
      }
      const aiu = numericDelta(afterModel.totalNanoAiu, beforeModelObject.totalNanoAiu);
      if (aiu !== undefined) modelDiff.totalNanoAiu = aiu;
      if (Object.keys(modelDiff).length) models[model] = modelDiff;
    }
    if (Object.keys(models).length) result.models = models;
  }

  return Object.keys(result).length ? result : undefined;
}

/**
 * Resume an existing session when possible and transparently create a new one when the
 * persisted SDK session has disappeared. The application still owns whether the new session
 * is semantically safe to use for its business state.
 */
export async function resumeOrCreateCopilotSession(
  client: CopilotClient,
  sessionId: string,
  config: CopilotCreateSessionConfig,
): Promise<CopilotSessionResult> {
  try {
    return await client.resumeSession(sessionId, config as CopilotResumeSessionConfig);
  } catch (error) {
    if (isCopilotSessionNotFound(error)) return client.createSession(config);
    try {
      if ((await client.getSessionMetadata(sessionId)) === undefined) return client.createSession(config);
    } catch {
      // Preserve the original resume error when metadata lookup also fails.
    }
    throw error;
  }
}
export interface CopilotTurnHandlers {
  onDelta?: (delta: string) => void;
  /** 可选的用户可见 reasoning 增量；是否展示/持久化由宿主应用决定。 */
  onReasoningDelta?: (delta: string) => void;
  onMessage?: (content: string) => void;
  onEvent?: (event: unknown) => void;
}

export interface CopilotRunTurnInput {
  turnId: string;
  lockKey: string;
  session: CopilotSession;
  prompt: string;
  model?: string;
  timeoutMs?: number;
  handlers?: CopilotTurnHandlers;
  attachments?: Array<{
    type: 'file';
    path: string;
    displayName?: string;
  }>;
}

export interface CopilotTurnResult {
  content: string;
  chars: number;
  timedOut: boolean;
  /** Incremental token / Copilot AI-credit usage for this logical turn when SDK metrics are available. */
  usage?: CopilotUsageDelta;
}

export interface CopilotAgentRuntimeOptions {
  createClient?: () => CopilotClient;
  abortIdleGraceMs?: number;
}

/**
 * 只负责 Copilot SDK 的生命周期和一次 turn 的可靠执行。
 *
 * 业务层应该把 Member / Team / Conversation / Execution 放在外面。
 * 这样这个包可以被不同 Agent 应用复用，也不会把业务数据模型倒灌进 runtime。
 */
export class CopilotAgentRuntime {
  private client: CopilotClient | null = null;
  private starting: Promise<CopilotClient> | null = null;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, CopilotSession>();
  private lastErrorMessage: string | null = null;
  private readonly abortIdleGraceMs: number;
  private readonly createClient: () => CopilotClient;

  constructor(options: CopilotAgentRuntimeOptions = {}) {
    this.abortIdleGraceMs = options.abortIdleGraceMs ?? 10_000;
    this.createClient = options.createClient ?? (() => new CopilotClient());
  }

  async start(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      const client = this.createClient();
      await client.start();
      this.client = client;
      this.lastErrorMessage = null;
      return client;
    })()
      .catch((error) => {
        this.starting = null;
        this.lastErrorMessage = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .then((client) => {
        this.starting = null;
        return client;
      });

    return this.starting;
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.starting = null;
    this.activeTurns.clear();
    this.locks.clear();
    if (!client) return;
    await client.stop();
  }

  status(): 'idle' | 'starting' | 'ready' | 'error' {
    if (this.client) return 'ready';
    if (this.starting) return 'starting';
    if (this.lastErrorMessage) return 'error';
    return 'idle';
  }

  lastError(): string | null {
    return this.lastErrorMessage;
  }

  activeTurnCount(): number {
    return this.activeTurns.size;
  }

  async createSession(
    config: CopilotCreateSessionConfig,
  ): Promise<CopilotSessionResult> {
    const client = await this.start();
    return client.createSession(config);
  }

  async resumeSession(
    sessionId: string,
    config?: CopilotResumeSessionConfig,
  ): Promise<CopilotSessionResult> {
    const client = await this.start();
    return client.resumeSession(sessionId, config ?? {});
  }

  async deleteSession(sessionId: string): Promise<void> {
    const client = await this.start();
    await client.deleteSession(sessionId);
  }

  /**
   * 运行一次 turn：
   * - 绑定 SDK event listeners
   * - 可选切换模型
   * - 对同一 lockKey 串行
   * - timeout 后显式 abort
   * - abort 后等待 idle，避免出现“业务结束但模型还在运行”
   */
  async runTurn(input: CopilotRunTurnInput): Promise<CopilotTurnResult> {
    return this.withLock(input.lockKey, async () => {
      const session = input.session;
      this.activeTurns.set(input.turnId, session);

      let chars = 0;
      let content = '';
      let timedOut = false;

      const offDelta = session.on('assistant.message_delta', (event) => {
        const delta = (event as unknown as { data?: { deltaContent?: string } }).data?.deltaContent;
        if (!delta) return;
        chars += delta.length;
        content += delta;
        input.handlers?.onDelta?.(delta);
      });

      const offMessage = session.on('assistant.message', (event) => {
        const full = (event as unknown as { data?: { content?: string } }).data?.content;
        if (full) input.handlers?.onMessage?.(full);
      });

      const offReasoning = session.on('assistant.reasoning_delta', (event) => {
        const delta = (event as unknown as { data?: { deltaContent?: string } }).data?.deltaContent;
        if (delta) input.handlers?.onReasoningDelta?.(delta);
      });

      const offAll = session.on((event) => {
        input.handlers?.onEvent?.(event);
      });

      try {
        const usageBefore = await getCopilotSessionUsageMetrics(session);
        if (input.model) await session.setModel(input.model);

        const finalEvent = await session.sendAndWait(
          {
            prompt: input.prompt,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          },
          input.timeoutMs,
        );

        const finalContent =
          (finalEvent as unknown as { data?: { content?: string } } | undefined)?.data?.content;
        if (finalContent) content = finalContent;
        const usageAfter = await getCopilotSessionUsageMetrics(session);
        const usage = diffCopilotUsageMetrics(usageAfter, usageBefore);

        return { content, chars, timedOut, ...(usage ? { usage } : {}) };
      } catch (error) {
        if (input.timeoutMs && isCopilotWaitTimeout(error)) {
          timedOut = true;
          await this.abortAndWaitIdle(session);
        }
        throw error;
      } finally {
        offDelta();
        offMessage();
        offReasoning();
        offAll();
        this.activeTurns.delete(input.turnId);
      }
    });
  }

  async cancelTurn(turnId: string): Promise<CopilotCancelResult> {
    const session = this.activeTurns.get(turnId);
    if (!session) return { found: false, aborted: false, idle: false };

    const idle = this.watchIdle(session, this.abortIdleGraceMs);
    try {
      await session.abort();
    } catch {
      idle.cancel();
      return { found: true, aborted: false, idle: false };
    }

    return { found: true, aborted: true, idle: await idle.promise };
  }

  private async abortAndWaitIdle(session: CopilotSession): Promise<void> {
    const idle = this.watchIdle(session, this.abortIdleGraceMs);
    try {
      await session.abort();
    } catch {
      idle.cancel();
      throw new Error('Copilot turn 超时，且无法请求 Agent 停止。');
    }

    if (!(await idle.promise)) {
      throw new Error('Copilot turn 已请求停止，但在等待时间内没有观察到 session.idle。');
    }
  }

  private watchIdle(
    session: CopilotSession,
    timeoutMs: number,
  ): { promise: Promise<boolean>; cancel: () => void } {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let off = () => {};

    const promise = new Promise<boolean>((resolve) => {
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        off();
        resolve(value);
      };

      off = session.on('session.idle', () => finish(true));
      timer = setTimeout(() => finish(false), timeoutMs);
    });

    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        off();
      },
    };
  }

  private async withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);

    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

export interface CopilotCancelResult {
  found: boolean;
  aborted: boolean;
  idle: boolean;
}

export function isCopilotWaitTimeout(error: unknown): boolean {
  return error instanceof Error &&
    /^Timeout after \d+ms waiting for session\.idle$/.test(error.message);
}
