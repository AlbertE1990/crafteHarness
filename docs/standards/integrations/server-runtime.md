# Server Runtime 接入规范

> 文档类型：集成规范；状态：Accepted。

## 1. 范围

当前 Fastify 服务只是 CraftAgent 的一个 Node Runtime，用于真实模型和前端联调。HTTP 路由与展示字段不是
CraftAgent 公共协议，不需要复制到产品学习文档中。

## 2. 文件职责

| 文件                         | 职责                                               |
| ---------------------------- | -------------------------------------------------- |
| `src/server/index.ts`        | 读取环境变量、构造 Agent、启动监听                 |
| `src/server/model-config.ts` | 校验并归一化 DeepSeek 部署配置（模型名、推理等级） |
| `src/server/agent-tools.ts`  | 定义并静态注册当前应用的第一方工具                 |
| `src/server/app.ts`          | Fastify 路由、SSE/JSON 传输、断开取消和展示投影    |
| `src/server/database/*`      | PostgreSQL Runtime 配置、迁移和连通性检查          |
| `src/server/stores/*`        | 应用 Store；当前 Runtime 使用 PostgreSQL 实现      |
| `src/craft-agent/agent/*`    | 与传输无关的 Agent 门面、配置、事件和 Session API  |

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

- 环境变量只在 Runtime 启动边界读取，CraftAgent 不读取 `process.env`。
- 一个进程复用一个 Agent；当前 Server 显式注入 PostgreSQL Store，进程重启后由数据库恢复 Session。
- 连接池由 Runtime 创建和关闭，不能进入 CraftAgent Core，也不能由 Store 模块在 import 时隐式创建。
- `get_current_time` 和 `calculator` 由 Agent 自动装载，不进入 Server 工具注册表。
- 应用工具使用 `defineTool()`，可直接组成普通只读数组并通过 `tools.additional` 追加；Agent 负责归一化。
- Runtime 只实现 `tools.guard(request)` 的业务风险规则；pending 审批、超时和重复提交由 Agent 管理。
- 当前风险规则只适用于代码仓库内受信第一方工具，不代表第三方插件安全边界。

Runtime 环境变量集中在 `.env.local`（模板见 `.env.example`）：

| 变量                         | 必填 | 含义                                                                                                     |
| ---------------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`           | 是   | 模型凭据                                                                                                 |
| `DEEPSEEK_MODEL`             | 是   | 模型名；缺失时在启动阶段报错，不回退到任何内置默认模型名                                                 |
| `DEEPSEEK_BASE_URL`          | 否   | 默认 `https://api.deepseek.com`                                                                          |
| `DEEPSEEK_REASONING_EFFORT`  | 否   | 部署默认等级：`off` 或供应商等级（如 `low`/`high`/`max`）；留空或未设置表示不下发该参数                  |
| `DEEPSEEK_REASONING_EFFORTS` | 否   | 逗号分隔的候选等级；未设置时默认 `off,low,high,max`，留空表示前端退化为自由输入，非空时 `off` 固定在最前 |

`DEEPSEEK_REASONING_EFFORT` 是唯一的推理开关，解析时先 trim 再小写归一，设置时必须落在非空的
`DEEPSEEK_REASONING_EFFORTS` 列表内。旧的 `DEEPSEEK_THINKING` 已删除：它原先判断
`process.env.DEEPSEEK_THINKING === 'disabled'`，于是 `DEEPSEEK_THINKING=false` 这类写法会**反过来开启**
思考。

`DEEPSEEK_REASONING_EFFORTS` 的职责只有两件事：（a）启动期校验部署自己的默认等级，（b）驱动前端下拉。
它**不校验单次请求**——请求等级由供应商最终裁定，否则运维漏更新一个等级就会让合法请求失败，正是库层要
消除的“过期枚举 fail closed”问题。核心原则是：**换模型或增删推理等级 = 改 `.env.local` + 重启**，不需要
改库，也不需要改前端代码。

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
从通用 ModelMessage 投影，不写入 CraftAgent Session 协议，也不维护第二份会话 ID Map。

完整调试轨迹可立即通过 `onTrace` 观察；轨迹的持久化、脱敏和分页 HTTP 查询仍属于下一阶段。

## 6. 模型元数据端点

`GET /api/model` 返回当前部署的模型事实，让页面无需重新构建即可跟随部署配置：

```json
{
  "data": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "reasoningEffort": "high",
    "reasoningEfforts": ["off", "low", "high", "max"]
  }
}
```

- `reasoningEffort` 是部署默认等级，未配置时为 `null`。
- `reasoningEfforts` 是下拉候选列表，来自 `DEEPSEEK_REASONING_EFFORTS`：未设置时为 `off,low,high,max`，
  显式留空时为 `[]`，此时前端退化为自由文本输入。
- 该列表只服务下拉与启动期自查，**不校验单次请求**；请求中的等级原样进入模型请求，由供应商裁定。
- 前端下拉由此渲染，不再硬编码任何供应商词表。此前 [`src/pages/index.vue`](../../../src/pages/index.vue)
  写死 `none/minimal/low/medium/high/xhigh/max`——多家供应商词表的并集，是最易腐化的地方。
- 端点只暴露部署元数据，不暴露密钥；`provider` 与 `model` 与 Agent 配置同源，不维护第二份模型配置。

推理等级词表归部署所有，模型名也归部署所有：库和前端都不再内置词表，增删等级或换模型只改 `.env.local`
并重启。这与 [模型 Adapter 协议](../protocols/model-adapter.md)中“开放字符串由 Adapter 原样透传”的分工一致。
