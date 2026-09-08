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
| `src/server/app.ts`         | Fastify 路由、SSE 帧、断开取消和前端展示投影      |
| `src/craft-agent/agent/*`   | 与传输无关的 Agent 门面、配置、事件和 Session API |

过渡的 `src/server/agent.ts` 与 `src/server/agent-config.ts` 已删除。模型循环、会话目录和通用输出不应再次
在 Server 中实现。

## 3. 组装规则

```ts
const agent = new Agent({
  model: {
    provider: 'deepseek',
    apiKey,
    baseURL,
    model,
  },
  tools: {
    additional: serverTools,
  },
  toolPolicy: trustedServerToolPolicy,
})

const app = createServerApp({ agent })
```

- 环境变量只在 Runtime 启动边界读取，CraftAgent 不读取 `process.env`。
- 一个进程复用一个 Agent，确保默认 MemorySessionStore 能跨请求保留 Session。
- `get_current_time` 和 `calculator` 由 Agent 自动装载，不进入 Server 工具注册表。
- 应用工具使用 `defineTool()`，再由 `defineTools()` 组成静态注册表，通过 `tools.additional` 追加。
- 当前许可策略只适用于代码仓库内受信第一方工具，不代表第三方插件安全边界。

## 4. 请求与取消

Fastify 将 `message` 映射为 `Agent.run({ input })`，将 `conversationId` 映射为 `sessionId`。浏览器断开时，
使用同一个 AbortSignal 取消 Agent Run；模型 Adapter 和 Tool Harness 会继续传播该信号。

## 5. 输出与会话投影

Fastify 只做必要字段转换：

```text
session.started   -> conversation
message.delta     -> message.delta
message.completed -> message.completed
error             -> error
```

会话列表调用 `agent.listSessions()`。标题和 `displayHistory` 在 Server 中从通用 ModelMessage 投影，不写入
CraftAgent Session 协议，也不维护第二份会话 ID Map。

完整调试轨迹可立即通过 `onTrace` 观察；轨迹的持久化、脱敏和分页 HTTP 查询仍属于下一阶段。
