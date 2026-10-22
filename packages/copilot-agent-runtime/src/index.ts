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

/**
 * Application-owned Copilot session callbacks. This exposes the SDK hook seam without
 * imposing a shared allow/deny or OAuth policy on every host application.
 *
 * Apply the selected callbacks to both createSession and resumeSession config objects.
 */
export interface CopilotSessionPolicy {
  onPermissionRequest?: CopilotCreateSessionConfig["onPermissionRequest"];
  onMcpAuthRequest?: CopilotCreateSessionConfig["onMcpAuthRequest"];
}

/** Per-model usage delta, normalized across Copilot SDK metric/event shapes. */
export interface CopilotModelUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalNanoAiu?: number;
  totalPremiumRequestCost?: number;
}

/** Incremental usage for one logical turn. Cost fields retain Copilot's units; they are not USD. */
export interface CopilotUsageDelta {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalNanoAiu?: number;
  totalPremiumRequestCost?: number;
  modelCalls?: number;
  source?: "provider-event" | "session-metrics" | "unknown";
  models?: Record<string, CopilotModelUsageDelta>;
}

/** Provider-reported metrics for one assistant.usage event. */
export interface CopilotModelCallUsage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalNanoAiu?: number;
  premiumRequestCost?: number;
  durationMs?: number;
  finishReason?: string;
  reasoningEffort?: string;
  timeToFirstTokenMs?: number;
  interTokenLatencyMs?: number;
}

/** Snapshot of current context-window occupancy, distinct from tokens consumed in a turn. */
export interface CopilotContextUsage {
  currentTokens?: number;
  tokenLimit?: number;
  messagesLength?: number;
  percent?: number;
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
  const result: CopilotUsageDelta = { source: "session-metrics" };
  const totalFields: Array<[keyof CopilotUsageDelta, string]> = [
    ["totalNanoAiu", "totalNanoAiu"],
    ["totalPremiumRequestCost", "totalPremiumRequestCost"],
    ["inputTokens", "inputTokens"],
    ["outputTokens", "outputTokens"],
    ["totalTokens", "totalTokens"],
    ["cachedInputTokens", "cacheReadTokens"],
    ["cacheWriteTokens", "cacheWriteTokens"],
    ["reasoningTokens", "reasoningTokens"],
  ];
  for (const [target, source] of totalFields) {
    const value = numericDelta(after[source], before?.[source]);
    if (value !== undefined) (result as Record<string, unknown>)[target] = value;
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
      const fields: Array<[keyof CopilotModelUsageDelta, string]> = [
        ["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"],
        ["cachedInputTokens", "cacheReadTokens"], ["cacheWriteTokens", "cacheWriteTokens"],
        ["reasoningTokens", "reasoningTokens"], ["totalPremiumRequestCost", "totalPremiumRequestCost"],
      ];
      for (const [target, source] of fields) {
        const value = numericDelta(afterUsage[source], beforeUsage[source]);
        if (value !== undefined) (modelDiff as Record<string, unknown>)[target] = value;
      }
      const aiu = numericDelta(afterModel.totalNanoAiu, beforeModelObject.totalNanoAiu);
      if (aiu !== undefined) modelDiff.totalNanoAiu = aiu;
      if (modelDiff.inputTokens !== undefined && modelDiff.outputTokens !== undefined) {
        modelDiff.totalTokens = modelDiff.inputTokens + modelDiff.outputTokens;
      }
      if (Object.keys(modelDiff).length) models[model] = modelDiff;
    }
    if (Object.keys(models).length) result.models = models;
  }

  return Object.keys(result).some((key) => key !== "source") ? result : undefined;
}

/** Normalize one provider event without estimating absent token counters. */
export function normalizeCopilotModelCallUsage(value: unknown): CopilotModelCallUsage | undefined {
  const data = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const result: CopilotModelCallUsage = {};
  const fields: Array<[keyof CopilotModelCallUsage, string]> = [
    ["inputTokens", "inputTokens"], ["outputTokens", "outputTokens"], ["totalTokens", "totalTokens"],
    ["cachedInputTokens", "cacheReadTokens"], ["cacheWriteTokens", "cacheWriteTokens"],
    ["reasoningTokens", "reasoningTokens"], ["totalNanoAiu", "totalNanoAiu"],
    ["premiumRequestCost", "cost"], ["durationMs", "duration"],
    ["timeToFirstTokenMs", "timeToFirstTokenMs"], ["interTokenLatencyMs", "interTokenLatencyMs"],
  ];
  for (const [target, source] of fields) {
    const amount = data[source];
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
      (result as Record<string, unknown>)[target] = amount;
    }
  }
  for (const key of ["model", "finishReason", "reasoningEffort"] as const) {
    const text = data[key];
    if (typeof text === "string" && text.length) result[key] = text;
  }
  if (result.totalTokens === undefined && result.inputTokens !== undefined && result.outputTokens !== undefined) {
    result.totalTokens = result.inputTokens + result.outputTokens;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Aggregate usage events for a turn, retaining per-model counters. */
export function aggregateCopilotModelCallUsages(usages: readonly CopilotModelCallUsage[]): CopilotUsageDelta | undefined {
  if (!usages.length) return undefined;
  const result: CopilotUsageDelta = { source: "provider-event", modelCalls: usages.length };
  const models: Record<string, CopilotModelUsageDelta> = {};
  const totalFields = [
    "inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteTokens", "reasoningTokens", "totalNanoAiu",
  ] as const;
  for (const item of usages) {
    for (const field of totalFields) {
      const amount = item[field];
      if (typeof amount === "number" && Number.isFinite(amount)) {
        const target = result as Record<string, unknown>;
        target[field] = ((typeof target[field] === "number" ? target[field] : 0) as number) + amount;
      }
    }
    if (typeof item.premiumRequestCost === "number") {
      result.totalPremiumRequestCost = (result.totalPremiumRequestCost ?? 0) + item.premiumRequestCost;
    }
    const model = item.model || "unknown";
    const aggregate = models[model] ?? (models[model] = {});
    for (const field of totalFields) {
      const amount = item[field];
      if (typeof amount === "number" && Number.isFinite(amount)) {
        const target = aggregate as Record<string, unknown>;
        target[field] = ((typeof target[field] === "number" ? target[field] : 0) as number) + amount;
      }
    }
    if (typeof item.premiumRequestCost === "number") {
      aggregate.totalPremiumRequestCost = (aggregate.totalPremiumRequestCost ?? 0) + item.premiumRequestCost;
    }
  }
  if (Object.keys(models).length) result.models = models;
  return result;
}

function mergeUsagePreferProviderEvents(
  eventUsage: CopilotUsageDelta | undefined,
  metricUsage: CopilotUsageDelta | undefined,
): CopilotUsageDelta | undefined {
  if (!eventUsage) return metricUsage;
  if (!metricUsage) return eventUsage;
  const models: Record<string, CopilotModelUsageDelta> = { ...(metricUsage.models ?? {}) };
  for (const [name, usage] of Object.entries(eventUsage.models ?? {})) {
    models[name] = { ...(models[name] ?? {}), ...usage };
  }
  return { ...metricUsage, ...eventUsage, models, source: "provider-event" };
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
    // Never convert an arbitrary resume failure into a new session. Doing so can
    // silently discard conversation history during auth, quota, or transport failures.
    if (isCopilotSessionNotFound(error)) return client.createSession(config);
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
  /** Incremental token / Copilot billing metrics for this logical turn when the SDK exposes them. */
  usage?: CopilotUsageDelta;
  /** One entry per assistant.usage event, including cache/reasoning counters when provided. */
  modelCallUsages?: CopilotModelCallUsage[];
  /** Most recent context occupancy snapshot emitted during this turn. */
  contextUsage?: CopilotContextUsage;
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

  /**
   * Resume with the host's reconstructed session configuration. An empty object can
   * reset model/tools/provider/working-directory/MCP settings instead of restoring the
   * original intent, so the runtime intentionally requires the caller to supply config.
   * Recompute credentials at resume time; never persist secrets with business state.
   */
  async resumeSession(
    sessionId: string,
    config: CopilotResumeSessionConfig,
  ): Promise<CopilotSessionResult> {
    const client = await this.start();
    return client.resumeSession(sessionId, config);
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
      const modelCallUsages: CopilotModelCallUsage[] = [];
      let contextUsage: CopilotContextUsage | undefined;
      const offUsage = session.on('assistant.usage', (event) => {
        const data = (event as unknown as { data?: unknown }).data;
        const usage = normalizeCopilotModelCallUsage(data);
        if (usage) modelCallUsages.push(usage);
      });
      const offUsageInfo = session.on('session.usage_info', (event) => {
        const raw = (event as unknown as { data?: unknown }).data;
        const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        const currentTokens = typeof data.currentTokens === "number" && Number.isFinite(data.currentTokens) && data.currentTokens >= 0 ? data.currentTokens : undefined;
        const tokenLimit = typeof data.tokenLimit === "number" && Number.isFinite(data.tokenLimit) && data.tokenLimit >= 0 ? data.tokenLimit : undefined;
        const messagesLength = typeof data.messagesLength === "number" && Number.isFinite(data.messagesLength) && data.messagesLength >= 0 ? data.messagesLength : undefined;
        const snapshot: CopilotContextUsage = {};
        if (currentTokens !== undefined) snapshot.currentTokens = currentTokens;
        if (tokenLimit !== undefined) snapshot.tokenLimit = tokenLimit;
        if (messagesLength !== undefined) snapshot.messagesLength = messagesLength;
        if (currentTokens !== undefined && tokenLimit !== undefined && tokenLimit > 0) {
          snapshot.percent = Math.round(currentTokens / tokenLimit * 100);
        }
        if (Object.keys(snapshot).length) contextUsage = snapshot;
      });

      try {
        const usageBefore = await getCopilotSessionUsageMetrics(session);
        if (input.model) await session.setModel(input.model);

        const send = session.sendAndWait(
          {
            prompt: input.prompt,
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          },
          input.timeoutMs ? input.timeoutMs + 1_000 : undefined,
        );

        // Do not rely solely on the SDK timeout: some SDK/tool-loop failure modes have
        // been observed to keep sendAndWait pending beyond its requested timeout.
        // The watchdog rejects the application turn; the catch below then aborts the session.
        let watchdog: NodeJS.Timeout | undefined;
        let finalEvent: Awaited<typeof send>;
        try {
          finalEvent = input.timeoutMs
            ? await Promise.race([
                send,
                new Promise<never>((_, reject) => {
                  watchdog = setTimeout(
                    () => reject(new Error(`Timeout after ${input.timeoutMs}ms waiting for session.idle`)),
                    input.timeoutMs,
                  );
                }),
              ])
            : await send;
        } finally {
          if (watchdog) clearTimeout(watchdog);
        }

        const finalContent =
          (finalEvent as unknown as { data?: { content?: string } } | undefined)?.data?.content;
        if (finalContent) content = finalContent;
        const usageAfter = await getCopilotSessionUsageMetrics(session);
        const metricUsage = diffCopilotUsageMetrics(usageAfter, usageBefore);
        const eventUsage = aggregateCopilotModelCallUsages(modelCallUsages);
        const usage = mergeUsagePreferProviderEvents(eventUsage, metricUsage);

        return {
          content, chars, timedOut,
          ...(usage ? { usage } : {}),
          ...(modelCallUsages.length ? { modelCallUsages } : {}),
          ...(contextUsage ? { contextUsage } : {})
        };
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
        offUsage();
        offUsageInfo();
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
    let abortTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        session.abort(),
        new Promise<never>((_, reject) => {
          abortTimer = setTimeout(
            () => reject(new Error('Copilot abort timed out')),
            this.abortIdleGraceMs,
          );
        }),
      ]);
    } catch {
      idle.cancel();
      throw new Error('Copilot turn 超时，且无法在限定时间内请求 Agent 停止。');
    } finally {
      if (abortTimer) clearTimeout(abortTimer);
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
