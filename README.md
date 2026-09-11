# craft-harness

面向 Node.js 的 **agent harness**：一套确定性的 Agent Loop、工具 harness、追加式 Session Log 和供应商无关的模型契约，
用来把"模型 + 工具 + 会话事实"组装成可观测、可取消、有预算的 Agent，而不是把编排逻辑散落在业务代码里。

与 HTTP、数据库和前端解耦：库本身不读环境变量、不依赖 Fastify/pg/Vue，也不替调用方决定密钥和模型名。

```bash
pnpm add craft-harness openai zod
```

`zod` 是必需 peer dependency，用于工具 Schema。`openai` 是可选 peer dependency：只有导入
`craft-harness/adapters` 的官方 OpenAI Compatible 或 DeepSeek Adapter 时才需要安装。

## 最短可用路径

```ts
import Agent from 'craft-harness'
import { DeepSeekAdapter } from 'craft-harness/adapters'

const agent = new Agent({
  locale: 'zh-CN', // 改为 en-US 可获得英文 Harness 诊断
  adapter: new DeepSeekAdapter({
    apiKey: process.env.DEEPSEEK_API_KEY!,
  }),
  model: {
    id: process.env.DEEPSEEK_MODEL!, // 模型 ID 属于部署配置
    reasoningEffort: 'high', // 'off' 关闭推理；省略则用供应商默认
  },
  systemPrompt: '你是一个可靠的助手。',
  tools: {
    workspaceRoot: process.cwd(),
  },
})

const result = await agent.invoke({
  scopeId: 'tenant-42', // Session 数据分区，必须显式提供
  input: '杭州天气怎么样？',
})

console.log(result.status, result.content)
```

流式输出用 `agent.stream()`，两者的差异只体现在方法名上：

```ts
for await (const event of agent.stream({ scopeId: 'tenant-42', input: '讲个笑话' })) {
  // event 是可直接转发的标准应用事件：message.delta / message.completed / tool.* / error
}
```

## 能力概览

| 能力               | 说明                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| 确定性 Agent Loop  | 显式预算（模型步数、工具调用数、耗时、Token）、协作式取消、封闭停止原因，不把预算耗尽伪装成异常 |
| 工具 harness       | `defineTool()` 用 Zod 声明输入输出与执行函数；参数级 Guard + Agent 级 Guard + 交互式审批        |
| 工作区内置工具     | 配置 `workspaceRoot` 后提供文件读写、glob/grep 与一次性终端；高风险操作默认审批                 |
| 追加式 Session Log | 事件只追加不覆盖，消息从固定快照推导；`SessionStore` 是可替换的持久化 Port（内置内存实现）      |
| 供应商无关模型契约 | `ModelAdapter` 是 Core 唯一依赖；官方提供 OpenAI 兼容与 DeepSeek 两个差异层                     |
| 标准应用事件       | `AgentOutputEvent` 可被 Runtime 直接输出，不需要为前端再裁剪一套协议                            |
| 双语诊断           | Harness 自产异常支持实例级 `zh-CN` / `en-US`，错误码和控制流不随语言变化                        |

## 高级入口

```ts
// 直接用 AgentLoop（跳过门面，自行组装 Store 与工具）
import { AgentLoop, createAgentTool } from 'craft-harness'
// 供应商 Adapter 与自定义实现
import { DeepSeekAdapter, OpenAICompatibleAdapter } from 'craft-harness/adapters'
```

任何 OpenAI Chat Completions 兼容服务都只需要改 `baseURL` 和模型名，不需要新写 Adapter：

```ts
const agent = new Agent({
  adapter: new OpenAICompatibleAdapter({
    provider: 'moonshot',
    apiKey: '...',
    baseURL: 'https://api.moonshot.cn/v1',
  }),
  model: { id: 'kimi-k3' },
})
```

需要租户、用户或环境级约束时，用 `new Agent<AppContext>()` 并在请求里传入由**服务端认证结果**构造的
`context`；它只进入当前 Run 的 Guard 与工具执行函数，不会被发给模型、前端或 Session Store。

## 官方案例

`sample/` 是一个完整的可运行案例：Fastify + PostgreSQL + Vue 聊天界面，包含流式事件直出、
工具审批卡片、多会话与可搜索会话目录。它**不参与发布**（`files` 只包含 `dist`），演示了如何把
harness 组装成一个真实 Runtime。

```bash
cp sample/.env.example sample/.env.local   # 填 DEEPSEEK_API_KEY 等
pnpm db:migrate                            # 需要本地 PostgreSQL
pnpm dev                                   # 后端 :3000 + 前端 :3333
```

## 开发

```bash
pnpm install
pnpm test          # 库测试（node 环境）+ 案例测试（jsdom）两个 project 一起跑
pnpm typecheck     # 库用 tsc，案例用 vue-tsc
pnpm lint
pnpm build         # 构建要发布的库产物到 dist/
pnpm build:sample  # 构建案例前端
pnpm smoke:pack    # 打包冒烟测试：npm pack 后按包名导入一次真实产物
```

`pnpm smoke:pack` 是发布前最该跑的一步：案例通过相对路径导入源码，因此它验证不了 `exports` 映射、
`files` 白名单和类型声明是否完整，只有冒烟测试能覆盖这一段。

## 文档

- [文档总览](./docs/README.md)
- [总体架构](./docs/standards/architecture.md)
- [Agent 门面协议](./docs/standards/protocols/agent.md)
- [Agent Loop 协议](./docs/standards/protocols/agent-loop.md)
- [模型 Adapter 协议](./docs/standards/protocols/model-adapter.md)
- [学习路径](./docs/learning/README.md)

## License

MIT
