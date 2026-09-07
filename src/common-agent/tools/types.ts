import type { z } from 'zod'
import type { JsonSchema } from '../types/json'

/** 同时兼容同步工具与异步工具的返回类型。 */
export type MaybePromise<T> = T | Promise<T>

/** 工具对外部世界可能产生的影响等级。 */
export type ToolRisk = 'safe' | 'read' | 'write' | 'destructive'

/** 工具执行失败后再次尝试的退避策略。 */
export interface ToolRetryPolicy {
  /** 包含首次执行在内的最大尝试次数。 */
  readonly maxAttempts: number
  /** 第一次重试前的等待时间。 */
  readonly baseDelayMs: number
  /** 单次等待时间上限。 */
  readonly maxDelayMs: number
  /** 默认使用指数退避。 */
  readonly backoff?: 'fixed' | 'exponential'
  /** 0 至 1 之间的随机抖动比例，默认 0.2。 */
  readonly jitterRatio?: number
}

/**
 * 工具作者声明的风险信息；最终是否允许执行仍由 Runtime 策略决定。
 *
 * 这些字段是供可信注册流程审查的元数据，不是对任意工具代码的安全证明。
 */
export interface ToolSecurityMetadata {
  readonly risk: ToolRisk
  /** 工具需要的外部能力，例如 `network:public` 或 `filesystem:read`。 */
  readonly capabilities?: readonly string[]
  /**
   * 工具作者声明重放相同调用不会产生额外副作用。
   * Harness 无法从任意业务代码中自动证明该声明，写操作仍需真实幂等键和集成测试。
   */
  readonly idempotent: boolean
}

/** Harness 传给单次工具尝试的只读执行上下文。 */
export interface ToolRunContext {
  readonly callId: string
  readonly runId?: string
  readonly sessionId?: string
  readonly attempt: number
  /** 工具必须观察或继续向下游传递此取消信号。 */
  readonly signal: AbortSignal
}

/** 发给模型 adapter 的供应商无关工具描述。 */
export interface ToolModelDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
}

/**
 * 工具作者填写的完整定义。
 *
 * 输入和成功输出都以 Zod 为唯一类型来源；执行策略字段永远不会发送给模型。
 */
export interface ToolDefinition<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
> {
  /** 稳定工具名，只允许字母、数字、下划线和连字符。 */
  readonly name: string
  /** 说明工具能力及适用时机的模型可见描述。 */
  readonly description: string
  /** 模型参数、TypeScript 推导和运行时输入校验的唯一来源。 */
  readonly inputSchema: TInputSchema
  /** 成功业务值的 TypeScript 推导和运行时校验规范。 */
  readonly outputSchema: TOutputSchema
  /** 单次尝试的协作式超时；同进程代码无法被强制终止。 */
  readonly timeoutMs?: number
  /** 默认不重试；配置重试时工具必须声明为幂等。 */
  readonly retry?: ToolRetryPolicy
  /** 权限策略使用的声明信息，不代表已经取得授权。 */
  readonly security: ToolSecurityMetadata
  /** 将校验后的成功值投影为模型可见文本，默认安全 JSON 序列化。 */
  readonly renderOutput?: (value: z.output<TOutputSchema>) => string
  /** 执行业务逻辑并返回 outputSchema 可接受的原始值。 */
  execute: (
    input: z.output<TInputSchema>,
    context: ToolRunContext,
  ) => MaybePromise<z.input<TOutputSchema>>
}

/** 经过注册期检查并缓存 JSON Schema 的可执行工具。 */
export interface DefinedTool<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
> extends ToolDefinition<TInputSchema, TOutputSchema> {
  /** adapter 只读取该投影，不会接触 execute 或安全策略。 */
  readonly model: ToolModelDefinition
  /** 供文档、轨迹和未来组合工具读取的成功输出 Schema。 */
  readonly outputJsonSchema: JsonSchema
}
