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

        return { content, chars, timedOut };
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
