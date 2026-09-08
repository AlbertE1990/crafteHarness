# Agent 门面协议

> 文档类型：规范；状态：Accepted。

## 1. 目标与边界

`Agent` 是 CraftAgent 面向应用开发者的默认入口。它统一组装模型 Adapter、工具、SessionStore、
AgentLoop 和事件投影，但不读取环境变量，也不依赖 HTTP 框架、数据库驱动或前端类型。

`AgentLoop` 仍是可直接使用的高级执行内核；应用通常只需要 `Agent`。

## 2. 最小创建方式

```ts
import Agent, { defineTool, defineTools } from 'craft-agent'

const agent = new Agent({
  model: {
    provider: 'deepseek',
    apiKey: process.env.DEEPSEEK_API_KEY!,
  },
  tools: {
    additional: defineTools(myTool),
  },
  systemPrompt: '你是一个可靠的助手。',
})
```

未提供 `tools` 时，Agent 自动注册 `get_current_time` 和 `calculator` 两个安全内置工具。

`model` 接受三种形式：

- `{ provider: 'deepseek', ... }`：创建内置 DeepSeek Adapter。
- `{ provider: 'openai-compatible', ... }`：创建 OpenAI Chat Completions 兼容 Adapter。
- 直接传入 `ModelAdapter`；早期 `{ provider: 'custom', adapter }` 写法也继续支持。

## 3. 配置归一化

`new Agent(config)` 内部必定调用 `defineAgentConfig(config)`。开发者也可以在应用启动时显式调用它，
以便提前发现无效模型、预算和配置。

归一化规则：

- 模型声明转换为 `ModelAdapter`。
- `limits` 由 AgentLoop 的同一规则补齐并校验。
- 工具配置解析为包含内置、覆盖和应用追加工具的最终只读数组。
- 未传 Store 时创建 `MemorySessionStore`。
- 未传 Session ID 生成器时使用 Node.js `randomUUID()`。
- 不读取 `process.env`，不替调用方决定密钥来源。

配置对象只冻结组装结构，不冻结开发者注入的 Adapter、Store、Policy 或回调实例。

## 4. 工具组装

`defineTools(...tools)` 接受多个不同 Zod Schema 的 `defineTool()` 结果，一次性转换为 AgentLoop 所需的
`AgentTool[]`。已经由 `createAgentTool()` 转换的工具也可以混用。

```ts
const tools = defineTools(weatherTool, calculatorTool)
const agent = new Agent({
  model,
  tools: { additional: tools },
})
```

这只是泛型擦除与不可变数组边界；执行仍然经过 Tool Harness 的输入输出校验、策略、超时和重试。

`AgentConfigInput.tools` 使用两种互斥模式：

- 省略 `mode` 或使用 `mode: 'extend'`：以全部内置工具为基础，可以通过 `disabledBuiltins` 禁用、
  通过 `overrides` 覆盖，并通过 `additional` 追加应用工具。
- 使用 `mode: 'replace'`：完全跳过内置工具，只注册 `tools` 指定的集合。

```ts
const agent = new Agent({
  model,
  tools: {
    disabledBuiltins: ['get_current_time'],
    overrides: {
      calculator: customCalculator,
    },
    additional: defineTools(weatherTool),
  },
})

const isolatedAgent = new Agent({
  model,
  tools: {
    mode: 'replace',
    tools: defineTools(weatherTool),
  },
})
```

解析顺序固定为“默认内置 → 禁用 → 覆盖 → 追加”。同一内置工具不能同时禁用和覆盖；覆盖实现必须使用
被覆盖工具的同一名称；追加工具不能与最终集合重名。需要同名替换时必须使用 `overrides`，禁止静默覆盖。
`replace` 模式不能混入禁用、覆盖或追加字段。

## 5. 运行与事件

```ts
const result = await agent.run({
  input: '杭州天气怎么样？',
  sessionId: 'optional-session-id',
}, {
  signal,
  onEvent(event) {
    // 应用层精简事件
  },
  onTrace(event) {
    // 完整 AgentEvent 轨迹
  },
})
```

`onEvent` 只输出四类稳定应用事件：

- `session.started`
- `message.delta`
- `message.completed`
- `error`

`onTrace` 输出完整 `AgentEvent`，包括 Run、Step、模型 chunk、工具调用、Tool Harness 子事件和终态。
配置根和单次 run 都可设置 `onTrace`。所有观察器异常都会隔离；阶段 6 再通过 DiagnosticSink 记录。

## 6. Session 查询

- `getSession(sessionId)` 返回会话摘要和由事实日志推导的 `ModelMessage[]`。
- `listSessions({ limit, afterSessionId })` 按创建顺序分页，并返回每个会话的模型消息。
- `SessionStore.list()` 是可选能力：Agent 执行只要求 `append/read`；缺少列表能力时仅列表调用失败。
- Core 不生成会话标题、展示消息或前端字段，这些属于 Runtime 投影。

默认 `MemorySessionStore` 支持列表，但进程退出后数据会丢失。生产环境应注入实现同一协议的持久化 Store。

## 7. 依赖规则

`src/craft-agent/agent` 是产品便利层，因此可以实例化同仓库官方 Adapter。更底层的 `contracts`、
`core`、`sessions`、`tools` 和 `builtins` 仍禁止依赖模型 SDK。官方 Adapter 必须直接依赖 contracts，
不能通过根入口反向导入。

Fastify、SSE、环境变量、数据库连接和前端展示投影只能存在于 Runtime。
