# Delivery 017：阶段 4.11 意图优先的 Agent 调用 API

> 交付日期：2026-09-10；状态：Completed。

## 完成范围

- 用 `agent.invoke(request, signal?)` 和 `agent.stream(request, signal?)` 替代公共 `agent.run()`。
- 将请求级模型设置移入 `AgentRequest.model`，公开字段扁平为 `reasoningEnabled/reasoningEffort`。
- 由调用方法唯一决定 `complete/stream`，删除公共 `model.stream` 双重开关。
- 保留 AgentLoop 高级嵌套执行协议，由 Agent 在单一内部路径中完成继承、校验和转换。
- 新增带背压的异步事件通道；消费者结束迭代时取消当前 Run。
- Fastify 使用 `for await` 直出标准事件，并在响应阻塞时等待 `drain`。
- HTTP `stream` 移到请求顶层，前端与 JSON/SSE 测试同步迁移。
- 开发规范写入“把方便留给使用者，把不方便留给库实现者”的公共 API 原则。

## 关键规则

- 只提供 `reasoningEffort` 会隐式启用推理。
- `reasoningEnabled: false` 清除继承值，且不能与 effort 同时出现。
- `invoke()` 没有交互事件出口，工具审批 ask 保持 fail-closed。
- `stream()` 的标准事件是业务输出通道；`observability.onTrace` 才是故障隔离的观察旁路。

## 验证

- Agent 配置、门面、模型边界、Server Runtime 和公共导出测试。
- TypeScript 公共 API 独立类型检查。
- 全量 lint、typecheck、test 与 build。

## 已知边界

底层 `AgentLoop.run()` 仍是高级 API，并继续接收嵌套模型执行设置；它不是日常业务门面的兼容入口。
