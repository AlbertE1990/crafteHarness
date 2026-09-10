# Server Runtime 接入规范

> 文档类型：集成规范；状态：Accepted。

## 1. 范围

当前 Fastify 服务只是 CraftAgent 的一个 Node Runtime，用于真实模型和前端联调。HTTP 路由与展示字段不是
CraftAgent 公共协议，不需要复制到产品学习文档中。

## 2. 文件职责

| 文件                        | 职责                                              |
| --------------------------- | ------------------------------------------------- |
| `src/server/index.ts`       | 读取环境变量、构造 Agent、启动监听                |
| `src/server/agent-tools.ts` | 定义并静态注册当前应用的第一方工具                |
| `src/server/app.ts`         | Fastify 路由、SSE/JSON 传输、断开取消和展示投影   |
| `src/server/database/*`     | PostgreSQL Runtime 配置、迁移和连通性检查         |
| `src/server/stores/*`       | 应用 Store；当前 Runtime 使用 PostgreSQL 实现     |
| `src/craft-agent/agent/*`   | 与传输无关的 Agent 门面、配置、事件和 Session API |

过渡的 `src/server/agent.ts` 与 `src/server/agent-config.ts` 已删除。模型循环、会话目录和通用输出不应再次
在 Server 中实现。

## 3. 组装规则

```ts
const agent = new Agent({
  model: {
    adapter: 'deepseek',
    apiKey,
    baseURL,
    model,
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

- 环境变量只在 Runtime 启动边界读取，CraftAgent 不读取 `process.env`。
- 一个进程复用一个 Agent；当前 Server 显式注入 PostgreSQL Store，进程重启后由数据库恢复 Session。
- 连接池由 Runtime 创建和关闭，不能进入 CraftAgent Core，也不能由 Store 模块在 import 时隐式创建。
- `get_current_time` 和 `calculator` 由 Agent 自动装载，不进入 Server 工具注册表。
- 应用工具使用 `defineTool()`，可直接组成普通只读数组并通过 `tools.additional` 追加；Agent 负责归一化。
- Runtime 只实现 `tools.guard(request)` 的业务风险规则；pending 审批、超时和重复提交由 Agent 管理。
- 当前风险规则只适用于代码仓库内受信第一方工具，不代表第三方插件安全边界。

## 4. 请求与取消

Fastify 将 `message` 映射为 Agent 请求的 `input`，将 `conversationId` 映射为 `sessionId`。浏览器断开时，
使用同一个 AbortSignal 取消 Agent Run；模型 Adapter 和 Tool Harness 会继续传播该信号。

当前参考服务是单用户 Runtime，因此所有聊天、详情和目录请求都显式注入 `scopeId: 'default'`。新会话把第一条
消息投影为标准 `sessionName`；`sessionMetadata` 只保存 `source` 等创建扩展。多用户服务必须改为从可信认证和
业务路由组装 scope，并在进入 Agent 前完成访问校验，不能采用浏览器传入的 scope 作为授权证明。

请求顶层的 `stream` 决定传输：`true`（默认）返回 `text/event-stream` 并调用 `agent.stream()`；`false`
返回普通 `application/json` 并调用 `agent.invoke()`，其 `data` 是封闭的 `AgentRunResult`。`model` 只包含
`reasoningEnabled/reasoningEffort`。传输方式由方法直接表达，不再维护第二个模型开关。

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
从通用 ModelMessage 投影，不写入 CraftAgent Session 协议，也不维护第二份会话 ID Map。

完整调试轨迹可立即通过 `onTrace` 观察；轨迹的持久化、脱敏和分页 HTTP 查询仍属于下一阶段。
