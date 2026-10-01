# @saga/agent-structured-output

把模型输出变成应用真正可以相信的结构化数据。

核心原则：

~~~text
LLM output
   ↓
provider-native / tool structured output（如果支持）
   ↓
Schema validation
   ↓
Application state
~~~

这个包只提供最后一层通用 Schema 校验，以及旧式 JSON 文本解析兼容层。
它不负责 prompt、retry、agent loop 或业务 schema。