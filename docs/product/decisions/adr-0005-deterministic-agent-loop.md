# ADR-0005：Agent Loop 使用 Session 驱动的确定性串行状态机

- 文档类型：架构决策
- 状态：Accepted
- 日期：2026-09-08

## 背景

过渡 Agent 已能消费模型流和执行工具，但它把消息保存在可变数组中，并与 Server 会话和前端事件耦合。CommonAgent
需要一个只依赖 `ModelAdapter`、Tool Harness 和 `SessionStore` 的通用循环，同时必须限制无限模型/工具循环、处理取消，
并让调试层观察实时过程。

## 决定

- `AgentLoop.run()` 的一次 Run 对应一次用户 Turn。
- 每个 Step 包含一次模型流以及该流返回的一批 Tool Call。
- 每次模型调用前从 Session Log 固定快照推导 `ModelMessage[]`，不维护跨 Run 的可变消息副本。
- 新 Session、Turn 开始和用户输入在一个原子批次中写入。
- assistant Tool Call 意图先持久化，工具随后按 index 串行执行并逐条写入结果。
- Core 请求 `parallel_tool_calls: false`；供应商仍返回多个调用时也串行处理。
- Step、Tool Call、completion token、总 token 和墙上时间使用显式预算。
- 正常完成、受控停止和运行失败使用判别结果，不依赖任意异常文本判断。
- Session 版本冲突、模型错误和模型协议错误不会自动重试。
- 实时 `AgentEvent` 与持久化 `SessionEvent` 分离，观察器错误不能改变主链。

## 备选方案

### 继续扩展 `src/server/agent.ts`

修改量小，但会把 Fastify 会话、前端事件和内存消息数组继续固化进核心，无法替换 Store 或 Runtime。

### 允许模型并行工具并使用 Promise.all

吞吐更高，但副作用顺序、审批顺序、取消、部分失败和 Session 提交顺序都会变得不确定。第一版先建立可解释基线。

### 所有工具执行完后批量写入结果

日志批次更少，但进程在中途崩溃时会丢失已执行工具的事实。逐条写回更接近真实发生顺序。

### Session 冲突时自动重跑整个 Turn

可能重复模型流、费用和外部副作用。没有恢复点和业务幂等保证时，自动重放不安全。

### Adapter 错误统一自动重试

流开始前的可重试错误将来可以单独设计，但流已经输出后重试会造成重复增量。当前保持明确失败。

## 后果

正面影响：

- Agent 主链与模型供应商、网络、数据库和前端解耦。
- Session 事实、模型上下文和版本因果关系保持一致。
- 预算和停止原因可测试，Run 不会无界循环。
- 工具和 Agent 实时事件可供下一阶段 Runtime 与调试轨迹消费。
- 串行工具提供确定的写入、审批和观察顺序。

代价与限制：

- 每个 Model Step 都读取完整 Session 快照，数据库实现后需要评估快照、摘要或缓存投影，但缓存不能成为第二事实源。
- 多个独立工具暂时不能并行提升吞吐。
- assistant Tool Call 写入后崩溃可能留下未完成调用，需要后续恢复协议。
- 总 token 和墙上时间预算依赖 Adapter/工具协作，不能强制终止忽略信号的同进程代码。
- 实时事件尚未持久化、脱敏或通过 Runtime 暴露。
