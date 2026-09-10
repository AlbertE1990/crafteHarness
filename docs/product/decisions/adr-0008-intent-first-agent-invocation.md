# ADR-0008：Agent 调用采用意图优先的 invoke/stream API

> 状态：Accepted；日期：2026-09-10。

## 背景

原门面使用 `agent.run(request, options)`，`options.model.stream` 决定模型调用方式，`onEvent` 回调承载
实时输出。它允许调用方组合出相互矛盾的意图，也要求 SSE、CLI 和 UI 自行把回调适配成流。
`reasoning: { enabled, effort }` 还把内部协议层级直接暴露给了高频业务调用。

项目的通用库原则是：把方便留给使用者，把不方便留给实现者。只要库能从方法和请求确定执行方式，就不应
要求每个调用方重复组装和转换。

## 决策

- 公共门面提供 `invoke(request, signal?)` 和 `stream(request, signal?)`，删除未发布的 `run()`。
- `invoke()` 固定调用 Adapter `complete()` 并返回 `AgentRunResult`。
- `stream()` 固定调用 Adapter `stream()` 并返回 `AsyncIterable<AgentOutputEvent>`。
- `AgentRequest.model` 只暴露 `reasoningEnabled/reasoningEffort`；公开层不再提供 `stream` 字段。
- 唯一的单次控制量 `AbortSignal` 直接作为第二参数。Run/Turn ID 由内部生成，轨迹只通过构造配置观察。
- Agent 内部统一处理默认值继承、扁平到嵌套转换、流背压和消费者取消。
- `AgentLoop` 保留 `{ stream, reasoning }` 高级执行协议，避免 Adapter 和底层状态机同时维护两种形态。

## 后果

常用调用无法表达“流式方法 + 非流式配置”的矛盾状态，SSE 可直接使用 `for await`。交互审批天然只存在于
`stream()`；`invoke()` 遇到 ask 时 fail-closed。公开 API 更简单，但内部需要维护可靠的异步事件通道、取消
组合和协议归一化，并通过测试承担这些复杂度。

项目尚未发布，因此不保留 `run()` 兼容别名。Delivery 015 记录的旧调用形态仅作为历史快照，当前行为以
本 ADR 和 Agent 门面规范为准。
