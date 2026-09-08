# 工具定义与执行规范

> 文档类型：协议规范；状态：Accepted。

## 设计目标

工具定义必须把名称、描述、输入 Schema、成功输出 Schema 和实现放在一起。这样可以消除独立 JSON 文件、TypeScript interface 与执行函数之间的协议漂移。

工具协议分为三部分：

- 模型可见定义：名称、描述和输入 JSON Schema。
- Host 执行定义：Zod Schema、`execute()`、超时、重试和安全元数据。
- 规范执行结果：成功业务值、模型内容或结构化错误。

## 定义工具

```ts
import { z } from 'zod'
import { defineTool, ToolError } from '../src/craft-agent'

export const getWeatherTool = defineTool({
  name: 'get_weather',
  description: '查询指定城市的当前天气。',

  inputSchema: z.strictObject({
    city: z.string().min(1).describe('城市名称，例如杭州。'),
  }),

  outputSchema: z.strictObject({
    city: z.string(),
    temperatureC: z.number(),
    weather: z.string(),
  }),

  timeoutMs: 8_000,
  retry: {
    maxAttempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 2_000,
    backoff: 'exponential',
    jitterRatio: 0.2,
  },

  security: {
    risk: 'read',
    capabilities: ['network:public'],
    idempotent: true,
  },

  async execute(input, context) {
    try {
      const response = await fetchWeather(input.city, context.signal)
      return {
        city: response.city,
        temperatureC: response.temperature,
        weather: response.description,
      }
    }
    catch (error) {
      throw new ToolError({
        code: 'WEATHER_UPSTREAM_FAILED',
        message: '天气服务暂时不可用',
        retryable: true,
        cause: error,
      })
    }
  },
})
```

示例中的 `fetchWeather()` 由应用实现；工具应通过闭包注入网络或数据库依赖，不能从 CraftAgent 获取万能 service locator。

## Schema 规范

- 输入根节点及所有嵌套对象必须使用 `z.strictObject()`；输出中的对象同样如此。
- 未知字段必须被拒绝，不能静默保留或剥离；第一阶段不支持动态键 record。
- 输入和输出只能包含可无损表示为 JSON 的类型。
- 禁止在工具协议中使用 `Date`、`bigint`、`Map`、`Set`、函数和无法转换的 transform。
- `defineTool()` 在注册阶段将 Schema 转换为 Draft 7 JSON Schema；转换失败立即拒绝注册。
- `inputSchema` 是模型参数、TypeScript 输入类型和运行时校验的唯一来源。
- `outputSchema` 只验证成功业务值，第一阶段不发送给模型。

`outputSchema` 的作用是发现实现或上游协议错误、保证结果可序列化、推导返回类型，并为轨迹和组合工具提供稳定结构。工具失败使用独立的 `ToolExecutionFailure`，不需要满足业务输出 Schema。

## 内容投影

工具成功结果包含：

- `value`：通过 `outputSchema` 校验后的业务值。
- `content`：写给模型的文本。
- `attempts`：实际执行次数。
- `durationMs`：整个逻辑调用耗时。

默认投影规则是字符串原样保留，其他 JSON 值使用 `JSON.stringify()`。工具可以通过 `renderOutput()` 自定义模型内容，但不能绕过 `outputSchema`。

模型内容默认限制为 256 KiB。调用方可以降低限制，不应通过提高限制解决上下文过大的问题；大型工具应主动分页或摘要。

## 错误规范

业务工具使用 `ToolError` 表达预期错误：

```ts
throw new ToolError({
  code: 'UPSTREAM_TIMEOUT',
  message: '上游服务请求超时',
  retryable: true,
  details: { provider: 'example' },
})
```

稳定内置错误码包括：

- `INVALID_TOOL_ARGUMENTS`
- `INVALID_TOOL_OUTPUT`
- `TOOL_OUTPUT_RENDER_FAILED`
- `TOOL_OUTPUT_TOO_LARGE`
- `TOOL_POLICY_FAILED`
- `TOOL_PERMISSION_DENIED`
- `TOOL_TIMEOUT`
- `TOOL_EXECUTION_FAILED`
- `ABORTED`

未知异常默认映射成不可重试的 `TOOL_EXECUTION_FAILED`。错误详情不能包含 API Key、授权头或完整敏感输入。

当前 `ToolErrorInfo` 是可返回给模型、公开轨迹和未来会话事件的安全错误，因此不包含
`stack` 和原始 `cause`。可注入的服务端诊断日志出口尚未实现，已经列入
[分阶段开发路线图](../../product/roadmap.md)。在该能力完成前，不能把
`ToolErrorInfo` 当成完整的服务端故障日志。

## 重试规范

工具默认不重试。配置重试必须满足：

- `security.idempotent` 为 `true`。
- 本次 `ToolError.retryable` 为 `true`。
- 尚未达到 `maxAttempts`。
- 调用方没有取消 Run。

参数错误、权限拒绝、审批拒绝、取消和输出校验失败不会重试。写操作即使业务上可重试，也必须通过稳定 callId 实现幂等键后才能声明 `idempotent: true`。

同一个逻辑调用的 `callId` 在重试期间保持不变，`context.attempt` 从 1 递增。审批发生在尝试循环之前，同一调用不会因为重试而重复询问用户。

## 超时与取消

`timeoutMs` 是协作式超时。Harness 会中止 `context.signal`，工具必须观察它或传给 `fetch` 等下游 API。

JavaScript 无法安全强杀同进程同步代码。如果工具忽略信号，Harness 只能在工具最终返回后识别超时，因此禁止在工具中执行长时间同步阻塞任务；此类任务未来应放入 worker、子进程或沙箱。

## 权限与审批

工具只声明风险和所需能力，不能给自己授权。Schema 只能验证声明的形状，无法证明工具的真实行为；
当前实现假定工具注册代码来自可信的第一方开发者。Runtime 的 `ToolPolicy` 返回：

- `allow`：允许当前调用。
- `deny`：拒绝当前调用。
- `ask`：请求一次性审批。

没有自定义策略时，只自动允许 `risk: safe` 且不申请外部能力的工具。没有审批处理器、审批通道异常或无法得到明确结果时一律拒绝。只有 `allowed-once` 可以继续执行。

`safeToolPolicy` 不是 JavaScript 沙箱。恶意同进程工具可以谎报 `risk`，也可以直接使用 Node.js
文件和进程 API。未审查第三方工具必须通过部署侧可信注册、受控能力及独立进程或容器隔离，不能依赖
工具自己的 `security` 声明。完整边界见[安全与信任模型](../security/trust-model.md)。

网络、文件、数据库、进程和 secret 能力必须显式授权。参数级、资源级和租户级授权仍由业务工具或其服务依赖完成。

## 轨迹事件

Tool Harness 按顺序发送：

- `tool.call.started`
- `tool.policy.decided`
- `tool.approval.requested`
- `tool.approval.decided`
- `tool.attempt.started`
- `tool.attempt.failed`
- `tool.retry.scheduled`
- `tool.call.completed`
- `tool.call.failed`

事件监听器异常会被隔离，不能改变工具执行结果。事件目前是进程内实时事件；写入未来 Session Log 前必须经过大小限制和敏感字段脱敏。

## 内置工具

`Agent` 默认自动注册两个无外部服务依赖的安全工具：

```ts
const agent = new Agent({ model })
```

- `get_current_time`：支持 IANA 时区，可注入 Clock 做确定性测试。
- `calculator`：使用结构化运算，不使用 `eval()` 或动态代码执行。

应用可以通过 `AgentConfigInput.tools` 禁用、覆盖或整体替换内置集合，也可以使用 `additional` 只追加工具。
`createCurrentTimeTool()` 和 `createCalculatorTool()` 继续导出，用于直接使用 Tool Harness、编写测试或构造
同名覆盖实现，但应用 Runtime 不需要为了启用默认能力而手动导入它们。具体配置见
[Agent 门面协议](./agent.md#4-工具组装)。

天气和 IP 定位依赖外部服务且存在隐私语义，保留为应用示例而不是通用内置工具。文件、网络和 Shell 工具将在权限与沙箱边界稳定后再考虑。

## 测试要求

每个工具至少覆盖：

- 正常成功结果。
- 输入 Schema 拒绝。
- 输出 Schema 拒绝。
- 业务错误映射。
- 取消和超时行为。
- 若配置重试，覆盖成功重试和不可重试错误。
- 若需要外部能力，覆盖权限拒绝和审批路径。

核心测试不得调用真实模型、网络或数据库。
