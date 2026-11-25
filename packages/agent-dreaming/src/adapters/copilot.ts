import type {
  DreamingRuntime,
  DreamingRuntimeRequest,
  DreamingRuntimeResponse,
} from '../types.js';

export interface CopilotSessionLike {
  sendAndWait(
    options: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ data?: { content?: string; model?: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  on?(eventType: string, handler: (event: unknown) => void): () => void;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  createSession(config: Record<string, unknown>): Promise<CopilotSessionLike>;
}

export interface CopilotSdkModuleLike {
  CopilotClient: new (options?: Record<string, unknown>) => CopilotClientLike;
}

export interface CopilotDreamingRuntimeOptions {
  /** Stable runtime identifier persisted in the Dreaming run ledger. */
  id?: string;
  /** Copilot model identifier. Defaults to the SDK's automatic model selection. */
  model?: string;
  /** Hard per-generation timeout. The adapter aborts the session when it expires. */
  timeoutMs?: number;
  /** SDK client options. The default mode is empty so Dreaming cannot call tools. */
  clientOptions?: Record<string, unknown>;
  /** Safe per-session options; the selected model is always applied by this adapter. */
  sessionOptions?: Record<string, unknown>;
  /** Test seam; production normally loads @microsoft/copilot-sdk dynamically. */
  sdkLoader?: () => Promise<CopilotSdkModuleLike>;
}

const COPILOT_PACKAGE = '@microsoft/copilot-sdk';

/** Native structured-output contract for the Dreaming response. */
export const DREAMING_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['proposals', 'processedRecordIds', 'reviewedMemoryIds'],
  properties: {
    proposals: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'scope', 'operation', 'targetRecordIds', 'rationale', 'evidenceRefs'],
        properties: {
          id: { type: 'string', minLength: 1 },
          scope: { type: 'string', minLength: 1 },
          operation: { type: 'string', enum: ['add', 'update', 'merge', 'supersede', 'archive'] },
          targetRecordIds: { type: 'array', items: { type: 'string' } },
          proposedRecord: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'scope', 'content', 'status', 'importance', 'sourceRefs'],
            properties: {
              id: { type: 'string', minLength: 1 },
              scope: { type: 'string', minLength: 1 },
              content: { type: 'string', minLength: 1, maxLength: 4000 },
              status: { type: 'string', enum: ['candidate'] },
              importance: { type: 'number', minimum: 0, maximum: 1 },
              sourceRefs: { type: 'array', items: { type: 'string' } },
            },
          },
          rationale: { type: 'string', minLength: 1 },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          conflictsWith: { type: 'array', items: { type: 'string' } },
          relationships: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'scope', 'fromId', 'toId', 'kind', 'sourceRefs'],
              properties: {
                id: { type: 'string', minLength: 1 },
                scope: { type: 'string', minLength: 1 },
                fromId: { type: 'string', minLength: 1 },
                toId: { type: 'string', minLength: 1 },
                kind: { type: 'string', minLength: 1 },
                sourceRefs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          quality: {
            type: 'object',
            additionalProperties: false,
            required: ['confidence', 'durability', 'specificity', 'contradictionRisk'],
            properties: {
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              durability: { type: 'number', minimum: 0, maximum: 1 },
              specificity: { type: 'number', minimum: 0, maximum: 1 },
              contradictionRisk: { type: 'number', minimum: 0, maximum: 1 },
            },
          },
        },
      },
    },
    processedRecordIds: { type: 'array', items: { type: 'string' } },
    reviewedMemoryIds: { type: 'array', items: { type: 'string' } },
    notes: { type: 'array', items: { type: 'string' } },
  },
} as const;

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^\`\`\`(?:json)?\s*/i, '')
    .replace(/\s*\`\`\`$/, '');
  try {
    return JSON.parse(unfenced) as unknown;
  } catch (error) {
    throw new Error(
      'Copilot Dreaming returned invalid JSON: ' + (error instanceof Error ? error.message : String(error)),
    );
  }
}

function sumUsage(events: readonly Record<string, unknown>[]): Record<string, number> | undefined {
  const mapping: Record<string, string> = {
    inputTokens: 'inputTokens',
    outputTokens: 'outputTokens',
    totalTokens: 'totalTokens',
    cachedInputTokens: 'cacheReadTokens',
    reasoningTokens: 'reasoningTokens',
    totalNanoAiu: 'totalNanoAiu',
  };
  const totals: Record<string, number> = {};
  for (const event of events) {
    for (const [target, source] of Object.entries(mapping)) {
      const value = event[source];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        totals[target] = (totals[target] ?? 0) + value;
      }
    }
  }
  return Object.keys(totals).length ? totals : undefined;
}

/**
 * Default Dreaming adapter backed directly by Microsoft Copilot SDK.
 *
 * It creates an isolated no-tools session for each generation call. The SDK client
 * is reused, but session history is not carried across Dreaming batches: all required
 * context is supplied explicitly from the repository and evidence resolver.
 */
export class CopilotDreamingRuntime implements DreamingRuntime {
  readonly id: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly clientOptions: Record<string, unknown>;
  private readonly sessionOptions: Record<string, unknown>;
  private readonly sdkLoader: () => Promise<CopilotSdkModuleLike>;
  private client?: CopilotClientLike;
  private starting?: Promise<CopilotClientLike>;
  private readonly activeSessions = new Set<CopilotSessionLike>();
  private closed = false;

  constructor(options: CopilotDreamingRuntimeOptions = {}) {
    this.id = options.id ?? 'copilot-sdk';
    this.model = options.model ?? 'auto';
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000;
    this.clientOptions = options.clientOptions ?? {};
    this.sessionOptions = options.sessionOptions ?? {};
    this.sdkLoader = options.sdkLoader ?? this.loadSdk;
    if (!this.id.trim()) throw new TypeError('Copilot runtime id is required');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 60 * 60_000) {
      throw new TypeError('timeoutMs must be between 1000 and 3600000');
    }
  }

  async generate(request: DreamingRuntimeRequest): Promise<DreamingRuntimeResponse> {
    if (this.closed) throw new Error('Copilot Dreaming runtime is closed');
    if (request.signal?.aborted) throw request.signal.reason ?? new Error('Dreaming generation aborted');

    const client = await this.getClient();
    const session = await client.createSession({
      ...this.sessionOptions,
      model: this.model,
    });
    this.activeSessions.add(session);
    const usageEvents: Record<string, unknown>[] = [];
    const unsubscribeUsage = session.on?.('assistant.usage', (event) => {
      if (event && typeof event === 'object') {
        const data = (event as { data?: unknown }).data;
        if (data && typeof data === 'object') usageEvents.push(data as Record<string, unknown>);
      }
    });
    const abortSession = () => { void session.abort().catch(() => undefined); };
    request.signal?.addEventListener('abort', abortSession, { once: true });

    try {
      if (request.signal?.aborted) throw request.signal.reason ?? new Error('Dreaming generation aborted');
      const prompt = [
        'SYSTEM INSTRUCTIONS',
        request.system,
        '',
        'DREAMING INPUT',
        request.prompt,
        '',
        'Return only the structured JSON result required by the response schema.',
      ].join('\n');

      const response = await session.sendAndWait({
        prompt,
        responseSchema: DREAMING_RESPONSE_SCHEMA,
      }, this.timeoutMs);
      if (request.signal?.aborted) throw request.signal.reason ?? new Error('Dreaming generation aborted');
      const content = response?.data?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('Copilot Dreaming session completed without an assistant response');
      }
      return {
        output: parseJson(content),
        model: response?.data?.model ?? this.model,
        ...(sumUsage(usageEvents) ? { usage: sumUsage(usageEvents) } : {}),
      };
    } catch (error) {
      abortSession();
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', abortSession);
      unsubscribeUsage?.();
      this.activeSessions.delete(session);
      try {
        await session.disconnect();
      } catch {
        // Preserve the generation outcome; client.stop() remains the final cleanup boundary.
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.activeSessions) {
      try { await session.abort(); } catch { /* Continue shutdown for remaining sessions. */ }
    }
    if (this.starting) {
      try { await this.starting; } catch { /* Startup failure is surfaced by generate(). */ }
    }
    const client = this.client;
    this.client = undefined;
    if (client) await client.stop();
  }

  private async getClient(): Promise<CopilotClientLike> {
    if (this.closed) throw new Error('Copilot Dreaming runtime is closed');
    if (this.client) return this.client;
    if (!this.starting) {
      this.starting = (async () => {
        const sdk = await this.sdkLoader();
        if (typeof sdk.CopilotClient !== 'function') {
          throw new Error('The installed Copilot SDK does not export CopilotClient');
        }
        // Empty mode disables the coding-agent tool surface; Dreaming works only from supplied evidence.
        const client = new sdk.CopilotClient({
          mode: 'empty',
          ...this.clientOptions,
        });
        await client.start();
        if (this.closed) {
          await client.stop();
          throw new Error('Copilot Dreaming runtime was closed while starting');
        }
        this.client = client;
        return client;
      })().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async loadSdk(): Promise<CopilotSdkModuleLike> {
    try {
      const moduleName = COPILOT_PACKAGE;
      return await import(moduleName) as unknown as CopilotSdkModuleLike;
    } catch (error) {
      throw new Error(
        `CopilotDreamingRuntime requires the optional peer dependency ${COPILOT_PACKAGE}. Install it with: npm install ${COPILOT_PACKAGE}`,
        { cause: error },
      );
    }
  }
}
