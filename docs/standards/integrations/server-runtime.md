# Server Runtime 接入规范

> 文档类型：集成规范；状态：Accepted。

## 1. 范围

本文描述的是**官方案例应用** `sample/` 里的 Fastify Runtime：它是 `sample/src/server/` 的组装示范，演示一个
真实宿主如何持有 Agent、连接池、传输层和前端。它**不是库的一部分**，不随 `craft-harness` 包发布，
HTTP 路由与展示字段也不属于 craft-harness 公共协议，不需要复制到产品学习文档中。

因此本文的路径都可以被替换：任何 CLI、Worker 或其他框架的 Runtime 只要遵守同样的组装规则即可。库自身的
分层与发布边界见[总体架构](../architecture.md)。

## 2. 文件职责

案例应用一侧（`sample/`，库的使用者）：

| 文件                                | 职责                                               |
| ----------------------------------- | -------------------------------------------------- |
| `sample/src/server/index.ts`        | 读取环境变量、构造 Agent、启动监听                 |
| `sample/src/server/model-config.ts` | 校验并归一化 DeepSeek 部署配置（模型名、推理等级） |
| `sample/src/server/agent-tools.ts`  | 定义并静态注册当前应用的第一方工具                 |
| `sample/src/server/app.ts`          | Fastify 路由、SSE/JSON 传输、断开取消和展示投影    |
| `sample/src/server/database/*`      | PostgreSQL Runtime 配置、迁移和连通性检查          |
| `sample/src/server/stores/*`        | 应用 Store；当前 Runtime 使用 PostgreSQL 实现      |

库一侧（`src/`，案例通过相对路径导入）：

| 文件           | 职责                                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `src/agent/*`  | 与传输无关的 Agent 门面、配置、事件和 Session API                       |
| `src/index.ts` | 库的根入口；案例用相对路径导入（`sample/src/**` 下写作 `../../../src`） |

过渡的 `sample/src/server/agent.ts` 与 `sample/src/server/agent-config.ts` 已删除。模型循环、会话目录和通用
输出不应再次在 Server 中实现。

## 3. 组装规则

```ts
const agent = new Agent({
  model: {
    adapter: 'deepseek',
    apiKey,
    baseURL,
    model,
  },
  execution: {
    reasoningEffort,
  },
  tools: {
    additional: [getUserLocationTool, getWeatherTool],
    guard: serverToolGuard,
    approvalTimeoutMs: 120_000,
  },
  sessionStore: new PostgresSessionStore(databasePool),
})

const app = createServerApp({ agent })
```

- 环境变量只在 Runtime 启动边界读取，craft-harness 不读取 `process.env`。
- 一个进程复用一个 Agent；当前 Server 显式注入 PostgreSQL Store，进程重启后由数据库恢复 Session。
- 连接池由 Runtime 创建和关闭，不能进入 craft-harness Core，也不能由 Store 模块在 import 时隐式创建。
- `get_current_time` 和 `calculator` 由 Agent 自动装载，不进入 Server 工具注册表。
- 应用工具使用 `defineTool()`，可直接组成普通只读数组并通过 `tools.additional` 追加；Agent 负责归一化。
- Runtime 只实现 `tools.guard(request)` 的业务风险规则；pending 审批、超时和重复提交由 Agent 管理。
- 当前风险规则只适用于代码仓库内受信第一方工具，不代表第三方插件安全边界。

Runtime 环境变量集中在 `sample/.env.local`（模板见 `sample/.env.example`，从仓库根执行 `pnpm dev:server`
时由案例自己加载）：

| 变量                            | 必填 | 含义                                |
| ------------------------------- | ---- | ----------------------------------- |
| `DEEPSEEK_API_KEY`              | 是   | 模型凭据                            |
| `DEEPSEEK_BASE_URL`             | 否   | 默认 `https://api.deepseek.com`     |
| `CRAFT_AGENT_DATABASE_URL`      | 是   | PostgreSQL 连接串；缺失时启动报错   |
| `CRAFT_AGENT_DATABASE_POOL_MAX` | 否   | 连接池上限，默认 10，必须是正整数   |
| `CRAFT_AGENT_DATABASE_SSL`      | 否   | 只接受 `true`/`false`，默认 `false` |
| `PORT`                          | 否   | HTTP 监听端口，默认 3000            |

环境变量里**只有连接与凭据**：模型集合与每个模型的推理能力一律来自 `sample/config/models.json`（见 §6），
不放进环境变量，也不在库或 Adapter 里。

配置文件的位置由**相对模块定位**决定，而不是当前工作目录：`sample/src/server/index.ts` 用
`new URL('../../.env.local', import.meta.url)` 解析出 `sample/.env.local`，因此无论从仓库根执行 `pnpm dev`
还是直接运行 `tsx sample/src/server/index.ts`，读到的都是同一份配置。文件不存在时跳过加载，继续使用宿主
环境变量，方便容器和 CI 直接注入；`sample/.env.local` 被 Git 忽略，仓库里只提交不含真实密码的
`sample/.env.example`。
库本身仍然不读取 `process.env`。

核心原则是：**换模型或增删推理等级 = 改 `sample/config/models.json` + 重启**，不需要改库，也不需要改前端代码。
旧的 `DEEPSEEK_THINKING` 与 `DEEPSEEK_MODEL` / `DEEPSEEK_MODELS` / `DEEPSEEK_REASONING_EFFORT(S)` 都已删除：
模型侧的事实统一由 §6 的目录文件表达，环境变量只留连接与凭据。

## 4. 请求与取消

Fastify 将 `message` 映射为 Agent 请求的 `input`，将 `conversationId` 映射为 `sessionId`。浏览器断开时，
使用同一个 AbortSignal 取消 Agent Run；模型 Adapter 和 Tool Harness 会继续传播该信号。

当前参考服务是单用户 Runtime，因此所有聊天、详情和目录请求都显式注入 `scopeId: 'default'`。新会话把第一条
消息投影为标准 `sessionName`；`sessionMetadata` 只保存 `source` 等创建扩展。多用户服务必须改为从可信认证和
业务路由组装 scope，并在进入 Agent 前完成访问校验，不能采用浏览器传入的 scope 作为授权证明。

请求顶层的 `stream` 决定传输：`true`（默认）返回 `text/event-stream` 并调用 `agent.stream()`；`false`
返回普通 `application/json` 并调用 `agent.invoke()`，其 `data` 是封闭的 `AgentRunResult`。请求体是
`{ message, conversationId?, stream, reasoningEffort? }`：`reasoningEffort` 是顶层单个字符串，`'off'`
表示显式关闭推理，其他非空字符串作为供应商等级原样交给模型 Adapter，省略时不覆盖部署默认值。原来的
`model: { reasoningEnabled, reasoningEffort }` 对象已删除。传输方式由方法直接表达，不再维护第二个模型开关。

## 5. 标准事件直出与会话查询

Fastify 的聊天 SSE 默认原样输出 `AgentOutputEvent`：

```text
for await (const event of agent.stream(request, signal))
  await writeSseEvent(reply.raw, event)
```

Server 写入函数在 Node 响应返回 `false` 时等待 `drain`，因此网络背压可以沿异步迭代器传回 Agent；连接关闭
会令写入失败并取消当前 Run，不能无界缓存模型输出。

同步 JSON 无法在一个尚未完成的响应中推送审批请求。当前非流式路由不注册交互式审批出口，`ask` 会
fail-closed 为本次工具失败并交回 AgentLoop；需要审批卡片时必须使用流式模式。若未来需要非流式审批，
应新增异步任务和 pending 查询/恢复协议。

不得默认把 `sessionId` 改名为 `conversationId`，也不得删除审批事件中的 `runId/sessionId`。如果 Runtime
必须兼容已有外部 API，可以在 Server 自己增加显式 Adapter。Server 自身在 Agent 外发生的传输错误使用
`server.error`，不能伪装成缺少标准字段的 Agent `error`。

审批 POST 只调用 `agent.resolveToolApproval({ approvalId, decision })`。Server 不创建 ApprovalBroker，也不
持有等待中的 Promise；未知、已处理、超时和重复的审批统一投影为 404。聊天 SSE 必须透传 requested 事件的
`expiresAt`，让页面显示倒计时，但最终超时仍由 Agent 的服务端定时器裁决。若最终
`approvalTimeoutMs` 为 `-1`，事件中的 `expiresAt` 为 `null`，页面应显示“无过期时间”，且 Run 仍可被取消。
若 Runtime 同时配置了 `execution.limits.maxDurationMs`，该 Run 级预算仍然有效。

会话列表调用 `agent.listSessions({ scopeId })`，只返回 `id/name/createAt` 摘要；进入某个会话后再通过
`agent.getSession({ scopeId, sessionId })` 读取详情。标题在创建 Session 时写入标准 `sessionName`，`displayHistory` 只在详情路由中
从通用 ModelMessage 投影，不写入 craft-harness Session 协议，也不维护第二份会话 ID Map。

完整调试轨迹可立即通过 `onTrace` 观察；轨迹的持久化、脱敏和分页 HTTP 查询仍属于下一阶段。

## 6. 模型目录端点

`GET /api/model` 返回当前部署的**模型目录**：有哪些模型、每个模型各自能用哪些推理等级。

```json
{
  "data": {
    "provider": "deepseek",
    "defaultModel": "deepseek-v4-flash",
    "models": [
      {
        "id": "deepseek-v4-flash",
        "label": "DeepSeek V4 Flash",
        "reasoningEfforts": ["off", "low", "high", "max"],
        "defaultReasoningEffort": "high"
      },
      { "id": "deepseek-reasoner", "label": "DeepSeek Reasoner", "reasoningEfforts": [], "defaultReasoningEffort": null }
    ]
  }
}
```

- `models` 是对象数组；`label` 只用于展示，请求体里传的是 `id`。
- **`reasoningEfforts` 是按模型的**，不是全局列表：切到某个模型时前端只渲染该模型的候选。
- `reasoningEfforts: []` 表示该模型**没有推理控制**（例如纯推理模型）：前端隐藏等级控件，请求里也不带
  `reasoningEffort`。
- `defaultReasoningEffort` 是请求未指定等级时采用的值；`null` 表示不下发该参数，由供应商决定。
- 端点只暴露部署元数据，不暴露密钥；`provider` 与 `defaultModel` 与 Agent 配置同源，不维护第二份配置。

### 6.1 目录归部署，词表不进库也不进 Adapter

目录文件的唯一位置是 [`sample/config/models.json`](../../../sample/config/models.json)；模型侧的事实没有第二个
来源——环境变量里只剩连接与凭据，库和 Adapter 里都没有词表。

解析只做让部署能跑起来所必需的检查（有模型、有 `id`、默认值自洽）：配置文件是运维自己写的，
再堆一层通用校验框架只会让这个案例变得难读。写错的字段会在启动阶段以明确信息报出，不会拖到第一次请求。

这一层分工是刻意的：

- **部署拥有词表**（有哪些模型、每个模型允许哪些等级）——它会随供应商变化，改 JSON 重启即可生效。
- **Adapter 只拥有协议形状**（把开放值翻译成 `thinking` / `reasoning_effort`），不持有任何等级枚举。
  库曾经在 DeepSeek Adapter 里维护 `low|high|max` 白名单，结果是供应商新增等级时旧版库把**合法**请求
  判为非法（[ADR-0011](../../product/decisions/adr-0011-single-axis-reasoning-effort.md)）。
- **前端只渲染**：不硬编码任何模型名或等级名。此前
  [`sample/src/pages/index.vue`](../../../sample/src/pages/index.vue)
  写死 `none/minimal/low/medium/high/xhigh/max`——多家供应商词表的并集，是最易腐化的地方。

请求会在 HTTP 边界**按选中模型**校验等级：模型没声明的等级返回
`400 REASONING_EFFORT_NOT_SUPPORTED` 并列出可用值。这属于部署自查（目录是运维自己写的），
比把非法值送给供应商得到的错误更明确。库本身仍然不校验等级，由 Adapter 原样透传，见
[模型 Adapter 协议](../protocols/model-adapter.md)。

### 6.2 模型切换发生在 Runtime，不在库

库把模型名绑定在 Adapter 实例上，`AgentRequest` 没有模型字段，因此**多模型部署由 Runtime 按目录为每个
模型创建一个 Agent 实例**，并在 `/api/chat` 里按请求的 `model` 分发（`createServerApp({ resolveAgent })`）。
请求未声明或声明了目录里没有的模型时返回 `400 MODEL_NOT_SUPPORTED`，不静默退回默认模型——否则用户会
以为切换生效了。

默认模型直接使用 `createServerApp({ agent })` 注入的实例，不要求 Runtime 重复注册它；其余模型才查
`resolveAgent`。多个 Agent 共享同一个 Session Store 与工具集合；同一会话先后使用不同模型是允许的，
会话事实按 Session 记录，与模型无关。

## 7. 会话重命名与删除

`PATCH /api/conversation/:sessionId`（`{ name }`）与 `DELETE /api/conversation/:sessionId` 由 Runtime 通过
`ConversationCatalogMutations` 端口注入。**库的 `SessionStore` 契约刻意不包含这两件事**：

- 名称是**可变的展示投影**：`session.created` 事件保留创建时的原始名称作为不可变事实，目录表的
  `session_name` 是它的当前值，`read()`/`list()` 都以目录为准，因此改名后两端点立刻返回新名称，
  而事件历史不被改写。
- 删除会**移除已记录的事实**（事件行 + 目录行，同一事务内先删事件以满足外键），这是产品需求，
  不是 append-only 协议的一部分。把取舍留在 Runtime，库的追加式协议因此不受影响。

未注入该端口时两个端点返回 `501 CONVERSATION_MUTATION_UNSUPPORTED`，而不是返回 200 让调用方以为改成功了。

> 实现注意：Fastify 的 `Reply` 是 thenable，`await reply.code(404)` 会等待一个尚未发送的响应并让该请求
> 永久挂起。设置状态码时不要 `await`：写 `reply.code(404)` 再 `return` 响应体。
> [`sample/test/server-runtime.test.ts`](../../../sample/test/server-runtime.test.ts) 里有对应的回归断言。
