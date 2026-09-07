# 阶段 2：ModelAdapter

- 文档类型：交付记录
- 状态：代码与离线契约测试已完成，真实 DeepSeek 冒烟待具备 API Key 时执行
- 日期：2026-09-07

## 本阶段目标

让 Agent 只依赖 CommonAgent 内部模型协议，将 OpenAI SDK、DeepSeek 请求参数、思考回放和错误分类
收进供应商 Adapter。

## 实际完成

- 新增供应商无关消息、工具调用、非流式结果、标准 chunk、用量、停止原因与错误类型。
- `ModelAdapter` 同时定义 `complete()` 和 `stream()`。
- 标准 chunk 以 OpenAI Chat Completions 为基线并采用“只增不减”原则。
- 完成 DeepSeek 非流式和流式 Adapter。
- 保留运行时未知 chunk 字段，并增加 `reasoning_content` 与 `provider`。
- 映射 DeepSeek thinking、reasoning effort、token 上限、usage、取消和 SDK 错误。
- `agent.ts` 移除所有 OpenAI SDK/DeepSeek 类型，只消费 `ModelAdapter`。
- assistant 的每段 reasoning（包括空字符串）进入模型历史，满足工具思考模式的回放要求。
- 新增 `AgentConfig`，集中 Agent 基础配置、模型连接配置和观察器。

## 主要文件

- `src/common-agent/contracts/*`
- `src/adapters/deepseek/*`（交付当时路径；现位于 `src/common-agent/adapters/deepseek/*`）
- `src/server/agent-config.ts`
- `src/server/agent.ts`
- `test/deepseek-adapter.test.ts`
- `test/agent-model-adapter.test.ts`
- `test/agent-config.test.ts`

## 关键决定

- ADR-002：复用 OpenAI Chat Completions 字段与 chunk 层级，只增加不删减。
- 工具参数继续保留为 JSON 文本，由 Agent 与 Tool Harness 处理不可信边界。
- 模型与 Agent 配置归统一 `AgentConfig`。
- Adapter 不重试，只输出稳定错误分类与 `retryable` 提示。

## 离线验证

- 标准字段、未来未知字段和 DeepSeek 扩展不会在 chunk 映射中丢失。
- 流式和非流式 content、reasoning、tool call 与 usage 映射。
- assistant 空 reasoning 字段回放。
- Agent 可以只依赖 mock ModelAdapter 完成一次流式回答。
- 统一配置校验和只读模型配置。

## 待真实环境验收

配置 `DEEPSEEK_API_KEY` 后验证：

1. 普通流式对话与 reasoning。
2. 时间工具。
3. 指定城市天气。
4. 自动 IP 定位天气。
5. 多轮工具调用中的 reasoning 回放。
6. 主动取消请求。

## 明确不在本阶段实现

- append-only Session Log 和并发写入控制。
- 完整 Agent Loop、模型重试、token/时间预算和停止策略。
- 并行执行多个工具调用。
- 轨迹查询 API、诊断 Sink 与前端调试视图。
