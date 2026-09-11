# CraftAgent 统一入口：从配置到调用

## 1. 学习目标

完成本篇后，你应该能解释：

- 为什么日常应用使用 `Agent`，高级扩展仍可直接使用 `AgentLoop`。
- `invoke()`、`stream()` 为什么分别表达非流式和流式意图。
- 公开的单个推理强度字符串如何原样流到 Adapter，并由各 Adapter 翻译成自己的协议字段。
- 标准应用事件、完整轨迹和 Session Log 为什么是三条不同通道。

## 2. 模块地图

```text
src/craft-agent/agent/
  types.ts                 # 请求、推理强度、输出和会话查询类型
  model-options.ts         # 推理强度的优先级解析与循环前设置构造
  config.ts                # 单一配置根与默认值归一化
  event-stream.ts          # 背压和消费者取消
  normalize-tools.ts       # DefinedTool 到 AgentTool 的内部归一化
  tool-approval-manager.ts # pending、超时、取消和一次性审批
  agent.ts                 # invoke/stream 门面与 Session 查询
```

推荐阅读顺序：`types.ts` → `model-options.ts` → `config.ts` → `Agent.invoke()/stream()` →
`createOutputProjector()` → `listSessions()`。

## 3. 最短正确用法

```ts
import Agent from 'craft-agent'

const agent = new Agent({
  model: {
    provider: 'my-provider',
    apiKey: process.env.MODEL_API_KEY!,
    baseURL: 'https://example.com/v1',
    model: 'example-model',
  },
  execution: {
    reasoningEffort: 'high',
  },
})

const result = await agent.invoke({
  scopeId: 'default',
  input: '给出一份完整答案',
  reasoningEffort: 'max',
}, signal)

for await (const event of agent.stream({
  scopeId: 'default',
  input: '边生成边显示答案',
  reasoningEffort: 'off',
}, signal)) {
  if (event.type === 'message.delta')
    process.stdout.write(event.delta)
}
```

环境变量由 Runtime 读取，Agent 不与部署方式耦合，也不替部署选择模型名或推理等级词表。取消是唯一的单次
控制参数，所以直接传 `AbortSignal`，不需要为了一个字段创建 `control` 对象。

## 4. 为什么拆成两个方法

旧式设计把 `stream` 放进模型选项，同时用回调接收事件。调用方可能写出“要求流式的方法 +
`stream: false`”这类矛盾配置，还需要把回调重新包装成 SSE、Web Stream 或异步迭代器。

现在由方法表达不可冲突的意图：

| 调用                       | Adapter 方法 | 返回值                            | 适合场景                    |
| -------------------------- | ------------ | --------------------------------- | --------------------------- |
| `invoke(request, signal?)` | `complete()` | `AgentRunResult`                  | 后台任务、普通 JSON         |
| `stream(request, signal?)` | `stream()`   | `AsyncIterable<AgentOutputEvent>` | SSE、CLI、实时 UI、交互审批 |

`stream()` 的通道会等待消费者接走事件。消费者较慢时，背压会向上传递；消费者提前结束 `for await`
时，Agent 自动取消当前 Run。通用库内部承担这些细节，使用者只需按语言原生方式迭代。

## 5. 全链路只有一根推理轴

调用方只写一根轴——一个顶层字符串：

```ts
const request = {
  input: '分析问题',
  reasoningEffort: 'high',
}
```

Agent 在进入 Loop 前解析优先级，然后把同一个字符串原样交给 AgentLoop：

```ts
const internalModelExecution = {
  stream: true, // 由 stream() 方法确定
  reasoningEffort: 'high', // 与公开字段同名同形，不做维度转换
}
```

规则如下：

- 请求顶层 `reasoningEffort` 覆盖 `execution.reasoningEffort` 默认值；两者都未提供时不下发任何推理参数，
  完全采用供应商或模型默认值。
- `'off'` 是唯一保留值，表示显式关闭推理；按大小写不敏感识别（`'OFF'` 等价）并统一归一化为小写 `'off'`。
- 其他任何非空字符串都是供应商定义的推理等级，原样透传，不做大小写转换，也不做等级白名单校验。
- 空白字符串（如 `' '`）在配置边界报错，错误信息带字段路径（如 `Agent request.reasoningEffort 必须是非空
字符串`）；部署配置只声明自己的默认等级和候选列表，等级是否有效最终由供应商裁定。
- 同一 Run 只归一化一次，工具调用后的后续 Step 不会改变设置。

归一化实现也随之收窄：原先校验并合并两个字段的 `defineAgentModelExecutionOptions()` 已被删除，校验与保留值
归一化统一由 Core 的 `normalizeReasoningEffort()` 负责；门面的 `resolveAgentReasoningEffort()` 只决定优先级
（请求优先、其次部署默认值），`createAgentLoopModelExecution()` 只构造进入循环前冻结的
`{ stream, reasoningEffort }`，两者都不再做任何维度分解。

旧的 `model` 分组和 `reasoningEnabled` 字段已删除，随之消失的还有“只写 effort 会隐式启用推理”和
“关闭推理时不能同时提供 effort”两条规则：单轴形态下没有第二个字段，也就无法表达出这两种矛盾状态。

为什么全链路只有一根轴？因为供应商协议的差异只是**字段布局**不同，不是**意图**不同：DeepSeek 线上把开关
（`thinking.type`）和等级（`reasoning_effort`）分成两个字段，OpenAI 兼容线协议只有一个 `reasoning_effort`。
实现过程中曾短暂保留内部两维 `{ enabled?, effort? }`，但该方案被否决：矛盾状态只是从门面搬到 Adapter，而且
同一个契约值含义并不一致——`{ enabled: true }` 对 DeepSeek 是“强制开启思考、等级用供应商默认”，对 OpenAI
兼容 Adapter 却是**什么都不下发**（被静默忽略）。因此内部契约 `ModelRequest.reasoningEffort?: string` 与公开
字段同名同形，`'off'` 到供应商字段的翻译只由每个 Adapter 在自己的差异层完成一次：DeepSeek 映射为
`thinking.type`，OpenAI 兼容映射为 `reasoning_effort: 'none'`。

## 6. 三条输出通道

- `AgentOutputEvent`：`stream()` 的业务输出，适合直接写入 SSE、WebSocket 或 CLI。
- `AgentEvent`：通过构造配置 `observability.onTrace` 观察的完整运行轨迹，观察器失败不会改变业务结果。
- Session Log：持久化的会话事实，用于恢复模型上下文，不等价于实时输出或调试轨迹。

`AgentOutputEvent` 包括 `session.started`、内容/推理增量、审批、策略拒绝、完成和错误事件。工具审批
必须走 `stream()`，因为 `invoke()` 在返回前没有交互出口，遇到 ask 会 fail-closed。

## 7. context 与 Session

`new Agent<AppContext>()` 后，每次请求必须提供 `context`。它只进入当前 Run 的 Guard 和工具执行函数，
不会写入模型消息、Session Log、标准事件或 Agent 单例。

全局 Guard 属于工具调用策略，因此和工具集合放在同一个配置组；持久化只有一个依赖，直接使用根字段：

```ts
const agent = new Agent<AppContext>({
  model,
  tools: {
    additional: [businessTool],
    guard: request => request.context.permissions.includes('tools:execute')
      ? { decision: 'allow' }
      : { decision: 'deny', reason: '没有工具执行权限' },
    approvalTimeoutMs: 120_000,
  },
  sessionStore: new PostgresSessionStore(pool),
})
```

调用方不配置 ID 工厂。Agent 使用 `session-/run-/turn-/event-/approval-` 加 UUID 生成可诊断标识；确定性 ID
注入只保留在需要精细测试的低层组件中。

`listSessions({ scopeId, search? })` 从 Store 分页读取摘要；`getSession({ scopeId, sessionId })` 按需读取一个一致快照。自定义 Store 只实现
`append/read` 仍可运行 Agent，但调用 `listSessions()` 前还需实现 `SessionCatalogStore`。

## 8. 练习

1. 用 `invoke()` 发起一次完整响应，检查 Adapter 的 `complete()` 被调用。
2. 用 `for await` 消费 `stream()`，在收到第一个事件后 `break`，观察 AbortSignal 被触发。
3. 在 `execution.reasoningEffort` 设置默认等级，再在请求顶层用 `'off'` 覆盖它，检查 Adapter 收到的
   `ModelRequest.reasoningEffort` 变为规范化的 `'off'`，并观察两种 Adapter 各自的关闭字段。
4. 创建 `new Agent<AppContext>()`，让 `tools.guard` 根据 tenantId 拒绝一次工具调用。

协议细节见[Agent 门面协议](../standards/protocols/agent.md)。
