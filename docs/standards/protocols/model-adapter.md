# 模型 Adapter 协议规范

> 文档类型：协议规范；状态：Accepted。

## 1. 目标与边界

ModelAdapter 把模型供应商 SDK 隔离在 craft-harness Core 之外。Core 只认识内部消息、工具定义、
非流式结果、标准流块和规范错误。API Key、base URL 与供应商参数交给具体 Adapter；模型选择随每次
`ModelRequest` 传入，使同一个连接对象可以服务多个兼容模型。

当前协议以 OpenAI Chat Completions 为兼容基线：

- 已有字段保持原名和原语义，不重新发明一套事件名称。
- craft-harness 和供应商需要的新能力通过增加可选字段表达，不能删除标准字段。
- Adapter 在运行时保留未知 chunk 字段，避免供应商或 OpenAI 增加字段后被静默丢弃。
- craft-harness 不导入 `openai` 包；结构兼容不等于依赖其 TypeScript 类型。

## 2. 公共文件

```text
src/contracts/
  message.ts
  model.ts
  model-events.ts
  model-errors.ts
```

`ModelAdapter` 同时提供：

```ts
interface ModelAdapter {
  readonly provider: string
  complete: (request, options?) => Promise<ModelCompletion>
  stream: (request, options?) => Promise<AsyncIterable<ModelStreamChunk>>
}
```

Adapter 不在内部自动重试。它只标记错误是否可能重试；当前 Agent Loop 会结合取消和预算归一化终态，
但不会自动重试模型，尤其不能在已经输出流增量后盲目重放。模型重试需要后续定义独立恢复和计费语义。

AgentLoop 根据一次 Run 的 `stream` 设置选择调用方法：`true` 调用 `stream()`，`false` 调用
`complete()`。Adapter 必须同时实现两种方法，不能由 Core 把完整响应拆成伪增量，也不能由 HTTP Runtime
把非流式结果包装成 SSE。

模型请求携带供应商无关的推理强度：

```ts
interface ModelRequest {
  /** 供应商识别的模型 ID。 */
  model: string
  /** `'off'` 是 Core 保留值，表示显式关闭推理；其他非空字符串是供应商定义的等级。 */
  reasoningEffort?: string
}
```

`AgentConfigInput.model` 与 `AgentRequest.model` 都使用 `{ id, reasoningEffort? }`；AgentLoop 在模型调用边界将
`id` 映射为 `ModelRequest.model`。推理字段在各层保持同名，不再存在 `ModelReasoningOptions`。等级集合属于“供应商 + 模型版本”的能力，不是 Agent 状态机的
不变量，因此 Adapter 只把值映射到目标协议字段并原样透传，不维护等级白名单：部署配置只自查自己的默认等级，
供应商才是最终权威。库内过期枚举会在合法输入上失败（fail closed），而供应商返回的无效请求本来就已归类为
`MODEL_INVALID_REQUEST`，错误信息也比库内旧枚举更准确。Adapter 不得静默降级为其他等级。

`'off'` 由 `contracts/model.ts` 的 `REASONING_OFF` 常量定义。Adapter 必须按这个小写字面量识别它，并翻译成
自己协议的关闭语义：DeepSeek 是 `thinking: { type: 'disabled' }` 且不下发 `reasoning_effort`，OpenAI 兼容是
`reasoning_effort: 'none'`。Core 已在上游 `normalizeReasoningEffort()` 中把保留值统一规范成小写，Adapter
无需处理大小写。省略该字段表示不下发任何推理参数，由供应商或模型自身默认值决定。

`REASONING_OFF` 是契约词汇而不是公共 API：`contracts` barrel 导出它供 Adapter 实现使用，根入口的显式导出
白名单不包含它。DeepSeek 的 `thinking` 开关完全由等级派生（`'off'` 关闭思考，其余等级一律开启），因此
“关闭却指定等级”的请求无法被构造，契约里也不存在需要防御性互斥检查的第二维状态。

## 3. 消息与工具调用

消息角色复用 Chat Completions 的 `developer`、`system`、`user`、`assistant`、`tool` 和旧版
`function`。当前 Runtime 使用纯文本内容；多模态内容在确有需求时再向现有联合类型增加分支。

函数工具调用保留以下结构：

```ts
interface FunctionToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}
```

`arguments` 保留模型生成的原始 JSON 文本。Adapter 不替 Agent 猜测或修复参数；Agent 解析为
`unknown` 后，Tool Harness 使用对应 Zod Schema 完成最终校验。这样非法 JSON、未知字段和错误类型
仍能走统一工具错误路径。

`assistant.reasoning_content` 是加法扩展。DeepSeek 思考模式要求携带工具的后续请求完整回放该字段，
包括空字符串；其他 Adapter 可以原样支持、转换为供应商等价状态或明确忽略。

## 4. 标准流块

`ModelStreamChunk` 的必需骨架与 OpenAI `ChatCompletionChunk` 一致：

```ts
interface StreamChunk {
  id: string
  choices: Array<{
    index: number
    delta: {
      role?: string | null
      content?: string | null
      refusal?: string | null
      function_call?: object
      tool_calls?: object[]
      reasoning_content?: string | null
    }
    finish_reason: string | null
    logprobs?: object | null
  }>
  created: number
  model: string
  object: 'chat.completion.chunk'
  usage?: object | null
  provider?: string
}
```

其中 `reasoning_content` 和 `provider` 是新增字段。`service_tier`、`system_fingerprint`、
`moderation`、`obfuscation`、usage、旧版 `function_call` 和自定义工具调用均保留。接口上的扩展索引
允许 Adapter 继续透传将来新增字段。

Agent 可以按 OpenAI 的 index 规则拼装跨 chunk 的工具名称和参数，因此新的 OpenAI 兼容供应商只需
把自身响应适配成该结构，不需要修改 Agent Loop。

## 5. 非流式结果与用量

`ModelCompletion` 保持 `id`、`choices`、`created`、`model`、`object`、`usage` 等 Chat
Completions 主体字段，并和 chunk 一样透传未知新增字段。用量继续使用 `prompt_tokens`、
`completion_tokens`、`total_tokens`，并保留输入、输出 token 明细和未来扩展。

通用 finish reason 至少支持：

- `stop`
- `length`
- `tool_calls`
- `content_filter`
- 旧版 `function_call`

未知字符串不得被 Adapter 强行改成 `stop`，以便新增供应商语义能够继续向上传递。

## 6. 取消与错误

每次调用通过 `ModelCallOptions.signal` 传入 `AbortSignal`。Adapter 将 SDK 异常分类为：

- 取消、连接超时。
- 鉴权失败、权限拒绝。
- 限流、上下文超限、无效请求。
- 服务不可用、协议错误和未知调用失败。

规范错误包含 `provider`、稳定 `code`、`retryable` 和可选 HTTP 状态。原始异常只作为 `cause`
保留在服务端，不能直接序列化给模型或前端。

## 7. 官方 Adapter 分层

官方 Adapter 与 Core 同仓库提供，但不是 Core 依赖：

```text
src/contracts  <-  src/adapters/openai-compatible
               <-  src/adapters/deepseek

src/index.ts  -X->  src/adapters
```

`OpenAICompatibleAdapter` 提供：

- 标准消息、工具、请求控制字段和 stream usage 请求。
- completion、chunk、tool call 和 token usage 标准化。
- 未知兼容字段保留与稳定 `provider` 来源。
- OpenAI SDK 的取消、超时、鉴权、权限、限流、无效请求和服务错误分类。
- 用于消息、请求、响应、chunk 和错误差异的 protected 模板方法。
- 将通用推理强度映射为 Chat Completions 的 `reasoning_effort`；Core 保留值 `'off'` 映射为 `none`。

通用层不得根据供应商名称执行条件分支。DeepSeek 通过差异层完成：

- `developer` 消息转换为 `system`。
- `max_completion_tokens` 转换为 `max_tokens`。
- `reasoning_content` 在流、非流响应和后续 assistant 消息中完整转换。
- 把同一根轴 `reasoningEffort` 转换为 DeepSeek 的 `thinking` 与 `reasoning_effort`：`'off'` 只发
  `thinking: { type: 'disabled' }`，其他非空等级发 `thinking: { type: 'enabled' }` 加原样透传的
  `reasoning_effort`；差异层不再维护 DeepSeek 支持的等级列表。

协议差异无法由这些明确扩展点表达时，应直接实现新的 `ModelAdapter`，不能扭曲兼容层。

## 8. 测试支持代码

`test/support` 保存 craft-harness 仓库自己的测试替身和契约断言：

- `ScriptedModelAdapter` 严格按脚本顺序输出 completion 或 chunk，捕获请求快照并响应取消。
- 脚本耗尽、调用方法错位作为 `MODEL_PROTOCOL_ERROR`，原始脚本异常作为 `MODEL_CALL_FAILED`。
- `assertModelAdapterContract()` 分别探测一次 complete 和 stream，检查最小标准骨架与 provider 一致性。

契约探针不得直接连接生产模型。供应商 Adapter 测试必须注入 SDK 客户端替身；契约探针也不能替代推理强度、
供应商请求扩展和错误映射等专项测试。

测试支持代码不从 `src/` 或 npm 公共入口导出。外部开发者通过本文的输入、输出、取消和错误规范
实现自己的契约测试；若未来形成稳定的第三方扩展需求，再单独设计 `craft-harness/testing`。

## 9. 统一配置

当前 `Agent` 使用 `defineAgentConfig()` 归一化唯一配置根，集中保存：

- `adapter`：一个显式注入的 `ModelAdapter`，持有 SDK、鉴权、base URL 和 provider 身份。
- `model: { id, reasoningEffort? }`：默认模型选择，模型 ID 必填；库不内置任何模型名或等级词表。
- system prompt、工具、Session Store、执行预算和观察器。

请求级 `model` 一旦出现，就整体替换配置级模型选择。这样从模型 A 切换到模型 B 且省略
`reasoningEffort` 时，不会误继承模型 A 的等级。模型切换无需重建 Adapter 或 Agent；只有供应商、连接或
协议变化时才应使用另一个 Adapter/Agent。

官方实现由调用方从 `craft-harness/adapters` 显式导入并实例化。库不提供全局 Adapter 注册表，也不让
`model` 接受配置对象与 Adapter 实例的联合类型；统一形状比省下一行 import 更能降低长期学习负担。

使用 OpenAI SDK 只代表复用客户端和 Chat Completions 类型，不代表流量经过 OpenAI。请求地址始终由配置的
`baseURL` 决定。只有请求结构、流事件、工具调用、鉴权或错误语义无法由兼容层表达时，才实现新 Adapter。

环境变量只在外部 Runtime 中读取，再作为显式配置传入。`defineAgentConfig()` 不访问 `process.env`。
Session Store、审批、预算和观察器位于同一配置根，而不是增加平行的全局配置入口。

## 10. 契约测试要求

- OpenAI 标准字段和未知新增字段不会被丢弃。
- content、`reasoning_content`、usage、finish reason 映射正确。
- 工具调用可以跨多个 chunk 拼装。
- assistant 的空 `reasoning_content` 也会被回放。
- 任意非空 `reasoningEffort` 原样透传为供应商等级字段，包括库不认识的等级；Core 保留值 `'off'` 得到各
  Adapter 自己的关闭语义。Adapter 内不存在等级白名单，也不得静默降级为其他等级。
- 中断和供应商错误得到稳定分类。
- `src/` 的 contracts、core、sessions 与 tools（含 `tools/builtins`）不得导入 OpenAI SDK。
- `src/agent` 只消费注入的 `ModelAdapter`，不能创建官方 Adapter 或直接消费 SDK 对象。
- 通用兼容层不得出现按供应商名称分支的请求或响应逻辑。
- DeepSeek 专项测试必须证明其差异字段没有回流到通用 Adapter。
- 核心测试不访问真实模型；真实 API 只用于单独的冒烟验收。
- 库源码不得导入 `sample/`；打包产物必须能按包名（而不是相对路径）被导入，由 `pnpm smoke:pack` 守住。
