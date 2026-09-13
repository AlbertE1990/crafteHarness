# Craft Harness

为 Node.js 应用提供可控的 Agent 执行循环。

Craft Harness 将模型调用、工具执行、权限审批、预算控制、取消和会话记录组合成一个可嵌入的运行内核。
它不提供 HTTP Server 或 UI，你可以把它接入 Fastify、Express、Worker、CLI 或已有后端。
现有后端可以把登录用户或租户 ID 映射为 `scopeId`，并将角色、权限等可信鉴权结果作为运行上下文传给工具。

> OpenAI SDK 负责与模型服务通信；Craft Harness 负责模型返回工具调用之后的完整执行过程。

## 它解决什么问题

一次模型请求通常只需要几行 SDK 代码。但当应用开始支持工具调用后，还需要处理：

- 模型连续多次调用工具时，如何可靠地继续循环；
- 如何校验模型生成的参数和工具返回值；
- 写入、删除、终端等操作如何在执行前审批；
- 如何限制模型步数、工具次数、耗时和 Token；
- 用户取消或网络断开时，如何终止同一个 Run；
- 如何保存会话事实，并在下一轮恢复一致的模型上下文；
- 如何把不同供应商的响应转换成稳定的应用事件。

Craft Harness 把这些通用问题收敛到 Agent Loop、Tool Harness、Session Store 和 Model Adapter 中，
业务代码只需要提供模型连接、工具实现、权限策略和持久化方式。

```text
用户输入
   │
   ▼
Agent ──────── SessionStore（读取和追加会话事实）
   │
   ▼
ModelAdapter（调用模型）
   │
   ├── 最终回答 ────────────────┐
   │                            │
   └── 工具调用                 │
          │                     │
          ▼                     │
      参数校验 → Guard/审批 → 执行工具
          │
          └──────── 结果交回模型，继续下一步
                                │
                                ▼
                    标准事件 / 最终结果 / 停止原因
```

## 与直接调用 OpenAI SDK 有什么区别

两者不是替代关系。Craft Harness 的官方 Adapter 仍然使用模型 SDK 或兼容接口完成网络通信，
在它们之上增加可复用的 Agent 编排与运行时约束。

| 问题                       | 直接使用 OpenAI SDK  | 使用 Craft Harness                     |
| -------------------------- | -------------------- | -------------------------------------- |
| 模型请求、鉴权和协议序列化 | SDK 提供             | 交给注入的 `ModelAdapter`              |
| 多步工具调用循环           | 应用自行实现         | 内置确定性 `AgentLoop`                 |
| 工具参数                   | 自行解析 JSON 和校验 | `defineTool()` + Zod 自动校验          |
| 工具返回值                 | 应用自行约束         | 使用 `outputSchema` 自动验证           |
| 超时和重试                 | 每个工具分别实现     | 统一的工具执行策略                     |
| 危险操作确认               | 应用自行设计状态机   | 参数级 Guard、全局 Guard、一次性审批   |
| 会话恢复                   | 应用自行拼接消息     | append-only Session Log + 可替换 Store |
| 运行限制                   | 应用自行统计         | 模型步数、工具次数、耗时和 Token 预算  |
| 取消                       | 自行向每一层传递信号 | 一个 `AbortSignal` 贯穿模型与工具      |
| 流式输出                   | 消费供应商原始 chunk | 稳定的 `AgentOutputEvent`              |
| 更换供应商                 | 修改调用或兼容代码   | 替换或实现 `ModelAdapter`              |

如果你的需求只是发送一次请求并取得文本，直接使用模型 SDK 更简单。涉及多步工具、持久化、权限、
执行预算或统一事件协议时，Craft Harness 才会体现价值。

## 安装

要求 Node.js 20 或更高版本，当前包为 ESM-only。

```bash
npm install craft-harness
# 或
pnpm add craft-harness
```

`openai` 与 `zod` 会作为运行依赖安装。自定义工具可以直接从 `craft-harness` 导入 `z`，
无需额外安装 Zod；只有应用直接使用原始包 API 时，才应把相应包声明为自己的直接依赖。

## 60 秒快速开始

创建一个 Agent，并发起一次完整调用：

```ts
import Agent from 'craft-harness'
import { DeepSeekAdapter } from 'craft-harness/adapters'

const agent = new Agent({
  adapter: new DeepSeekAdapter({
    apiKey: process.env.DEEPSEEK_API_KEY!,
  }),
  model: {
    id: process.env.DEEPSEEK_MODEL!,
    reasoningEffort: 'high',
  },
  systemPrompt: '你是一个可靠的助手。',
})

const result = await agent.invoke({
  // scopeId 是会话数据分区，可使用服务端认证得到的用户或租户 ID。
  scopeId: 'user-42',
  input: '用三句话解释什么是 Agent Loop。',
})

console.log(result.status, result.content)
```

`Agent` 应当在应用启动时创建并长期复用，而不是为每个 HTTP 请求重新创建。
模型 ID、密钥和 `scopeId` 都属于应用或部署配置，Craft Harness 不读取环境变量，也不替应用决定身份。
`scopeId` 只是数据分区键，不是认证凭据；服务端仍需先验证用户身份，再生成可信的 `scopeId`。

### 流式输出

`agent.stream()` 返回标准应用事件，可以直接映射到 SSE、WebSocket 或 CLI：

```ts
for await (const event of agent.stream({
  scopeId: 'user-42',
  input: '解释工具调用的执行过程。',
})) {
  if (event.type === 'message.delta')
    process.stdout.write(event.delta)

  if (event.type === 'message.completed')
    console.log('\n完成：', event.content)

  if (event.type === 'error')
    console.error(event.code, event.message)
}
```

事件中还包括 `session.started`、工具审批请求、审批结果和策略拒绝。

## 集成 Node.js 后端与用户鉴权

Craft Harness 可以嵌入现有 Fastify、Express、NestJS 或其他 Node.js 服务。推荐由后端先使用 JWT、Session、
OAuth 等机制完成认证，再把认证结果交给 Agent：

```ts
import Agent from 'craft-harness'
import { DeepSeekAdapter } from 'craft-harness/adapters'

interface AuthenticatedUser {
  id: string
  tenantId: string
  permissions: readonly string[]
}

interface AgentContext {
  userId: string
  tenantId: string
  permissions: readonly string[]
}

const agent = new Agent<AgentContext>({
  adapter: new DeepSeekAdapter({
    apiKey: process.env.DEEPSEEK_API_KEY!,
  }),
  model: { id: process.env.DEEPSEEK_MODEL! },
})

export async function runAuthenticatedChat(
  user: AuthenticatedUser,
  body: { message: string, sessionId?: string },
) {
  return await agent.invoke({
    // 只能使用认证中间件确认过的身份，不能信任浏览器自行提交的 userId。
    scopeId: `tenant:${user.tenantId}:user:${user.id}`,
    ...(body.sessionId ? { sessionId: body.sessionId } : {}),
    input: body.message,
    context: {
      userId: user.id,
      tenantId: user.tenantId,
      permissions: user.permissions,
    },
  })
}
```

接入时各字段的职责如下：

| 后端已有信息           | Craft Harness 接入方式                                           |
| ---------------------- | ---------------------------------------------------------------- |
| 登录用户 ID            | 作为 `scopeId`，隔离该用户的会话、历史和资源                     |
| 租户 ID + 用户 ID      | 组合成稳定 `scopeId`，实现多租户隔离                             |
| 角色、权限、套餐或组织 | 放入请求级 `context`，供 Guard 和工具执行函数判断                |
| 已有会话 ID            | 作为 `sessionId` 继续对话；Store 使用 `scopeId + sessionId` 查询 |
| HTTP 断开信号          | 转换为 `AbortSignal`，同时取消模型调用、工具执行和审批等待       |
| SSE 或 WebSocket       | 将 `agent.stream()` 的 `AgentOutputEvent` 转发给客户端           |

工具 Guard 可以读取 `context`，在执行前检查权限并返回 `allow`、`deny` 或 `ask`。`context` 不会发送给模型，
也不会写入 Session Log。Craft Harness 负责消费可信身份和执行授权策略，但不负责签发 Token、校验密码或实现
登录接口；这些仍由 Node.js 后端的认证层负责。

## 开发并注册一个工具

工具使用同一份 Zod Schema 完成 TypeScript 推导、模型参数描述和运行时校验：

```ts
import Agent, { defineTool, z } from 'craft-harness'
import { OpenAICompatibleAdapter } from 'craft-harness/adapters'

const lookupOrderTool = defineTool({
  name: 'lookup_order',
  description: '根据订单号查询订单状态。',
  inputSchema: z.strictObject({
    orderId: z.string().min(1).describe('需要查询的订单号。'),
  }),
  outputSchema: z.strictObject({
    orderId: z.string(),
    status: z.string(),
  }),
  metadata: {
    risk: 'read',
    capabilities: ['order:read'],
  },
  async execute({ orderId }) {
    // 数据库或业务服务优先通过闭包注入；这里仅演示返回形状。
    return { orderId, status: 'shipped' }
  },
})

const agent = new Agent({
  adapter: new OpenAICompatibleAdapter({
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
  }),
  model: { id: process.env.OPENAI_MODEL! },
  tools: {
    additional: [lookupOrderTool],
  },
})

const result = await agent.invoke({
  scopeId: 'user-42',
  input: '订单 A-1024 发货了吗？',
})
```

模型生成的参数会在工具执行前校验，工具成功值会在返回模型前再次校验。工具不需要加入 switch/case，
也不需要维护另一份 JSON Schema 或工具名映射。

完整开发方式见[自定义工具开发实践](./docs/learning/custom-tool-development.md)。

## 已实现能力

| 能力          | 当前实现                                                       |
| ------------- | -------------------------------------------------------------- |
| Agent 门面    | `invoke()`、`stream()`、请求级模型选择、会话查询               |
| Agent Loop    | 多步模型/工具循环、明确停止原因、工具调用按稳定顺序执行        |
| 执行预算      | 模型步数、工具调用数、运行耗时和 Token 上限                    |
| Tool Harness  | 输入输出校验、错误归一化、超时、重试和输出大小限制             |
| 工具权限      | 工具级 Guard、Agent 级 Guard、交互式一次性审批                 |
| Session Log   | 只追加事件、固定快照、消息推导和乐观并发版本                   |
| Session Store | 内置内存实现；可通过协议接入 PostgreSQL、Redis 等存储          |
| Model Adapter | 供应商无关契约；官方提供 OpenAI-compatible 与 DeepSeek Adapter |
| 应用事件      | 可直接传输的 `AgentOutputEvent` 与完整的 `onTrace` 执行轨迹    |
| 默认工具      | 当前时间与计算器                                               |
| 工作区工具    | 显式配置 `workspaceRoot` 后启用文件、搜索和一次性终端工具      |
| 取消          | 模型流、工具执行、重试等待和审批共享取消信号                   |
| Node 后端集成 | 可嵌入 Fastify、Express、NestJS、Worker 或已有服务             |
| 用户权限接入  | 使用 `scopeId` 隔离数据，使用请求级 `context` 承载可信权限     |

### 会话与多租户

`scopeId + sessionId` 共同确定一个会话。相同 `scopeId` 下携带已有 `sessionId`，即可恢复上下文：

```ts
const first = await agent.invoke({
  scopeId: 'tenant-42:user-7',
  input: '记住项目代号是 Aurora。',
})

const second = await agent.invoke({
  scopeId: 'tenant-42:user-7',
  sessionId: first.sessionId,
  input: '项目代号是什么？',
})
```

默认 `MemorySessionStore` 适合本地开发和测试。生产环境应注入持久化 `SessionStore`；
官方案例包含 PostgreSQL 实现，但它属于案例应用，不随 npm 包发布。

### 工具权限与运行上下文

需要租户、用户或环境级约束时，可以声明 `new Agent<AppContext>()`，并在每次请求中传入由服务端认证结果
构造的 `context`。它只进入当前 Run 的 Guard 和工具执行函数，不会发送给模型，也不会写入 Session Log。

写入、删除和终端操作可以让 Guard 返回 `ask`。Agent 会暂停当前工具调用，向应用输出审批事件，并且只接受
一次针对当前 `approvalId` 的决定。应用负责把审批 UI 或 API 与真实登录身份绑定。

### 模型与供应商

任何符合 OpenAI Chat Completions 协议的服务通常只需要调整 `baseURL` 和模型名：

```ts
import { OpenAICompatibleAdapter } from 'craft-harness/adapters'

const adapter = new OpenAICompatibleAdapter({
  provider: 'moonshot',
  apiKey: process.env.MOONSHOT_API_KEY!,
  baseURL: 'https://api.moonshot.cn/v1',
})
```

供应商协议存在差异时，可以实现 `ModelAdapter`；Agent Loop 只依赖该契约，不依赖具体模型 SDK。

## 它不是什么

Craft Harness 刻意保持为可嵌入的 Node.js 库，因此：

- 不提供 HTTP Server、路由或鉴权；
- 不自带 Vue、React 或聊天 UI；
- 不绑定 PostgreSQL、Redis 或 ORM；
- 不是托管 Agent 平台或模型代理服务；
- 不提供不可信第三方代码沙箱；
- Session Log 是可恢复的会话事实，不是向量记忆或 RAG；
- 不替应用决定模型名称、API Key、用户身份和授权规则。

这些能力由 Runtime 负责。Runtime 可以是你的 Web Server、Worker、CLI，也可以参考仓库中的 `sample/`。

## 官方案例

[`sample/`](./sample/README.md) 是一个完整的 Web Runtime：

- Fastify HTTP/SSE Server；
- PostgreSQL SessionStore 和版本化迁移；
- Vue 3 聊天界面；
- 匿名用户作用域和多会话历史；
- 流式思考、模型选择与工具审批；
- 天气、进程内资源和 Craft Harness 文档检索工具。

案例不参与 npm 发布，它展示的是如何把库组装进真实应用。

```bash
cp sample/.env.example sample/.env.local
pnpm install
pnpm --dir sample dev
```

案例需要 PostgreSQL，首次启动会自动执行尚未应用的数据库迁移。完整配置见
[`sample/README.md`](./sample/README.md)。

## 生产接入清单

- 在进程启动时创建并复用一个 `Agent`；
- 从 Secret 或环境变量构造 Adapter，不把密钥交给浏览器；
- 从服务端认证结果构造 `scopeId` 和业务 `context`；
- 为生产环境注入持久化 SessionStore；
- 将客户端断开映射为传给 Agent 的 `AbortSignal`；
- 为写入、删除、终端等能力配置 Guard 和审批；
- 根据业务设置模型步数、工具数、耗时和 Token 预算；
- 将 `AgentOutputEvent` 映射到 SSE、WebSocket 或其他传输协议；
- 通过 `onTrace` 接入日志和可观测系统，但不要把内部错误直接暴露给用户。

## 文档

- [从 Agent 门面开始](./docs/learning/harness-facade.md)
- [自定义工具开发](./docs/learning/custom-tool-development.md)
- [持久化 SessionStore](./docs/learning/persistent-session-store.md)
- [自定义 ModelAdapter](./docs/learning/custom-model-adapter.md)
- [工作区内置工具](./docs/learning/workspace-builtins.md)
- [工具审批流程](./docs/learning/tool-approval-flow.md)
- [总体架构](./docs/standards/architecture.md)
- [全部文档](./docs/README.md)

## 本仓库开发

根目录命令只检查和构建 `craft-harness` 包：

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm smoke:pack
```

`sample/` 是独立的私有 workspace 包，自行维护依赖和开发命令：

```bash
pnpm --dir sample test
pnpm --dir sample typecheck
pnpm --dir sample lint
pnpm --dir sample build
```

发布前使用 `pnpm release:check` 运行库的完整检查。案例通过 `workspace:*` 依赖公开的 `craft-harness`
包；案例脚本会先构建库。`pnpm smoke:pack` 则从真实 tarball 验证 `exports`、发布文件白名单和类型声明。

## License

MIT
