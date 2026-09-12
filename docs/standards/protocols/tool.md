# 工具定义与执行规范

> 文档类型：协议规范；状态：Accepted。

## 1. 设计目标

工具定义把名称、模型描述、输入 Schema、成功输出 Schema、业务标签、局部 Guard、执行策略和实现放在
一起。普通应用只调用 `defineTool()`，再把结果交给 `new Agent({ tools })`；Schema 编译、类型擦除、
Guard 合并、审批、重试和结果归一化都由 craft-harness 内部完成。

模型只能看到 `name`、`description` 和 `inputSchema`。以下内容永远不会发送给模型：

- `outputSchema` 和 `execute()`；
- `metadata` 与 `guard`；
- `execution.timeoutMs/retry`；
- 当前 `agent.invoke()/stream()` 请求的 `context`。

## 2. 定义工具

```ts
import { defineTool, ToolError, z } from 'craft-harness'

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

  // 任意 JSON 安全业务标签。craft-harness 不解释 risk/capabilities 的含义。
  metadata: {
    risk: 'read',
    capabilities: ['network:public'],
    domain: 'weather',
  },

  // 工具固有且依赖本次参数的规则写在这里；缺省表示这一层 allow。
  guard(request) {
    return request.input.city === '内部机房'
      ? { decision: 'deny', reason: '该位置不允许通过公共天气服务查询' }
      : { decision: 'allow' }
  },

  execution: {
    timeoutMs: 8_000,
    retry: {
      maxAttempts: 3,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
      backoff: 'exponential',
      jitterRatio: 0.2,
    },
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

工具通过闭包接收网络、数据库或领域服务，不能从 craft-harness 获取万能 service locator。

## 3. Schema 与 metadata

- 输入根节点及所有嵌套对象必须使用 `z.strictObject()`，输出中的对象同样如此。
- 输入输出只能包含可无损表示为 JSON 的类型；动态键 record 暂不属于支持子集。
- `inputSchema` 是模型参数、TypeScript 输入类型和运行时校验的唯一来源。
- `outputSchema` 用于发现实现或上游协议错误、推导成功值类型并稳定轨迹结构；当前不发送给模型。
- `defineTool()` 在注册期转换 Draft 7 JSON Schema，并检查所有对象拒绝未知字段。
- `metadata` 必须是无循环引用的普通 JSON 对象；未配置时归一化为冻结的空对象。
- metadata 的字段名和嵌套结构由应用决定。craft-harness 不根据 `risk`、`capabilities` 等字段自动授权。

## 4. 运行上下文

`ToolRunContext<TContext>` 包含：

```ts
interface ToolRunContext<TContext> {
  callId: string
  runId?: string
  sessionId?: string
  attempt: number
  context: TContext
  signal: AbortSignal
}
```

`context` 来自当前 Agent 请求。它用于传递租户、用户、角色、部署环境或请求级服务，
只在本次 Run 内存在；craft-harness 不会把它发送给模型、写入 Session Log、发给前端或保存在 Agent 单例。

## 5. 两层 Tool Guard

每次已通过输入校验的调用最多经过两层 Guard：

1. 工具级 `defineTool({ guard })`：判断工具固有、参数相关的风险。
2. Agent 全局 `tools.guard`：判断部署、租户、用户、角色和环境约束。

缺少某一层等价于该层返回 `allow`；两层都缺少时工具直接执行。配置了两层时，两层按“工具级 → 全局”
顺序执行，最终结果按以下固定优先级合并：

```text
deny > ask > allow
```

- 任一层 deny：拒绝当前工具调用。
- 没有 deny、任一层 ask：创建一次用户审批。
- 两层均 allow 或均缺省：进入执行尝试。
- 两层同时 ask：有限审批时限取较小值；`-1` 只在没有有限时限时生效。
- 两层同时给出 reason/details/metadata 时，craft-harness 使用来源命名空间合并。
- 任一 Guard 抛错或返回非法结构：产生 `TOOL_GUARD_FAILED`，业务 `execute()` 不运行。

Guard 只返回 `allow | deny | ask`，不直接执行工具，也不自己等待前端。Agent 内部负责审批 ID、pending
Promise、超时、取消和重复提交。

两层共用 `ToolGuardRequest<TContext, TInput, TMetadata>` 和 `ToolGuardDecision`。Harness 在 Zod 校验后只构造
一次请求对象，先后原样传给局部和全局 Guard；因此 `callId/runId/sessionId/tool/input/context/signal` 完全一致。
局部 Guard 保留 Schema 推导出的 input 类型；全局 Guard 因面对多个异构工具，将 input 视为 `unknown`，
需要按 `request.tool.name` 进行业务收窄。

### 5.1 修改内置工具 Guard

```ts
const agent = new Agent({
  model,
  tools: {
    guardOverrides: {
      calculator: request =>
        request.context.environment === 'production'
          ? { decision: 'deny', reason: '生产环境禁用计算器' }
          : { decision: 'allow' },
      // null 明确移除内置工具自己的 Guard；全局 Guard 仍会执行。
      get_current_time: null,
    },
  },
})
```

`guardOverrides` 只改变内置工具的局部 Guard，不替换实现，不跳过全局 Guard。

## 6. 审批决定

```ts
type ToolGuardDecision
  = | { decision: 'allow', metadata?: JsonObject }
    | { decision: 'deny', reason: string, metadata?: JsonObject }
    | {
      decision: 'ask'
      reason: string
      title?: string
      details?: JsonObject
      approvalTimeoutMs?: number
      metadata?: JsonObject
    }
```

单次 `approvalTimeoutMs` 高于 Agent 通用值；正整数表示毫秒，`-1` 表示不自动过期。用户拒绝、
自动拒绝和审批不可用都只形成当前工具的失败结果，由 AgentLoop 写回 `role=tool` 后继续下一 Model Step。

## 7. 重试、超时与取消

工具默认不重试。配置 `execution.retry` 即表示工具作者明确授权 craft-harness 对同一 `callId` 重复调用
`execute()`。框架不再要求或验证单独的 `idempotent` 声明，因为它无法证明实际业务副作用。

一次重试必须同时满足：

- 已配置 `execution.retry`；
- 本次规范错误的 `retryable === true`；
- 尚未达到 `maxAttempts`；
- Run 没有取消。

写操作若启用重试，工具作者必须自行使用 `callId` 幂等键、上游幂等协议或数据库唯一约束消除重复副作用。
`maxAttempts` 包含首次执行；审批发生在 attempt 循环之前，不会因重试重复询问。

`execution.timeoutMs` 是协作式超时。Harness 会中止 `context.signal`，工具必须观察该信号或传给下游。
JavaScript 无法强杀忽略信号的同进程同步代码。

## 8. 结果、错误与轨迹

成功结果包含经过 `outputSchema` 校验的 `value`、模型可见 `content`、`attempts` 和
`durationMs`。字符串默认原样投影，其余 JSON 值使用 `JSON.stringify()`；`renderOutput()` 可改变
投影但不能绕过输出校验。

稳定内置错误码包括：

- `INVALID_TOOL_ARGUMENTS`
- `INVALID_TOOL_OUTPUT`
- `TOOL_OUTPUT_RENDER_FAILED`
- `TOOL_OUTPUT_TOO_LARGE`
- `TOOL_GUARD_FAILED`
- `TOOL_PERMISSION_DENIED`
- `TOOL_TIMEOUT`
- `TOOL_EXECUTION_FAILED`
- `ABORTED`

`ToolErrorInfo` 是面向模型和公开轨迹的安全错误，不包含 stack/cause。完整异常诊断出口仍列在后续阶段。

Tool Harness 按实际路径发出以下事件：

- `tool.call.started`
- `tool.guard.decided`
- `tool.approval.requested`
- `tool.approval.decided`
- `tool.attempt.started`
- `tool.attempt.failed`
- `tool.retry.scheduled`
- `tool.call.completed`
- `tool.call.failed`

观察器属于旁路，抛错不能改变工具结果。

## 9. 安全边界与测试

Tool Guard 是可信代码中的执行前决策点，不是 Node.js 沙箱。metadata 是应用自定义数据，也不是能力证明。
本阶段以可信第一方开发者为前提；第三方插件隔离、来源签名和 OS 级能力控制保持低优先级。

每个工具至少测试：合法输入、非法输入零执行、错误输出、Guard 三种决定、上下文传递、超时取消，以及配置
重试时的 retryable/non-retryable 分支。两层 Guard 还应测试执行顺序和 `deny > ask > allow`。
