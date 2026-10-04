# @saga/copilot-agent-runtime

把 GitHub Copilot SDK 的 server-side runtime 细节收口成一个独立包。

## 不负责什么

不认识 Team、Member、Conversation、Execution、Policy、MCP registry、Skill、Knowledge，也不落数据库。

## 负责什么

- CopilotClient lifecycle
- create / resume / delete session
- 一个 session 的 turn 串行化
- streaming delta / message / reasoning delta / event
- model override
- sendAndWait timeout
- timeout / cancel 后显式 abort
- 等待 session.idle
- 当前 active turn 数量

## 使用

~~~ts
const runtime = new CopilotAgentRuntime({
  createClient: () =>
    new CopilotClient({
      mode: 'empty',
      gitHubToken: process.env.GITHUB_TOKEN,
    }),
});

const session = await runtime.createSession({
  sessionId: 'example-session',
  model: 'gpt-5-mini',
  streaming: true,
});

const result = await runtime.runTurn({
  turnId: 'turn-001',
  lockKey: 'example-session',
  session,
  prompt: '分析这个问题',
  timeoutMs: 300_000,
  handlers: {
    onDelta: (delta) => process.stdout.write(delta),
  },
});

console.log(result.content);
~~~

应用自己的 execution、审计、权限和状态机继续放在包外面。

`reasoning delta` 只是运行时事件；是否展示给用户、是否保存由应用决定。不要把它当成业务结论、Memory 或审计证据。
