# 阶段 4：Agent Loop

- 文档类型：交付记录
- 状态：代码、离线测试和文档已完成；等待 Runtime 集成与真实模型联调
- 日期：2026-09-08

## 本阶段目标

实现一个与 HTTP、数据库驱动、前端和模型 SDK 无关的 Agent 控制循环，把 ModelAdapter、Tool Harness 和
SessionStore 串成可运行主链，并提供有界预算、取消、稳定终态和实时事件。

## 实际完成

- 新增 `AgentLoop`，一次 Run 驱动一次完整用户 Turn。
- 建立 Run、Turn、Step、Tool Call 和 Attempt 的职责边界。
- 新 Session 原子写入创建事实、Turn 开始和用户消息。
- 每个 Model Step 从 Session 固定快照重新推导消息并校验版本。
- 组装流式 content、reasoning、finish reason、usage 和分片函数调用。
- 使用 `createAgentTool()` 将不同 Schema 工具注册到统一执行数组。
- 所有业务工具继续通过 `executeTool()` 完成校验、策略、审批、重试和结果投影。
- 未知工具、参数 JSON 和 Harness 失败以 tool message 回写模型。
- 多 Tool Call 使用固定串行顺序，取消时为未执行调用补充 `TOOL_ABORTED` 结果。
- 实现 Step、Tool Call、每 Step completion token、总 token 和时间预算。
- 定义 completed/stopped/failed 终态及稳定 stop reason。
- 定义 Agent 生命周期、模型 chunk、工具调用和嵌套 Tool Event 实时事件。
- 观察器异常隔离，不改变业务主链。
- Session 乐观并发冲突确定失败，不自动合并或重放副作用。

## 主要文件

- `src/craft-agent/core/types.ts`
- `src/craft-agent/core/tool-registry.ts`
- `src/craft-agent/core/agent-loop.ts`
- `src/craft-agent/core/model-stream.ts`
- `src/craft-agent/core/run-state.ts`
- `src/craft-agent/core/stop-policy.ts`
- `src/craft-agent/core/errors.ts`
- `test/agent-loop.test.ts`
- `docs/standards/protocols/agent-loop.md`
- `docs/learning/agent-loop.md`
- `docs/product/decisions/adr-0005-deterministic-agent-loop.md`

## 离线验证

- 最终文本、reasoning、usage、事件顺序和 Session 完成事实。
- 分片 Tool Call 组装、Harness 执行和下一 Step 历史回放。
- 未注册工具错误回写后继续运行。
- Tool Call 整批预算拒绝，不产生部分执行。
- Step 和总 token 预算在边界停止。
- 预取消和协作式时间预算。
- Adapter 异常归一化和 `turn.failed`。
- Run 内 Session 并发版本冲突。
- Agent 实时观察器异常隔离。
- 重复工具名构造期失败。

## 明确不在本阶段实现

- 修改过渡 `src/server/agent.ts` 或 Fastify/前端接口。
- Agent/Tool 实时轨迹的持久化、查询、脱敏和 SSE 输出。
- ModelAdapter 自动重试。
- 并行工具执行。
- 未完成 Turn 和 Tool Call 的崩溃恢复或自动重放。
- 数据库 SessionStore。
- 原始 stack/cause 服务端诊断出口。

下一阶段由 Runtime 组装 AgentLoop，并把实时事件转成可取消、可查询和可调试的外围接口；这些 Runtime 细节不进入
CraftAgent 产品协议。
