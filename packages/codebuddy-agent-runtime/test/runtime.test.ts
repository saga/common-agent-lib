import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildCodeBuddyContextWindowOption,
  buildCodeBuddyOptions,
  buildCodeBuddyPrompt,
  CodeBuddyAgentRuntime,
  CodeBuddyTaskError,
  parseCodeBuddyUsage,
  type CodeBuddyQueryHandle,
} from '../src/index.js';

function fakeQuery(messages: unknown[], interrupt?: () => unknown) {
  const generator = (async function* () {
    for (const message of messages) yield message;
  })();
  return Object.assign(generator, { interrupt });
}

test('prompt composition keeps system and user input explicit', () => {
  assert.equal(
    buildCodeBuddyPrompt('translate this', 'Be accurate'),
    'SYSTEM INSTRUCTIONS:\nBe accurate\n\nUSER REQUEST:\ntranslate this',
  );
});

test('forwards fallbackModel and reasoning profile through the query options contract', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const runtime = new CodeBuddyAgentRuntime(({ options }) => {
    receivedOptions = options;
    return fakeQuery([{ type: 'result', subtype: 'success' }]);
  });

  await runtime.run({
    prompt: 'task',
    model: 'primary-model',
    fallbackModel: 'backup-model',
    thinking: { type: 'enabled', budgetTokens: 4096 },
    effort: 'high',
  });

  assert.equal(receivedOptions?.model, 'primary-model');
  assert.equal(receivedOptions?.fallbackModel, 'backup-model');
  assert.deepEqual(receivedOptions?.thinking, { type: 'enabled', budgetTokens: 4096 });
  assert.equal(receivedOptions?.effort, 'high');
});

test('resumes a caller-supplied CodeBuddy query session and opts into persistence', async () => {
  let receivedOptions: Record<string, unknown> | undefined;
  const runtime = new CodeBuddyAgentRuntime(({ options }) => {
    receivedOptions = options;
    return fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'existing-session' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'continued' }] } },
      { type: 'result', subtype: 'success' },
    ]);
  });

  const result = await runtime.run({ prompt: 'continue', resumeSessionId: 'existing-session' });

  assert.equal(receivedOptions?.resume, 'existing-session');
  assert.equal(receivedOptions?.persistSession, true);
  assert.equal(result.sessionId, 'existing-session');
  assert.equal(result.text, 'continued');
});

test('rejects an empty or explicitly non-persistent resume session', async () => {
  const runtime = new CodeBuddyAgentRuntime(() => {
    throw new Error('query must not start');
  });
  await assert.rejects(runtime.run({ prompt: 'continue', resumeSessionId: '   ' }), /non-empty session ID/);
  await assert.rejects(runtime.run({ prompt: 'continue', resumeSessionId: 'existing-session', persistSession: false }), /requires persistSession/);
  await assert.rejects(runtime.run({ prompt: 'continue', resumeSessionId: 'existing-session', contextWindow: 1_000_000, contextWindowModel: deepseekFlash }), /contextWindow override is not supported/);
});

test('plain-text tasks deny tools and do not load host settings by default', () => {
  const options = buildCodeBuddyOptions({});
  assert.deepEqual(options.tools, []);
  assert.deepEqual(options.allowedTools, []);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
});

test('structured tasks only allow StructuredOutput and require object schema', async () => {
  const options = buildCodeBuddyOptions({ schema: { type: 'object', properties: {} } });
  const canUseTool = options.canUseTool as (name: string) => Promise<{ behavior: string }>;
  assert.equal((await canUseTool('StructuredOutput')).behavior, 'allow');
  assert.equal((await canUseTool('Bash')).behavior, 'deny');
  assert.deepEqual(options.tools, ['StructuredOutput']);
  assert.equal((options.outputFormat as { type: string }).type, 'json_schema');

  const runtime = new CodeBuddyAgentRuntime(({ options: received }) => {
    assert.equal((received.outputFormat as { type: string }).type, 'json_schema');
    return fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'structured-session-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '{"ok":true}' }] } },
      { type: 'result', subtype: 'success', structured_output: { ok: true }, usage: { input_tokens: 12, output_tokens: 3 }, duration_ms: 10, num_turns: 1 },
    ]);
  });
  const result = await runtime.run({ prompt: 'extract', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } });
  assert.deepEqual(result.structuredOutput, { ok: true });
  assert.equal(result.sessionId, 'structured-session-1');
  assert.equal(result.usage?.totalTokens, 15);
});

test('collects assistant text, session ID and usage callbacks', async () => {
  const seen: string[] = [];
  const events: unknown[] = [];
  const runtime = new CodeBuddyAgentRuntime(({ prompt }) => {
    assert.match(prompt, /SYSTEM INSTRUCTIONS/);
    return fakeQuery([
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] } },
      { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, total_cost_usd: 0, duration_ms: 20, num_turns: 1 },
    ]);
  });
  const result = await runtime.run({
    prompt: 'task',
    systemPrompt: 'rules',
    onText: (text) => seen.push(text),
    onEvent: (event) => events.push(event),
    onSessionId: (id) => seen.push(id),
  });
  assert.equal(result.text, 'hello\nworld');
  assert.deepEqual(seen, ['sess-1', 'hello', 'world']);
  assert.equal(events.length, 3);
  assert.equal(result.sessionId, 'sess-1');
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 0,
    totalTokens: 17,
    durationMs: 20,
    numTurns: 1,
  });
});

test('parses fenced JSON if SDK structured_output is absent', async () => {
  const runtime = new CodeBuddyAgentRuntime(() => fakeQuery([
    { type: 'assistant', message: { content: [{ type: 'text', text: '```json\n{"count":2}\n```' }] } },
    { type: 'result', subtype: 'success' },
  ]));
  const result = await runtime.run({ prompt: 'return json', schema: { type: 'object', properties: { count: { type: 'number' } } } });
  assert.deepEqual(result.structuredOutput, { count: 2 });
});

test('SDK error result becomes a typed task error', async () => {
  const runtime = new CodeBuddyAgentRuntime(() => fakeQuery([
    { type: 'result', subtype: 'error_during_execution', errors: ['tool blocked'] },
  ]));
  await assert.rejects(
    runtime.run({ prompt: 'task' }),
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'sdk-error',
  );
});

test('timeout requests SDK interruption', async () => {
  let interrupted = 0;
  const neverEnding = Object.assign({
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) };
    },
  }, { interrupt: () => { interrupted += 1; } });
  const runtime = new CodeBuddyAgentRuntime(() => neverEnding);
  await assert.rejects(
    runtime.run({ prompt: 'task', timeoutMs: 10 }),
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'timeout',
  );
  assert.equal(interrupted, 1);
});

test('timeout also bounds async query-factory initialization', async () => {
  const runtime = new CodeBuddyAgentRuntime(() => new Promise<CodeBuddyQueryHandle>(() => undefined));
  await assert.rejects(
    runtime.run({ prompt: 'startup never completes', timeoutMs: 10 }),
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'timeout',
  );
});

test('a query handle that appears after timeout is interrupted immediately', async () => {
  let resolveFactory!: (query: CodeBuddyQueryHandle) => void;
  let interrupted = 0;
  const runtime = new CodeBuddyAgentRuntime(() => new Promise<CodeBuddyQueryHandle>((resolve) => {
    resolveFactory = resolve;
  }));

  await assert.rejects(
    runtime.run({ prompt: 'delayed startup', timeoutMs: 10 }),
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'timeout',
  );

  resolveFactory(Object.assign(fakeQuery([]), {
    interrupt: () => { interrupted += 1; },
  }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(interrupted, 1);
});

test('timeout stops local iterator consumption so late events cannot call host callbacks', async () => {
  let resolveNext!: (value: IteratorResult<unknown>) => void;
  let interrupted = 0;
  let returnCalls = 0;
  let textCallbacks = 0;
  const query = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<unknown>>((resolve) => { resolveNext = resolve; }),
        return: async () => {
          returnCalls += 1;
          return { done: true, value: undefined };
        },
      };
    },
    interrupt: () => { interrupted += 1; },
  } as unknown as CodeBuddyQueryHandle;
  const runtime = new CodeBuddyAgentRuntime(() => query);

  await assert.rejects(
    runtime.run({
      prompt: 'late event',
      timeoutMs: 10,
      onText: () => { textCallbacks += 1; },
    }),
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'timeout',
  );

  resolveNext({
    done: false,
    value: { type: 'assistant', message: { content: [{ type: 'text', text: 'too late' }] } },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(interrupted, 1);
  assert.equal(returnCalls, 1);
  assert.equal(textCallbacks, 0);
});

test('a cancellation before query initialization does not launch the SDK query', async () => {
  let factoryCalls = 0;
  const controller = new AbortController();
  const runtime = new CodeBuddyAgentRuntime(() => {
    factoryCalls += 1;
    return fakeQuery([]);
  });
  const run = runtime.run({ prompt: 'cancel before start', signal: controller.signal });
  controller.abort();
  await assert.rejects(
    run,
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'aborted',
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 0);
});

test('abort signal requests interruption', async () => {
  let interrupted = 0;
  const controller = new AbortController();
  const neverEnding = Object.assign({
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => undefined) };
    },
  }, { interrupt: () => { interrupted += 1; } });
  const runtime = new CodeBuddyAgentRuntime(() => neverEnding);
  const run = runtime.run({ prompt: 'task', signal: controller.signal });
  // Let the query factory produce a handle so this specifically exercises interrupting
  // an invocation that has started, rather than cancellation before launch.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    run,
    (error: unknown) => error instanceof CodeBuddyTaskError && error.code === 'aborted',
  );
  assert.equal(interrupted, 1);
});

test('rejects array schema because SDK StructuredOutput requires object schema', async () => {
  const runtime = new CodeBuddyAgentRuntime(() => fakeQuery([]));
  await assert.rejects(runtime.run({ prompt: 'task', schema: { type: 'array', items: { type: 'string' } } }), /schema must have type/);
});

test('usage parser distinguishes missing cost from an explicitly reported zero cost', () => {
  assert.equal(parseCodeBuddyUsage({}), undefined);
  assert.equal(parseCodeBuddyUsage({ usage: { input_tokens: 0, output_tokens: 0 } }), undefined);
  assert.equal(parseCodeBuddyUsage({ usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: null })?.totalCostUsd, undefined);
  assert.deepEqual(parseCodeBuddyUsage({ usage: { input_tokens: 3, output_tokens: 2 }, total_cost_usd: 0 }), {
    inputTokens: 3,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 5,
    totalCostUsd: 0,
  });
});

test('explicit context-window selection seeds only temporary project configuration and cleans up', async () => {
  const sourceCwd = mkdtempSync(path.join(os.tmpdir(), 'codebuddy-source-project-'));
  const sourceConfigDir = path.join(sourceCwd, '.codebuddy');
  const modelsJson = JSON.stringify({ models: [{ id: 'custom-model', maxInputTokens: 1_000_000 }] });
  mkdirSync(sourceConfigDir, { recursive: true });
  writeFileSync(path.join(sourceConfigDir, 'models.json'), modelsJson, { mode: 0o600 });
  let seedCwd = '';
  try {
    const runtime = new CodeBuddyAgentRuntime(({ options }) => {
      seedCwd = String(options.cwd || '');
      assert.deepEqual(options.settingSources, ['project']);
      assert.deepEqual(JSON.parse(readFileSync(path.join(seedCwd, '.codebuddy', 'settings.json'), 'utf8')), { contextWindow: 1_000_000 });
      assert.equal(readFileSync(path.join(seedCwd, '.codebuddy', 'models.json'), 'utf8'), modelsJson);
      return fakeQuery([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        { type: 'result', subtype: 'success' },
      ]);
    });
    const result = await runtime.run({
      prompt: 'task',
      cwd: sourceCwd,
      contextWindow: 1_000_000,
      contextWindowModel: deepseekFlash,
    });
    assert.equal(result.text, 'done');
    assert.equal(seedCwd.length > 0, true);
    assert.equal(existsSync(seedCwd), false);
    assert.equal(readFileSync(path.join(sourceConfigDir, 'models.json'), 'utf8'), modelsJson);
  } finally {
    rmSync(sourceCwd, { recursive: true, force: true });
  }
});

test('rejects an unsupported context-window tier before starting the SDK query', async () => {
  let invoked = false;
  const runtime = new CodeBuddyAgentRuntime(() => {
    invoked = true;
    return fakeQuery([]);
  });
  await assert.rejects(runtime.run({
    prompt: 'task',
    contextWindow: 1_000_000,
    contextWindowModel: { maxInputTokens: 500_000, contextWindow: { supportedLengths: [250_000, 500_000], defaultLength: 250_000 } },
  }), /not a supported tier/);
  assert.equal(invoked, false);
});

const deepseekFlash = {
  maxInputTokens: 1_000_000,
  contextWindow: { supportedLengths: [300_000, 1_000_000], defaultLength: 300_000 },
};
