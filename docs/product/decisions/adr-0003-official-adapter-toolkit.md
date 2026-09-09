# ADR-003：官方 Adapter 随项目提供但不进入 Core 依赖

- 文档类型：架构决策
- 状态：Accepted
- 日期：2026-09-07

## 背景

阶段 2 的 DeepSeek Adapter 已经包含大量可被其他 OpenAI Chat Completions 兼容服务复用的逻辑，
包括消息、工具、completion、chunk、usage 和 SDK 错误映射。如果每个供应商复制这些代码，开发成本和
协议漂移风险都会增加；如果 Core 直接创建具体 Adapter，又会破坏供应商无关边界。

项目还需要一份可直接运行的 Adapter 范例和无网络测试工具，让开发者不必从空接口开始实现。

## 决定

- 官方 Adapter 归档在 `src/craft-agent/adapters`，与底层 Core 分层；contracts/core/sessions/tools 不导入
  Adapter 或供应商 SDK。产品根入口可以通过 Agent 门面提供内置 Adapter 的便利配置。
- 提供 `OpenAICompatibleModelAdapter`，集中实现 Chat Completions 通用请求、响应、流和错误逻辑。
- DeepSeek Adapter 继承兼容层的模板方法，只覆盖 developer 消息降级、token 参数和 reasoning 扩展。
- 生产 Adapter 从 `src/craft-agent/adapters` 入口导出；测试 Adapter 和契约探针从
  `src/craft-agent/adapters/testing` 独立导出。
- `ScriptedModelAdapter` 使用确定性脚本替代网络，支持调用快照、取消和流迭代错误。
- `assertModelAdapterContract()` 同时检查 `complete()` 与 `stream()` 的最小运行时协议，测试时必须配合
  SDK 客户端替身或 Scripted Adapter，不能访问生产模型。
- `defineAgentConfig()` 作为唯一归一化入口，使用判别联合创建 DeepSeek 和 OpenAI Compatible Adapter；
  自定义实现直接传入 `ModelAdapter`。
- 协议差异明显的供应商应新增独立 Adapter，不能向通用兼容层不断加入厂商条件分支。

## 后果

正面影响：

- OpenAI 兼容服务通常只需连接配置即可接入。
- 供应商 Adapter 可以复用稳定映射，同时保留必要的差异钩子。
- Agent 与 Runtime 测试不再需要反复手写完整 Mock Adapter。
- 用户可以采用内置便捷配置，也可以直接注入自定义 `ModelAdapter`。

限制：

- 当前单项目仍会安装 OpenAI SDK；未来拆包时应将兼容 Adapter 作为独立子路径或可选包发布。
- 继承点只适合 Chat Completions 兼容差异，不能代替对原生协议的认真建模。
- 契约探针只检查公共骨架；reasoning、特殊工具和供应商错误仍需各 Adapter 的专属测试。
