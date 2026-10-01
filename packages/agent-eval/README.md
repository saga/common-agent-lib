# @saga/agent-eval

AI Agent 的最小 Eval Core。

它只定义：

- Eval case。
- Agent observation / trajectory metadata。
- Code / model / human grader 的统一结果格式。
- 多 grader 执行和结果汇总。

它不负责启动 Agent、不依赖 Copilot / OpenAI / LangChain / Anthropic，也不强迫所有项目使用同一种评分方法。

典型结构：

~~~text
EvalCase
   ↓
Agent execution
   ↓
Observation / trace / outcome
   ↓
code grader + model grader + human grader
   ↓
case result
~~~