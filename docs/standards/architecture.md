# CommonAgent 总体架构

> 文档类型：规范；状态：Accepted。

## 目标

CommonAgent 是一个只面向 Node.js 的通用 Agent 执行内核。它负责循环控制、工具调度、模型协议抽象、会话事实记录和标准事件，不依赖具体 HTTP 框架、数据库或前端。

核心依赖方向如下：

```text
Fastify / CLI / Worker
          |
     Agent Runtime
          |
      CommonAgent
       /   |    \
 Model   Tools  Session Log
 Adapter         Store
```

`CommonAgent` 只能依赖自身协议。具体模型 SDK、数据库驱动和 HTTP/SSE 代码位于外围 adapter 或 Runtime 中。

## 当前目录

```text
src/
  common-agent/
    index.ts
    adapters/
      index.ts
      openai-compatible/
        openai-compatible-model-adapter.ts
      deepseek/
        deepseek-model-adapter.ts
      testing/
        scripted-model-adapter.ts
        model-adapter-contract.ts
    contracts/
      message.ts
      model.ts
      model-events.ts
      model-errors.ts
      session.ts
    core/
      types.ts
      tool-registry.ts
      agent-loop.ts
      model-stream.ts
      run-state.ts
      stop-policy.ts
      errors.ts
    sessions/
      errors.ts
      memory-session-store.ts
      derive-messages.ts
    types/
      json.ts
    tools/
      define-tool.ts
      errors.ts
      events.ts
      execute-tool.ts
      policy.ts
      types.ts
    builtins/
      current-time.ts
      calculator.ts

  server/
    agent-config.ts       # Agent 与模型配置的统一根
    agent.ts              # 只依赖 ModelAdapter 和 CommonAgent 工具协议

  components/             # 前端，不属于 Agent 核心
```

随着后续阶段推进，计划增加但尚未实现：

```text
src/
  common-agent/
    tracing/
      trace-sink.ts
  runtime/
    fastify/
      chat-route.ts
      sse-writer.ts
      trajectory-route.ts
```

目录可以为未来拆分 npm packages 做准备，但当前阶段不建立多包发布结构。

## 核心依赖规则

### CommonAgent 可以依赖

- Node.js 标准库。
- Zod 4，用于工具输入与成功输出协议。
- CommonAgent 自身定义的 TypeScript 类型。

### CommonAgent 不得依赖

- `openai` 或其他模型供应商 SDK。
- Fastify、Express 或其他网络框架。
- Vue 或其他 UI 框架。
- Redis、数据库 ORM 或具体持久化驱动。
- 应用层会话标题、列表和展示模型。

`src/common-agent` 是项目内的 CommonAgent 产品目录，其中根入口、contracts、core、sessions、types、tools 和 builtins
组成 Core；`adapters` 是同目录下独立导出的官方扩展，不属于 Core 依赖图。

OpenAI SDK 现在只由 `src/common-agent/adapters/openai-compatible` 及其供应商差异层使用，其类型不能
穿过 adapter 边界。依赖方向始终是 Adapter 指向 Core 协议；Core 根入口不得重导出或导入
`src/common-agent/adapters`。

## 术语

- **Run**：一次 Agent 执行实例，拥有独立预算和取消信号。
- **Turn**：一次用户输入触发的完整处理过程。
- **Step**：一次模型请求及其产生的一批工具调用。
- **Tool Call**：模型要求执行的一个逻辑工具调用；重试期间 callId 不变。
- **Attempt**：Tool Call 的某一次实际尝试。
- **Session Event**：写入 append-only 日志的持久事实，拥有 Store 分配的 sequence 和版本。
- **Live Event**：实时输出但不一定持久化的过程事件。

## 工具执行主流程

当前 Tool Harness 使用固定顺序：

```text
收到原始参数
  -> Zod 输入校验
  -> Runtime 权限决策
  -> 可选单次审批
  -> 执行业务函数
  -> 可选幂等重试
  -> Zod 成功输出校验
  -> 模型内容投影与大小检查
  -> 返回规范结果并发送轨迹事件
```

策略、审批和轨迹观察器的异常都不能意外转化为授权。轨迹观察器失败也不能改写已经发生的业务结果。

## 轨迹与会话方向

当前已经区分以下数据：

- append-only `SessionEvent`：模型可见消息和基础 Turn 生命周期事实。
- `AgentEvent`：模型增量、reasoning 增量、工具进度和 Run 状态变化。
- Trace：耗时、token、重试和异常等诊断数据。

模型真正看到的历史必须能够由 Session Event 推导，不能另外维护一份可能发生偏差的可变消息数组。

## 分阶段路线

1. **工具协议（已完成）**：`defineTool`、Harness、权限门、轨迹事件和安全内置工具。
2. **现有 Server 接入（已完成）**：DeepSeek 对话使用 `DefinedTool.model` 和 `executeTool()`，支持开发自定义工具。
3. **ModelAdapter（代码已完成）**：供应商无关消息和 OpenAI 兼容流协议，SDK 收进 adapter 边界。
4. **官方 Adapter 工具包（已完成）**：兼容基类、DeepSeek 差异层、Scripted Adapter 和契约探针。
5. **Session Log（已完成）**：内存 append-only store、乐观并发、一致性分页和模型历史推导。
6. **Agent Loop（已完成）**：以 Run/Turn/Step 驱动模型、工具与 Session Store，提供预算、取消和实时事件。
7. **Runtime 与轨迹接口（下一阶段）**：Fastify 只负责 HTTP、SSE、审批和轨迹查询。
8. **诊断与长期强化**：补充服务端异常日志；核心功能稳定后再评估第三方信任、幂等审查和沙箱。

每个阶段必须先通过单元测试和契约测试，再迁移下一层。
完整范围、验收条件和未实现能力见[分阶段开发路线图](../product/roadmap.md)。
