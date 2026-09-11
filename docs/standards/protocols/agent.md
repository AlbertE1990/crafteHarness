# Agent 门面协议

> 文档类型：规范；状态：Accepted。

## 1. 目标与边界

`Agent` 是 craft-harness 面向应用开发者的默认入口。它统一组装模型 Adapter、工具、SessionStore、
AgentLoop 和标准应用事件，但不读取环境变量，也不依赖 HTTP 框架、数据库驱动或前端类型。

`AgentLoop` 仍是可直接使用的高级执行内核；应用通常只需要 `Agent`。

## 2. 最小创建方式

```ts
import Agent, { defineTool } from 'craft-harness'
import { DeepSeekAdapter } from 'craft-harness/adapters'

const agent = new Agent({
  adapter: new DeepSeekAdapter({
    apiKey: process.env.DEEPSEEK_API_KEY!,
  }),
  model: {
    id: process.env.DEEPSEEK_MODEL!,
    reasoningEffort: 'high',
  },
  tools: {
    workspaceRoot: process.cwd(),
    additional: [myTool],
  },
  systemPrompt: '你是一个可靠的助手。',
})
```

未提供 `tools` 时，Agent 自动注册不依赖工作区的 `get_current_time` 和 `calculator`。只有显式配置
`tools.workspaceRoot` 才加入 `read`、`write`、`edit`、`glob`、`grep` 和 `terminal`；边界见
[内置工作区工具规范](./builtin-workspace-tools.md)。

根字段 `adapter` 只承载供应商连接、鉴权与线协议；`model` 只承载一次 Run 可切换的模型选择：
`{ id, reasoningEffort? }`。两者形状固定，不接受字符串判别器、全局注册表或“配置对象/Adapter 实例”的联合类型。
模型 ID 与推理等级属于部署配置且变化频繁，库不内置默认模型名或供应商等级枚举；`baseURL` 属于 Adapter
连接设置，DeepSeek 默认 `https://api.deepseek.com`。

Kimi、Moonshot 或其他只改变 API Key、base URL 和模型名的兼容服务不需要新增 Adapter：

```ts
const kimiAgent = new Agent({
  adapter: new OpenAICompatibleAdapter({
    provider: 'moonshot',
    apiKey: process.env.MOONSHOT_API_KEY!,
    baseURL: 'https://api.moonshot.cn/v1',
  }),
  model: { id: 'kimi-k3' },
})
```

使用 `openai` npm 包只代表复用兼容客户端；实际请求目标由 `baseURL` 决定。同一 Adapter 可服务同协议的
多个模型，模型切换不需要重建 Agent。

## 3. 配置归一化

`new Agent(config)` 内部必定调用 `defineAgentConfig(config)`。开发者也可以在应用启动时显式调用它，
以便提前发现无效模型、预算和配置。

归一化规则：

- `adapter` 校验为 `ModelAdapter`，但保持调用方注入的实例不变。
- `model.id` 与可选 `model.reasoningEffort` 被裁空白并冻结；`'off'` 表示显式关闭推理。
- `execution.limits` 由 AgentLoop 的同一规则补齐并校验。
- 工具配置解析为包含内置、覆盖和应用追加工具的最终只读数组。
- 未传 Store 时创建 `MemorySessionStore`。
- Session、Run、Turn、Event 和 Approval ID 由内部使用语义前缀加 Node.js `randomUUID()` 生成。
- 不读取 `process.env`，不替调用方决定密钥来源，也不替部署选择模型名或推理等级词表。

配置对象只冻结组装结构，不冻结开发者注入的 Adapter、Store、ToolGuard 或回调实例。

配置按业务意图组织：

| 位置            | 字段                                               | 职责                            |
| --------------- | -------------------------------------------------- | ------------------------------- |
| 根配置          | `adapter`、`model`、`systemPrompt`、`sessionStore` | 连接依赖、模型选择与 Agent 行为 |
| `tools`         | 集合操作、`workspaceRoot`、Guard 与审批            | 工具注册、工作区、风险决策      |
| `execution`     | `limits`、`now`                                    | 预算和可注入时钟                |
| `observability` | `onTrace`、`onToolEvent`                           | 不参与控制流的全局观察器        |

`systemPrompt` 描述 Agent 行为，因此不放入模型供应商连接配置。全局 Guard 与工具集合和局部 Guard 紧密协作，
因此配置为 `tools.guard`，不放入容易暗示沙箱或身份认证能力的 `security`。`sessionStore` 已经完整表达依赖，
不再套只有一个字段的 `session`。项目尚未发布，旧配置形态不属于兼容输入。

## 4. 工具组装

`additional`、`overrides` 和 `replace.tools` 只接受不同 Zod Schema 的 `defineTool()` 结果：

```ts
const agent = new Agent({
  adapter,
  model: { id: 'default-model' },
  tools: { additional: [weatherTool, businessTool] },
})
```

配置内部先把每个原始定义转换为 `AgentTool`，再检查名称并冻结最终数组。执行仍经过 Tool Harness 的
输入输出校验、两层 Guard、审批、超时和重试。已经转换的 `AgentTool` 是 Core 执行结构，不属于 Agent 配置输入。

`AgentConfigInput.tools` 使用两种互斥模式：

- 省略 `mode` 或使用 `mode: 'extend'`：以全部内置工具为基础，可以通过 `disabledBuiltins` 禁用、
  通过 `overrides` 覆盖，通过 `guardOverrides` 单独修改内置工具 Guard，并通过 `additional` 追加应用工具。
- 使用 `mode: 'replace'`：完全跳过内置工具，只注册 `tools` 指定的集合。

```ts
const agent = new Agent({
  model,
  tools: {
    workspaceRoot: '/srv/project',
    disabledBuiltins: ['get_current_time'],
    overrides: {
      calculator: customCalculator,
    },
    guardOverrides: {
      get_current_time: request => ({ decision: 'allow' }),
    },
    additional: [weatherTool],
  },
})

const isolatedAgent = new Agent({
  adapter,
  model: { id: 'default-model' },
  tools: {
    mode: 'replace',
    tools: [weatherTool],
  },
})
```

解析顺序固定为“默认内置 → 禁用 → 覆盖 → 追加”。同一内置工具不能同时禁用和覆盖；覆盖实现必须使用
被覆盖工具的同一名称；追加工具不能与最终集合重名。需要同名替换时必须使用 `overrides`，禁止静默覆盖。
`guardOverrides` 的函数替换内置工具自身 Guard，`null` 明确移除；全局 Guard 不受影响。
`replace` 模式不能混入 workspaceRoot、禁用、覆盖、Guard 覆盖或追加字段。默认扩展模式省略 workspaceRoot 时，
不创建任何文件、搜索或终端工具，也不会把 `process.cwd()` 隐式暴露为工作区。

## 5. 运行与事件

```ts
const result = await agent.invoke({
  scopeId: 'tenant-42',
  input: '杭州天气怎么样？',
  sessionId: 'optional-session-id',
  sessionName: '杭州天气',
  context: appRunContext,
  model: { id: 'deepseek-chat', reasoningEffort: 'high' },
}, signal)

for await (const event of agent.stream({
  scopeId: 'tenant-42',
  input: '杭州天气怎么样？',
  model: { id: 'deepseek-reasoner', reasoningEffort: 'max' },
}, signal)) {
  // 可被 Runtime 直接输出的标准应用事件
}
```

`invoke(request, signal?)` 固定调用 Adapter 的 `complete()` 并返回 `AgentRunResult`；
`stream(request, signal?)` 固定调用 Adapter 的 `stream()` 并返回 `AsyncIterable<AgentOutputEvent>`。
公开模型配置不存在 `stream` 字段，因此方法名与执行方式不会互相矛盾。唯一的运行控制量是取消信号，直接
作为第二参数；Run/Turn ID 由 Agent 内部生成，完整轨迹统一通过 `observability.onTrace` 配置。

请求省略 `model` 时使用 Agent 配置的默认模型选择；一旦提供，就用请求的 `{ id, reasoningEffort? }` **整体替换**
默认选择。请求只写新 `id` 不会继承旧模型的推理强度，避免把某模型的等级错误地下发给另一模型。同一 Run
在进入 AgentLoop 前只解析一次模型选择。
`'off'` 是唯一保留值，按大小写不敏感识别（`'OFF'` 等价，在进入 AgentLoop 前统一归一化为小写 `'off'`），
表示显式关闭推理；其他任何非空字符串都是供应商定义的推理等级（如 `'low'`/`'high'`/`'max'`），原样透传、
不做大小写转换。空白字符串（如 `' '`）在配置边界报错，错误信息带字段路径，例如
`Agent request.model.reasoningEffort 必须是非空字符串` 和 `Agent config.model.reasoningEffort 必须是非空字符串`。

旧形态的两条规则已删除：不再存在“只提供 `reasoningEffort` 会自动启用推理”，也不再存在
“`reasoningEnabled: false` 会清除继承的 effort，且不能同时提供 effort”。单轴形态下没有第二个字段，
因此无法表达出需要这两条规则约束的矛盾状态。

门面把模型选择原样交给 AgentLoop：Run 设置是 `{ id, stream, reasoningEffort? }`，AgentLoop 组装的
`ModelRequest` 直接带 `reasoningEffort`，公开形态与内部契约同形，层间没有任何维度转换。`'off'` 到供应商
具体字段的翻译只发生在 Adapter 内部：DeepSeek 发送 `thinking: { type: 'disabled' }`，OpenAI 兼容发送
`reasoning_effort: 'none'`。保留值 `'off'` 由 `contracts/model.ts` 的 `REASONING_OFF` 常量唯一定义，Core 与
官方 Adapter 从同一处导入，不再各自书写字面量；它属于契约词汇而不是公共 API，根入口的显式导出白名单不
包含它，业务代码也无需认识这个字面量。

当 Agent 声明为 `new Agent<AppRunContext>()` 时，请求的 `context` 为必填。它只传给当前 Run 的工具级
Guard、全局 Guard 和 `execute()`，不进入模型、Session Log、标准前端事件或 Agent 单例。

`scopeId`、`sessionName`、`sessionMetadata` 与 `context` 不可互换：

| 字段              | 生命周期                        | 数据约束     | 当前消费者                                       |
| ----------------- | ------------------------------- | ------------ | ------------------------------------------------ |
| `scopeId`         | 每次 Session 操作显式提供       | 非空字符串   | Agent、SessionStore、数据库分区查询              |
| `sessionName`     | 仅新 Session 创建时写入并持久化 | 非空字符串   | SessionStore、目录搜索、Runtime 展示             |
| `sessionMetadata` | 仅新 Session 创建时写入并持久化 | `JsonObject` | SessionStore、`listSessions/getSession`、Runtime |
| `context`         | 每次 `invoke/stream` 独立传入   | 任意应用类型 | 两层 Guard、工具 `execute()`                     |

`sessionMetadata` 会成为 `session.created.metadata`；继续已有 Session 时再次提供不会更新原值。它适合来源、
创建时快照和临时展示扩展，不进入模型、Guard 或工具执行。`context` 适合当前可信身份、实时权限、ORM、Service
和 API Client，不会自动序列化或持久化。两者都应由可信 Runtime 组装，不能直接相信浏览器提交的身份字段；
授权必须使用当前 context 或应用权限服务，不能把持久化 metadata 当作授权证明。

`scopeId` 是持久化身份的一部分，不是权限凭证。调用方必须从可信认证或业务路由中组装它；即使单用户部署也要
显式传固定值（例如 `default`）。craft-harness 不在 AgentConfig 或 Store 中提供隐式默认 scope，所有数据库读写
都必须同时约束 `scopeId + sessionId`。`sessionName` 是标准可搜索名称，应用自定义筛选字段仍保留在自己的表、
投影或 Repository 中，不继续扩张 craft-harness 的 Session 表。

`stream()` 依次输出以下稳定应用事件：

- `session.started`
- `message.delta`
- `message.completed`
- `tool.approval.requested`
- `tool.approval.resolved`
- `tool.guard.denied`
- `error`

`AgentOutputEvent` 是 craft-harness 面向 CLI、SSE、WebSocket 等应用出口的标准协议。Runtime 默认应原样
序列化这些事件，不再把 `sessionId` 改名为 `conversationId`，也不删除 `runId` 等关联字段。只有宿主已有
外部协议或确实需要裁剪字段时，才自行增加 Adapter；该 Adapter 不属于 craft-harness 核心。

`observability.onTrace` 输出完整 `AgentEvent`，包括 Run、Step、模型输出、工具调用、Tool Harness 子事件和终态。流式
模型输出使用 `agent.model.chunk`，非流式完整响应使用 `agent.model.completed`；
`agent.run.started.modelExecution` 记录本次 Run 的最终内部设置。轨迹观察器异常会被隔离；事件流则是业务
输出而不是观察旁路：消费者读取速度形成背压，提前停止迭代会取消当前 Run。

## 6. 风险评估与用户审批

工具可在 `defineTool()` 中配置局部 `guard` 处理参数级规则；Agent 配置的 `tools.guard` 处理
部署、租户、用户和环境约束。缺少任一层等价于该层 allow，两层都存在时按工具级、全局级顺序执行，并按
`deny > ask > allow` 合并。Agent 内部负责适配 Harness 并管理一次性审批。

```ts
interface AppRunContext {
  tenantId: string
  permissions: readonly string[]
  environment: 'development' | 'production'
}

const agent = new Agent<AppRunContext>({
  model,
  tools: {
    additional: [businessTool],
    approvalTimeoutMs: 120_000,
    guard(request) {
      if (request.context.permissions.includes('tools:execute'))
        return { decision: 'allow' }
      return {
        decision: 'deny',
        reason: `当前用户无权执行 ${request.tool.name}`,
      }
    },
  },
})
```

工具级和全局 Guard 接收同一个 `ToolGuardRequest` 对象并返回同一个 `ToolGuardDecision` 联合类型。区别只在
类型精度：工具级 `request.input` 由自己的 Zod Schema 推导，全局 Guard 面对任意已注册工具，因此 input
默认为 `unknown`。两层都能读取同一份 `request.context`，无需学习或转换第二套协议。

工具 `metadata` 是任意 JSON 安全标签，由两层 Guard 自行解释；craft-harness 不提供固定 risk 枚举，也不根据
metadata 自动授权。任一 Guard 抛错或返回非法结构时 fail-closed 为当前工具失败。

单次 `ask.approvalTimeoutMs` 优先于通用 `tools.approvalTimeoutMs`，均未提供时默认 120 秒。正整数表示
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

Agent 实例只在当前进程中保存 pending 审批。`invoke()` 没有交互事件出口，因此 ask 会 fail-closed；
`stream()` 出口失效、消费者停止、Run 取消或进程重启时
必须 fail-closed。完整交互见[工具审批全链路](../../learning/tool-approval-flow.md)。

`-1` 只关闭审批自己的定时器，不会覆盖调用方 AbortSignal 或 `execution.limits.maxDurationMs`。若要求在没有人为
取消时真正无限等待，还必须不配置 Run 时限。永久等待会持续占用一个 pending 项和当前 Run，因此只适合
宿主能够保证最终提交或取消的场景。

## 7. Session 查询

- `listSessions({ scopeId, search?, limit?, afterSessionId? })` 只查询指定 scope，按创建顺序分页并返回摘要；
  `search` 对 `sessionName` 做忽略大小写的字面子串匹配。
- `getSession({ scopeId, sessionId, pageSize? })` 按需读取一个一致快照，返回摘要和带
  `eventId/sequence/timestamp/runId/turnId`
  上下文的消息详情。
- Agent 执行只要求 `SessionStore.append/read`；`listSessions()` 额外要求 Store 实现 `SessionCatalogStore`。
- Core 接受并持久化标准 `sessionName`，但不替应用生成标题、展示消息或其他前端字段。

当前联调 Runtime 在新会话请求中生成 `sessionName`，并显式使用单用户 scope `default`；标题不再存入
`sessionMetadata.name`。设计依据与迁移规则见
[ADR-0010](../../product/decisions/adr-0010-searchable-multi-user-session-catalog.md)。名称重命名尚未进入本协议；
需要时应新增不可变事件和目录投影规则，不能直接覆盖 `session.created`。

默认 `MemorySessionStore` 支持列表，但进程退出后数据会丢失，且不会执行 TTL 或容量驱逐。生产环境应注入实现
同一协议的持久化 Store，具体实践见[持久化 SessionStore 教程](../../learning/persistent-session-store.md)。

## 8. 依赖规则

`src/agent` 是产品便利层，但只接收调用方注入的 Adapter，不负责实例化供应商实现。更底层的 `contracts`、
`core`、`sessions` 和 `tools` 仍禁止依赖模型 SDK；内置工具位于 `src/tools/builtins`。官方 Adapter 必须直接依赖 contracts，
不能通过根入口反向导入。

Fastify、SSE、环境变量、数据库连接和前端展示投影只能存在于 Runtime。本仓库的参考 Runtime 是官方案例
`sample/src/server`；它通过相对路径导入 `src/`，方向只能是案例依赖库，库不得反向依赖案例。
