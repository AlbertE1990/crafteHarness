# 本地化诊断协议

> 文档类型：规范；状态：Accepted。

## 1. 目标与边界

craft-harness 自身产生的异常、受控停止和工具失败支持 `zh-CN` 与 `en-US`。未配置时使用 `zh-CN`，
保持已有应用行为不变。`locale` 只控制面向人的诊断 `message`，不翻译以下内容：

- system prompt、用户输入、模型输出和内置工具的模型可见描述；
- ToolGuard、业务工具、第三方 ModelAdapter 或 SessionStore 主动提供的错误文本；
- OpenAI SDK、Zod、Node.js 或供应商返回的原始错误文本。

错误码、停止原因和结构化 `details` 是程序判断依据。应用不得比较本地化 `message` 来决定重试、授权或状态码。

## 2. 最短配置

应用通常只在 Agent 根配置中选择语言：

```ts
const agent = new Agent({
  locale: 'en-US',
  adapter,
  model: { id: 'model-id' },
})
```

该值会传入 AgentLoop、模型调用选项、Tool Harness、自动创建的 MemorySessionStore 和自动装载的内置工具。
项目不提供可变的全局语言 setter；多个不同语言的 Agent 可以在同一进程并发运行而不相互污染。

## 3. 独立入口

可以脱离 Agent 使用的公共组件使用同名选项：

```ts
defineTool(definition, { locale: 'en-US' })
await executeTool(tool, input, { callId, locale: 'en-US' })

const store = new MemorySessionStore({ locale: 'en-US' })
const adapter = new OpenAICompatibleAdapter({ apiKey, locale: 'en-US' })
const tools = createWorkspaceTools({ workspaceRoot, locale: 'en-US' })
```

`AgentLoopConfig`、`ModelCallOptions` 和 `ReadSessionSnapshotOptions` 也接受 `locale`。单独创建的组件负责自己的
构造期诊断；例如显式注入 `new MemorySessionStore()` 时，若希望 Store 自身直接抛出英文错误，应同样给 Store
配置 `locale: 'en-US'`。第三方实现可以读取调用选项，也可以维持自己的国际化机制。

## 4. 传播与持久化

一次 Agent Run 解析一个实例级 locale，并显式向下传递。禁止使用进程全局可变变量、环境变量或异步共享状态
暗中切换语言。

Session Log 中的 `turn.failed.error.message` 和 `turn.cancelled.reason` 是事件发生时的诊断快照，因此可能包含
当时所选语言。跨语言查询和统计必须使用 `error.code`、事件 `type` 与 `stopReason`，不能依赖历史文本。

无效 locale 无法按请求选择语言，因此拒绝信息同时包含中英文；支持列表由根入口导出的
`SUPPORTED_LOCALES` 提供，类型使用 `HarnessLocale`。

## 5. 扩展要求

新增 Harness 自产错误时必须同时提供中文和英文，并增加至少一个英文路径测试。保留外部异常时不得根据文本
猜测或翻译；应优先将其归一化为稳定错误码，并把原文作为诊断信息保留。
