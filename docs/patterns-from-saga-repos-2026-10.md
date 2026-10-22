# Saga 仓库的可复用 Agent 实践（2026-10）

本文基于相关仓库当前可见的代码、文档、测试和近期提交整理。目标是把重复经验归入合适的复用层，而不是将所有项目改造成同一套框架。

## 结论摘要

| 重复模式 | 当前归宿 | 为什么 |
|---|---|---|
| Copilot SDK client / session / turn 生命周期、超时、取消、并发、usage delta、恢复 | npm package：@saga/copilot-agent-runtime | 代码和生命周期边界重复，适合稳定实现 |
| CodeBuddy/WorkBuddy SDK query 调用、安全默认值、结构化输出、usage 与 timeout/abort | npm package：@saga/codebuddy-agent-runtime | 本机服务中已经存在一组领域无关的 SDK 适配逻辑 |
| Agent / tool / knowledge / approval / evidence / event 的跨框架结构 | npm package：@saga/agent-contracts | Schema 和协议比业务实现稳定 |
| Agent trace recorder、span、脱敏、载荷限额、查询和本地持久化 | npm package：@saga/agent-tracing；事件 Schema 复用 @saga/agent-contracts | 跨项目重复的是完整记录能力；存储可替换，业务审计仍留给应用 |
| Structured output 校验、Knowledge provenance、Markdown Workflow、Evaluation、Memory、Rules、State machine | 继续使用现有独立 package | 已有最小、互相独立的实现；不应重新造一份 |
| Ant Design + Ant Design X 的 Agent 对话 UI 模式 | Skill | 应用 UI、样式与业务流程不同，直接做公共组件会引入过度耦合 |
| WorkBuddy 的项目协作、Skill / memory 使用方式 | Skill | 是 Agent 的工作方法，不是运行时库 |
| 本机 WorkBuddy / OpenCode Provider 的配置和失败语义 | Skill | 端口、健康检查与任务类型依赖宿主应用 |
| 本机服务负责耗时文件处理、扩展只负责 UI / 路由 / 轻量调度 | 指南 + 具体应用实现 | 业务文件格式和存储模型不能直接变成通用 runtime |
| 业务 Action、授权、外部副作用、执行历史、监管审计 | 各应用 | 不能由通用 SDK 或 trace 替代 |

## 重点查看的仓库与可复用观察

### Copilot SDK 与长任务

- [copilot-server-agent](https://github.com/saga/copilot-server-agent)：client/session 与业务 execution 分层；明确区分 runtime trace、业务事件、policy/approval 和 evidence；tool policy 由声明的风险属性和部署许可判定，而非按工具名写死。
- [team-member-copilot-agent](https://github.com/saga/team-member-copilot-agent)：每个长期 Member 有自己的 session / memory / capability；消息上下文、长期记忆、工作目标与 Execution 是不同的数据对象；恢复与重试是应用状态语义，不是 SDK 的自动行为。
- [agentic-data-architect](https://github.com/saga/agentic-data-architect)：将业务资料、source confidence、知识置信度与 workflow state 分开；Markdown 工作流只表达阶段和合法路线，业务 evaluator 决定条件是否成立。
- [architecture-diagram-studio](https://github.com/saga/architecture-diagram-studio)：近期把 Copilot runtime 单独提取；稳定 session 关联 conversation 与配置 revision；只对可恢复的 CLI/IPC 断连做 reconnect，不把认证、quota、模型选择错误伪装成重启问题；领域变更经当前权威数据与版本检查后应用。
- [copilot-server-agent](https://github.com/saga/copilot-server-agent)：resume 路径恢复已保存的会话配置，不能只凭 sessionId 传空配置。宿主需要持久化非敏感配置，再在恢复时重新计算 provider 凭据；会话拥有权、运行时附着锁、turn 锁和 durable Execution 仍由应用负责。
- [agent-skills](https://github.com/saga/agent-skills)：可用来快速验证 SDK 的最小 API，但临时实验代码不应自动升级为生产范式；版本、生命周期和错误语义应以当前项目锁定的 SDK 与真实测试为准。

现有的 @saga/copilot-agent-runtime 已覆盖最适合公共化的 SDK 生命周期。恢复会话必须明确提供原 session config；不要把宿主完整配置或密钥直接当业务数据持久化，也不要用空 `{}` 恢复后宣称仍保留原有 tools / provider / MCP 设置。不要把 Team、Member、Conversation、业务任务计划、授权或持久化倒灌进 Runtime。

2026-10-23 的仓库版本快照：

| Repository | Declared version | Lockfile observation |
| --- | --- | --- |
| `copilot-server-agent` | `1.0.14` | `1.0.14` |
| `ai-interview-questions` | `1.0.14` | `1.0.14` |
| `team-member-copilot-agent` | `^1.0.15` | `1.0.15` |
| `common-agent-lib/packages/copilot-agent-runtime` | `^1.0.15` | 当前仓库未发现 root lockfile |
| `architecture-diagram-studio/v2` | `^1.0.17` | `1.0.24` |

这个分叉意味着 SDK 的 callback/result union、managed approval 字段和默认行为不能从一个仓库直接抄到另一个仓库。每个项目以实际 lockfile 为准；跨版本复用时至少核对类型定义、对应 SDK 实现/文档和最小回归测试。必要时先升级并锁定依赖，再迁移公共 Runtime；不要靠 `as any` 把新版本字段塞进旧版类型，也不要在未验证的 SDK 上默认自动批准。


### Trajectory、Trace 与 Evidence

- [architecture-diagram-studio trace ledger](https://github.com/saga/architecture-diagram-studio/blob/main/v1/server/trace-ledger.ts) 使用 traceId / turnId / parentEventId / sequence / category / status / duration / provider / model，将流式运行事件关联为可检索记录。
- [copilot-server-agent execution events](https://github.com/saga/copilot-server-agent/blob/main/server/src/execution/events.ts) 明确区分运行时可观测性与业务执行审计。
- 公共层通过 AgentTraceContext / AgentEvent 定义事件契约；@saga/agent-tracing 负责生成事件、trace-local sequence、脱敏、大小限制、span、SQLite store 和查询。应用仍负责 retention policy、访问权限、备份、防篡改与业务 audit。
- 轨迹应记可验证的状态变化和工具生命周期，不应默认保存完整隐藏推理、整段 prompt、secret 或无限长的 token delta。
- Trace 可以帮助排查问题，但不能单独证明“谁被授权、谁批准、批准时看见什么、外部系统是否执行成功”。这些需要应用自己的业务事件和证据链。

### Ant Design 与 Ant Design X

- [ai-interview-questions CopilotSidebar](https://github.com/saga/ai-interview-questions/blob/main/src/components/copilot/CopilotSidebar.tsx) 使用 Bubble、Sender、Prompts，和 antd 的布局、按钮、Typography 等组合。
- [architecture-diagram-studio v2](https://github.com/saga/architecture-diagram-studio/tree/main/v2) 使用 antd 做企业级配置与布局，Ant Design X 做聊天区；核心 diagram canvas 和 domain model 仍然是应用专用实现。
- 可复用的是“antd 管应用界面 + X 管对话交互”的分层、provider context、稳定的消息状态和流式错误处理；不是一个新的通用 UI package。
- 不要把 chat 的 loading/completed 当成业务执行完成；也不要因为一次模型响应没有调用 tool 就默认失败。

### Agent trace package

architecture-diagram-studio 的 SQLite ledger 说明，轨迹不只是一个事件 interface：还需要 trace-local sequence、索引查询、敏感字段脱敏、超限 payload 的明确截断标记和跨进程持久化。这些通用能力已抽取到 [@saga/agent-tracing](https://github.com/saga/common-agent-lib/tree/main/packages/agent-tracing)。它提供 SQLite 实现，也允许应用实现自己的 AgentTraceStore。该 package 不承担 UI、不连接指定 vendor，也不把轨迹当成监管审计证据。

### WorkBuddy、Skill 与工作记忆

- [ai-interview-questions AGENTS.md](https://github.com/saga/ai-interview-questions/blob/main/AGENTS.md) 把稳定原则放在 AGENTS.md，把命令与细节放到 README/docs/Skill。
- [fanyi-extension](https://github.com/saga/fanyi-extension) 同时使用 WorkBuddy / OpenCode 作为本机模型执行路径，说明 Agent Host 选择和业务流程应通过明确配置控制，而非写死到 prompt。
- WorkBuddy 的桌面宿主操作习惯是 Skill；但 CodeBuddy Agent SDK 的 query 调用与输出/超时/usage 适配可以做 npm runtime，现已新增 @saga/codebuddy-agent-runtime。项目目录、用户级目录和记忆目录可能不同；写入前检查最近更新，避免维护两份已经分叉的记忆。
- Skill 中引用的脚本、命令和文件都要核实存在。Skill 只是一份可执行说明，不能替代程序的校验、权限或测试。

### 本机 Agent Provider 与扩展架构

[fanyi-extension README](https://github.com/saga/fanyi-extension/blob/main/README.md) 和 [architecture](https://github.com/saga/fanyi-extension/blob/main/ARCHITECTURE.md) 呈现了三条执行路由：直连 Provider、远程 Vocal Saga、本机 WorkBuddy / OpenCode。

可复用原则：

1. 本机 provider、model、URL、token 与文档翻译设置独立保存。
2. 用户显式选择本机 Provider 后，调用失败应明确报告或保留现有结果，不应静默切换到远程调用。
3. health/model probe 应与真实任务执行区分；服务未启动时尽量提前、清楚地反馈。
4. 浏览器侧做界面、消息路由、轻量调度；大文件解析、文档状态、缓存和耗时工作放在本机服务。
5. loopback 地址不等于完整安全边界；仍要校验请求、限制路径、设置超时，并在适用时启用 token。

## 建议的代码复用边界

### 适合 npm package

- 对外 API 小、依赖少、可纯函数测试的 schema / contract。
- SDK 生命周期复杂且跨服务反复重复的 Copilot runtime。
- 确定性解析、校验和状态转换器。
- Evaluation case、observation、grader 与汇总。

### 更适合 Skill

- Ant Design X 的组件选择与 streaming UI 实施检查表。
- WorkBuddy / coding agent 的仓库阅读、记忆与验证工作流。
- Local Agent Provider 配置、健康检查、路由和失败语义。
- 特定 Agent SDK 升级时要核对的行为清单。

### 应留在应用中

- SQLite / PostgreSQL trace ledger 的实现。
- LangSmith、OpenTelemetry、CloudWatch 等后端的接线和 retention。
- Team、Member、Conversation、业务 Execution 与恢复策略。
- Policy、authorization、审批、工具副作用与监管审计。
- 图编辑器、翻译 Reader、访谈练习等领域 UI。

## 验证原则

- Schema 改动要增加正向和反向断言，包括无效字段、边界值和向后兼容的最小事件。
- 测试必须真正能在错误实现下失败；有条件时使用 mutation testing，而不只是增加测试数量。
- 文档中的命令应从 package.json / workflow 文件验证，不能凭记忆编写。
- “代码看起来正确”“执行了测试”“CI 通过”是三个不同的结论。
- 不在仓库提交真实 Token、私人 trace、对话全文或未经脱敏的本机日志。


## CodeBuddy SDK 的进一步抽取

本次把 `devweekly/vocal-saga/local-agent-service/src/agents/workbuddy.ts` 中通用的 SDK 接线提取为 `@saga/codebuddy-agent-runtime`。当前包覆盖 query API、显式 prompt 合并、无隐式 host settings、普通任务禁用工具、StructuredOutput、超时/取消和 usage/session ID 归一化。

暂不抽取该服务的长驻 SDK Session Pool、角色/批次隔离、文学任务 profile 和文档 Run：这些与并发模式、文档任务语义紧密相关，且上游 v2 Session API 仍属不稳定接口。先将可靠的单次 query adapter 做成 package，使用它的应用再用实测决定是否继续抽池化接口。

## 2026-10-23 补充：CodeBuddy option surface 与长任务会话边界

最近对 `fanyi-extension` 与 `vocal-saga/local-agent-service` 的横向检查补充了一个重要经验：CodeBuddy 的 `query()` 和 V2 Session API 不是同一组可互换的选项。

- SDK probe 对 `0.3.274`、`0.3.276`、`0.3.282` 的观察是：`thinking` / `effort` 在两种 API 的类型和传输路径中均有证据；`fallbackModel` 存在于 `query()` Options，却不在 V2 `SessionOptions` 中，传入 Session 配置可能被静默忽略。更旧的 `0.2.3` 没有这些字段。每次升级必须以锁定版本复核，而不是相信跨版本的示例或仅凭编译成功。
- 因此公共 `@saga/codebuddy-agent-runtime` 继续包装 `query()`，长驻 Session Pool 仍由应用持有。若每个 task profile 必须可靠地切换 model / thinking / effort / fallback model，不能为节省 CLI 启动而随意迁入 Session API；需要会话历史时，先逐项验证该 API 对所需选项的支持。
- 上下文窗口不是 `maxInputTokens` 的别名，也不能从模型列表推断可选档位。UI 使用服务端 config-options 契约；服务端对请求中的 tier 二次验证。未显式选档时保留模型默认值；显式覆盖需要临时隔离配置，不覆盖用户或项目的原始 settings。
- `vocal-saga` 的文档并发实验也表明，会话 pool 的 scope 是调度约束：同一个 scope 若只允许一个 active turn，就会自然串行；并发要靠不同且有意义的 lane，并确保每批上下文自包含。持久的多阶段工作流应绕过不适合它的共享短任务池，并在应用侧持久化 run/checkpoint/status。模型 session ID 只是恢复线索，不是业务 checkpoint。
- structured output 和 session identity 应一起从同一结果流保留下来，避免成功路径归一化结果时丢失后续恢复需要的 SDK session ID。

可复用的 SDK 接入事实与 probe 步骤见 [CodeBuddy / WorkBuddy SDK Compatibility Notes](./codebuddy-sdk-compatibility.md)。会话 Pool、翻译 task profiles、章节/批次编排和 durable workflow 实现仍然留在 `vocal-saga` 等具体应用中，不应为这些业务语义扩展一个通用 Session Pool 框架。

### Provider fallback：容量错误可以切换，语义错误不应该隐藏

`desktop-agent` 与 `agentic-data-architect` 都明确区分了“首选 Provider 暂时不可用”和“当前任务调用本身失败”。可复用的策略边界是：

- 只有明确识别的 quota / rate-limit / resource-exhaustion 错误，且用户启用了 fallback，才尝试备用 Provider。
- 认证失败、权限拒绝、工具参数错误、schema/代码错误、用户取消和未知异常不能自动切换；它们要保留原始失败语义，避免把配置或安全故障伪装成模型容量问题。
- 每次 Provider attempt 应分别记录开始、结束、失败原因和实际使用的 Provider/model。fallback 不应悄悄修改用户保存的首选 Provider；结果应暴露实际执行路径。
- 切换 Provider 或 model 时，不复用另一 Runtime 的 SDK Session。两种 SDK 的历史状态、工具权限与恢复语义不同。

这是一组适合放进应用层 runtime policy 的原则，而不是继续把每个厂商的错误字符串、桌面审批 UI 或 provider 排序塞入 `@saga/codebuddy-agent-runtime`。其中模型错误分类仍需针对具体 SDK 版本用真实异常与回归测试校验。


