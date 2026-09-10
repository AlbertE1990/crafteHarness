# 阶段 4.9：单次模型设置与非流式 JSON

- 文档类型：交付记录
- 状态：代码、测试和文档已完成
- 日期：2026-09-10

## 本阶段目标

让模型的流式方式、思考开关和推理等级成为一次 Agent Run 的显式设置，而不是固定在模型连接
Adapter 构造参数中。同时打通真正的非流式主链：AgentLoop 调用 `complete()`，HTTP Runtime 返回普通
JSON，页面不再把非流式响应伪装成 SSE。

## 实际完成

- 新增 `AgentModelExecutionOptions` 与 `ModelReasoningOptions`。
- `execution.model` 保存 Agent 默认值，`agent.run(..., { model })` 可以按次覆盖。
- 同一 Run 在开始前只解析一次设置，工具往返后的全部模型 Step 保持一致。
- 公共 `reasoning.effort` 使用开放字符串；具体合法等级由当前 Adapter 校验。
- OpenAI Compatible 将 effort 映射为 `reasoning_effort`，显式关闭映射为 `none`。
- DeepSeek 差异层将开关映射为 `thinking.type`，并只在该层维护当前支持的 effort。
- AgentLoop 在 `stream: false` 时调用 `ModelAdapter.complete()`，验证完整响应并产生
  `agent.model.completed` 轨迹；流式路径继续产生 `agent.model.chunk`。
- Server 根据请求选择 SSE 或 `application/json`；页面提供手动设置并分别消费两种响应。

## 重要边界

单次同步 JSON 响应无法在请求完成前主动把审批卡片推送给浏览器。因此当前 Server 的非流式 HTTP
模式不注册交互式审批出口：ToolGuard 的 `ask` 会 fail-closed 为本次工具失败并交回 AgentLoop，不会留下
永久等待的 Promise。需要人工审批时使用流式模式；未来若要在非流式模式支持审批，应单独设计任务 ID、
pending 查询和恢复协议，而不是重新借用 SSE。

## 验证范围

- 构造默认值与单次覆盖的优先级。
- 非流式完整文本、reasoning、usage、Session Log 和完成轨迹。
- 开放 effort 进入通用 Adapter，DeepSeek 拒绝自己不支持的等级。
- HTTP 非流式响应的 JSON Content-Type 和 SSE 流式回归。
- 前端非流式请求不读取 ReadableStream，并正常渲染 Markdown 与 reasoning。
