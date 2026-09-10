# Agent 门面协议

> 文档类型：规范；状态：Accepted。

## 1. 目标与边界

`Agent` 是 CraftAgent 面向应用开发者的默认入口。它统一组装模型 Adapter、工具、SessionStore、
AgentLoop 和标准应用事件，但不读取环境变量，也不依赖 HTTP 框架、数据库驱动或前端类型。

`AgentLoop` 仍是可直接使用的高级执行内核；应用通常只需要 `Agent`。

## 2. 最小创建方式

```ts
import Agent, { defineTool } from 'craft-agent'

const agent = new Agent({
  model: {
    provider: 'deepseek',
    apiKey: process.env.DEEPSEEK_API_KEY!,
  },
  tools: {
    additional: [myTool],
  },
  systemPrompt: '你是一个可靠的助手。',
})
```

未提供 `tools` 时，Agent 自动注册 `get_current_time` 和 `calculator` 两个安全内置工具。

`model` 接受三种形式：

- `{ provider: 'deepseek', ... }`：创建内置 DeepSeek Adapter。
- `{ provider: 'openai-compatible', ... }`：创建 OpenAI Chat Completions 兼容 Adapter。
- 直接传入开发者实现的 `ModelAdapter`。

## 3. 配置归一化

`new Agent(config)` 内部必定调用 `defineAgentConfig(config)`。开发者也可以在应用启动时显式调用它，
以便提前发现无效模型、预算和配置。

归一化规则：

- 模型声明转换为 `ModelAdapter`。
- `execution.limits` 由 AgentLoop 的同一规则补齐并校验。
- 工具配置解析为包含内置、覆盖和应用追加工具的最终只读数组。
- 未传 Store 时创建 `MemorySessionStore`。
- 未传 Session ID 生成器时使用 Node.js `randomUUID()`。
- 不读取 `process.env`，不替调用方决定密钥来源。

配置对象只冻结组装结构，不冻结开发者注入的 Adapter、Store、ToolGuard 或回调实例。

配置按职责分为三组，同时让高频且已经自成体系的 `model`、`tools`、`toolGuard` 保持短路径：

| 配置组          | 字段                        | 职责                           |
| --------------- | --------------------------- | ------------------------------ |
| `session`       | `store`、`createSessionId`  | 持久化端口和会话标识           |
| `execution`     | `limits`、`now`、`createId` | AgentLoop 预算及确定性运行依赖 |
| `observability` | `onTrace`、`onToolEvent`    | 不参与控制流的全局观察器       |

`systemPrompt` 描述 Agent 行为，因此不放入模型供应商连接配置。`toolGuard` 本身已经是完整的风险评估组，
不会再套一层容易暗示沙箱或身份认证能力的 `security`。项目尚未发布，旧的扁平字段不属于兼容输入。

## 4. 工具组装

`additional`、`overrides` 和 `replace.tools` 只接受不同 Zod Schema 的 `defineTool()` 结果：

```ts
const agent = new Agent({
  model,
  tools: { additional: [weatherTool, businessTool] },
})
```

配置内部先把每个原始定义转换为 `AgentTool`，再检查名称并冻结最终数组。执行仍经过 Tool Harness 的
输入输出校验、策略、超时和重试。已经转换的 `AgentTool` 是 Core 执行结构，不属于 Agent 配置输入。

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
    additional: [weatherTool],
  },
})

const isolatedAgent = new Agent({
  model,
  tools: {
    mode: 'replace',
    tools: [weatherTool],
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
    // 可被 Runtime 直接输出的标准应用事件
  },
  onTrace(event) {
    // 完整 AgentEvent 轨迹
  },
})
```

`onEvent` 输出以下稳定应用事件：

- `session.started`
- `message.delta`
- `message.completed`
- `tool.approval.requested`
- `tool.approval.resolved`
- `tool.guard.denied`
- `error`

`AgentOutputEvent` 是 CraftAgent 面向 CLI、SSE、WebSocket 等应用出口的标准协议。Runtime 默认应原样
序列化这些事件，不再把 `sessionId` 改名为 `conversationId`，也不删除 `runId` 等关联字段。只有宿主已有
外部协议或确实需要裁剪字段时，才自行增加 Adapter；该 Adapter 不属于 CraftAgent 核心。

`onTrace` 输出完整 `AgentEvent`，包括 Run、Step、模型 chunk、工具调用、Tool Harness 子事件和终态。
`observability.onTrace` 提供全局观察，单次 run 的 `onTrace` 只观察本次执行。所有观察器异常都会隔离；
阶段 6 再通过 DiagnosticSink 记录。

## 6. 风险评估与用户审批

Agent 门面只暴露一个 `toolGuard` 配置入口。使用者实现 `evaluate()` 决定当前调用是 `allow`、`deny`
还是 `ask`；Agent 内部负责把它适配为 Tool Harness 策略，并管理一次性审批。

```ts
const agent = new Agent({
  model,
  tools: { additional: [businessTool] },
  toolGuard: {
    approvalTimeoutMs: 120_000,
    evaluate(request) {
      if (request.tool.security.risk === 'safe')
        return { decision: 'allow' }
      return {
        decision: 'ask',
        reason: `是否允许 ${request.tool.name}？`,
        approvalTimeoutMs: 45_000,
      }
    },
  },
})
```

单次 `ask.approvalTimeoutMs` 优先于通用 `toolGuard.approvalTimeoutMs`，均未提供时默认 120 秒。正整数表示
等待毫秒数；`-1` 表示永久等待用户决定。永久等待不会创建超时定时器，并在标准事件中输出
`approvalTimeoutMs: -1` 和 `expiresAt: null`。其他值无效。

`tool.approval.requested` 必须包含 Agent 生成的 `approvalId`、`requestedAt`、`expiresAt` 和最终采用的时限。
交互层通过以下方法提交决定：

```ts
agent.resolveToolApproval({ approvalId, decision: 'allow' })
agent.resolveToolApproval({ approvalId, decision: 'deny' })
```

每个 approvalId 只接受首个终态。重复、未知、已超时或已取消请求返回
`{ accepted: false, reason: 'not-found-or-settled' }`。`deny` 和用户拒绝只阻止当前工具执行；AgentLoop
持久化失败 `role=tool` 消息并继续下一 Model Step，不把它们提升为整个 Run 的终止条件。

Agent 实例只在当前进程中保存 pending 审批。没有 `onEvent` 交互出口、出口失效、Run 取消或进程重启时
必须 fail-closed。完整交互见[工具审批全链路](../../learning/tool-approval-flow.md)。

`-1` 只关闭审批自己的定时器，不会覆盖调用方 AbortSignal 或 `execution.limits.maxDurationMs`。若要求在没有人为
取消时真正无限等待，还必须不配置 Run 时限。永久等待会持续占用一个 pending 项和当前 Run，因此只适合
宿主能够保证最终提交或取消的场景。

## 7. Session 查询

- `listSessions({ limit, afterSessionId })` 按创建顺序分页，只返回 `SessionSummary`，不得逐项加载完整事件。
- `getSession(sessionId)` 按需读取一个一致快照，返回摘要和带 `eventId/sequence/timestamp/runId/turnId`
  上下文的消息详情。
- Agent 执行只要求 `SessionStore.append/read`；`listSessions()` 额外要求 Store 实现 `SessionCatalogStore`。
- Core 不生成会话标题、展示消息或前端字段，这些属于 Runtime 投影。

默认 `MemorySessionStore` 支持列表，但进程退出后数据会丢失，且不会执行 TTL 或容量驱逐。生产环境应注入实现
同一协议的持久化 Store，具体实践见[持久化 SessionStore 教程](../../learning/persistent-session-store.md)。

## 8. 依赖规则

`src/craft-agent/agent` 是产品便利层，因此可以实例化同仓库官方 Adapter。更底层的 `contracts`、
`core`、`sessions`、`tools` 和 `builtins` 仍禁止依赖模型 SDK。官方 Adapter 必须直接依赖 contracts，
不能通过根入口反向导入。

Fastify、SSE、环境变量、数据库连接和前端展示投影只能存在于 Runtime。
