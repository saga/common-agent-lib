# @saga/copilot-agent-runtime

把 GitHub Copilot SDK 的 server-side runtime 细节收口成一个独立包。

## Copilot SDK 可靠性约束

- `resumeOrCreateCopilotSession` 只在明确识别到 session 不存在时创建新 session；权限、认证、配额和传输错误不能被伪装成“恢复成功”。
- `runTurn` 同时传递 SDK timeout，并设置应用层 watchdog。watchdog 触发后必须调用 `abort()`，再在有限时间内等待 `session.idle`；不能仅仅结束 HTTP 请求而让后台 Agent 继续执行。
- `session.idle` 是停止/空闲信号，不是业务成功结果。调用方仍须检查最终 assistant message、错误事件和业务结果。
- 同一个 session 的 turn 必须通过稳定的 `lockKey` 串行执行。不要把 SDK session 的持久化等同于工具执行状态的持久化。
- `onPermissionRequest` / `onMcpAuthRequest` 属于应用创建 session 时的安全策略；公共 turn runtime 不应替宿主应用自动批准权限或接管 OAuth。没有明确策略时应拒绝/取消，而不是遗留一个永远 pending 的请求。若宿主没有 MCP OAuth broker，应实现 `onMcpAuthRequest` 并返回 `{ kind: 'cancelled' }`，同时向用户报告需要外部登录。
- SDK 事件和日志回调不能阻塞 permission handshake 或 turn completion；日志失败应记录/降级，但不能阻止 SDK 回调返回。

## Session permission / MCP auth callbacks

公共包显式导出 `CopilotSessionPolicy` 作为应用层的回调接口。它只定义 SDK hook 的类型，不提供默认批准策略、交互式审批 UI、OAuth token broker，也不把某个应用的工具白名单复制到这里。权限决策和认证方式依然由宿主应用负责。

Copilot SDK 的 `onPermissionRequest` 与 `onMcpAuthRequest` 是创建或恢复 Session 时的配置项。若既没有注册回调，也没有接入并响应 SDK 的 pending permission RPC，SDK 可能把请求作为事件发出并一直等待消费者处理；请求进入 pending 并不意味着工具已获准。回调必须同时提供给 `createSession` 和 `resumeSession`，不能只在首次创建时配置。参见 [Copilot SDK Node.js 的 Permission Handling 文档](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md#permission-handling)。

示意接法：

~~~ts
import type {
  CopilotCreateSessionConfig,
  CopilotResumeSessionConfig,
  CopilotSessionPolicy,
} from '@saga/copilot-agent-runtime';

// 由应用提供：按其工具范围、授权状态和 UI 能力做出决定。
const policy: CopilotSessionPolicy = {
  onPermissionRequest: appPermissionPolicy,
  onMcpAuthRequest: appMcpAuthPolicy,
};

const createConfig = { ...createBaseConfig, ...policy } satisfies CopilotCreateSessionConfig;
const resumeConfig = { ...resumeBaseConfig, ...policy } satisfies CopilotResumeSessionConfig;

const session = await runtime.createSession(createConfig);
// 之后恢复同一会话时也需要带上回调：
await runtime.resumeSession(sessionId, resumeConfig);
~~~

如果宿主没有 MCP OAuth token broker，应明确返回 SDK 的取消结果，并把需要登录/授权的信息反馈给用户；不要让请求无限等待。`onPermissionRequest` 必须返回 SDK 定义的权限决策结果，例如 `{ kind: 'approve-once' }` 或明确的拒绝结果；不要返回代表已完成状态的 `{ kind: 'approved' }`。后者不是 hook 的决策命令，可能导致 SDK 在授权阶段报错。优先使用当前安装版本的 SDK 类型来约束回调返回值，不要仅凭字段名称推断语义。

Permission handler 也必须按最小权限原则决策：不要因为使用了 `mode: 'empty'` 就一概批准所有工具，先确认该 Session 实际暴露的工具和副作用边界。

回调内的日志、数据库写入或其它遥测不应成为 permission handshake 的前置条件。日志操作可能同步抛错，也可能异步拒绝；把它们从回调的决策路径中隔离，确保回调能及时返回。公共包故意不替宿主选择“approve once”“deny”或 OAuth 流程。

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
- 优先读取 assistant.usage 的逐次 Token / cache / reasoning / Premium Request Cost 事件，并以 session 累计指标差值补充缺失字段
- 返回逐次模型调用 Usage、按模型汇总的本轮增量 Usage，以及独立的 context-window 占用快照
- resumable session 不存在时的 resume-or-create 恢复策略

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
console.log(result.usage);           // 本轮总量（Provider event 优先，session metrics 补缺）
console.log(result.modelCallUsages); // 逐次模型调用：cache / reasoning / latency 等字段
console.log(result.contextUsage);    // 本轮最后一次上下文窗口占用快照
~~~

应用自己的 execution、审计、权限和状态机继续放在包外面。

`CopilotTurnResult.usage` 是当前逻辑 turn 的增量汇总：优先合并 SDK 的 `assistant.usage` 事件；在事件不可用时，使用 session 累计指标差值，并只用该差值补充逐次事件没有报告的字段。`modelCallUsages` 保留每次模型调用的 cache / reasoning / latency 指标。`contextUsage` 是上下文占用快照，不等于本轮消耗。Runtime 不把 AI credit 转成货币，也不定义跨 provider 成本口径。Session 恢复时，如果 SDK session 已不存在，runtime 只负责技术性地创建新 session；新 session 能不能继续沿用原业务状态，仍由应用判断。

`reasoning delta` 只是运行时事件；是否展示给用户、是否保存由应用决定。不要把它当成业务结论、Memory 或审计证据。
