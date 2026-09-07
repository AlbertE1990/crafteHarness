# ADR-002：模型流协议以 OpenAI Chat Completions 为兼容基线

- 文档类型：架构决策
- 状态：Accepted
- 日期：2026-09-07

## 背景

CommonAgent 需要供应商无关的 ModelAdapter，但完全自创流事件会增加映射成本，也会丢失已经被大量
模型供应商采用的 Chat Completions 语义。当前 DeepSeek 本身提供 OpenAI 兼容接口，同时增加了
`reasoning_content` 等字段。

## 决定

- CommonAgent 自己维护模型协议类型，不直接导入 OpenAI SDK 类型。
- 消息、非流式结果和 chunk 尽量复用 OpenAI Chat Completions 的字段名、层级与语义。
- 内部协议采用“只增不减”：CommonAgent 与供应商能力通过可选扩展字段增加，不能删除或改写已有字段。
- chunk 在运行时保留未知字段，避免上游协议新增字段时发生静默数据损失。
- 第一份实现为 DeepSeek Adapter；以后遇到不同协议时新增 Adapter，不在 Agent Core 增加供应商分支。
- 工具参数保留为 JSON 文本，由 Agent 解析并交给 Tool Harness 校验。
- 模型连接配置与 Agent 基础配置统一进入 `AgentConfig`。
- Adapter 只分类错误，不负责自动重试。

## 后果

正面影响：

- OpenAI 兼容供应商的适配成本较低。
- 现有流式工具调用拼装逻辑可以继续使用。
- DeepSeek 思考字段可以作为加法扩展进入同一数据流。
- Core 与 SDK 类型仍保持编译边界。

限制：

- Chat Completions 不是所有供应商的原生抽象；非兼容协议需要明确映射。
- 为兼容未来标准字段，chunk 扩展处会使用 `unknown`，消费者必须先做类型收窄。
- 当前纯文本消息没有提前抽象完整多模态协议；需要时在现有类型上增加，不能破坏已有字段。
