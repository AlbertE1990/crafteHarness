import type {
  DeepSeekModelAdapterConfig,
} from '../adapters/deepseek'
import type {
  OpenAICompatibleModelAdapterConfig,
} from '../adapters/openai-compatible'
import type {
  ModelAdapter,
  SessionStore,
} from '../contracts'
import type {
  AgentEventListener,
  AgentLoopLimits,
  AgentTool,
} from '../core'
import type {
  ToolApprovalHandler,
  ToolEventListener,
  ToolPolicy,
} from '../tools'
import { randomUUID } from 'node:crypto'
import { DeepSeekModelAdapter } from '../adapters/deepseek'
import { OpenAICompatibleModelAdapter } from '../adapters/openai-compatible'
import { createLimits } from '../core/stop-policy'
import { MemorySessionStore } from '../sessions'

/** 使用内置 DeepSeek Adapter 时需要的声明式配置。 */
export interface DeepSeekAgentModelConfig extends DeepSeekModelAdapterConfig {
  readonly provider: 'deepseek'
  readonly apiKey: string
}

/** 使用任意 OpenAI Chat Completions 兼容服务时需要的声明式配置。 */
export interface OpenAICompatibleAgentModelConfig
  extends Omit<OpenAICompatibleModelAdapterConfig, 'provider'> {
  readonly provider: 'openai-compatible'
  /** 写入模型事件的真实供应商名称，默认 `openai`。 */
  readonly providerName?: string
}

/** 兼容早期配置写法的自定义 Adapter 包装。 */
export interface CustomAgentModelConfig {
  readonly provider: 'custom'
  readonly adapter: ModelAdapter
}

/** Agent 支持内置模型配置，也允许直接传入自定义 ModelAdapter。 */
export type AgentModelInput
  = | DeepSeekAgentModelConfig
    | OpenAICompatibleAgentModelConfig
    | CustomAgentModelConfig
    | ModelAdapter

/** 创建 CraftAgent 时由开发者提供的单一配置根。 */
export interface AgentConfigInput {
  readonly model: AgentModelInput
  readonly tools?: readonly AgentTool[]
  /** 默认使用进程内 MemorySessionStore；生产环境应注入持久化实现。 */
  readonly store?: SessionStore
  readonly systemPrompt?: string
  readonly limits?: Partial<AgentLoopLimits>
  readonly toolPolicy?: ToolPolicy
  readonly requestToolApproval?: ToolApprovalHandler
  readonly onToolEvent?: ToolEventListener
  /** 所有低层 AgentEvent 的全局观察器。 */
  readonly onTrace?: AgentEventListener
  /** 测试或宿主环境可注入的时钟。 */
  readonly now?: () => Date
  /** 测试或宿主环境可注入的 Run/Turn ID 生成器。 */
  readonly createId?: (kind: 'run' | 'turn') => string
  /** 未指定 sessionId 时使用的 ID 生成器。 */
  readonly createSessionId?: () => string
}

/** defineAgentConfig() 返回的已归一化、只读配置。 */
export interface DefinedAgentConfig {
  readonly model: ModelAdapter
  readonly tools: readonly AgentTool[]
  readonly store: SessionStore
  readonly systemPrompt?: string
  readonly limits: AgentLoopLimits
  readonly toolPolicy?: ToolPolicy
  readonly requestToolApproval?: ToolApprovalHandler
  readonly onToolEvent?: ToolEventListener
  readonly onTrace?: AgentEventListener
  readonly now: () => Date
  readonly createId?: (kind: 'run' | 'turn') => string
  readonly createSessionId: () => string
}

/**
 * 校验并归一化 Agent 的完整配置。
 *
 * 直接 `new Agent(config)` 会自动调用本函数；显式调用适合在应用启动阶段提前暴露配置错误。
 * 本函数不读取环境变量，密钥和部署配置仍由外部 Runtime 负责提供。
 */
export function defineAgentConfig(input: AgentConfigInput): DefinedAgentConfig {
  if (typeof input !== 'object' || input === null)
    throw new TypeError('Agent 配置必须是对象')
  if (input.tools !== undefined && !Array.isArray(input.tools))
    throw new TypeError('Agent config.tools 必须是数组')
  if (input.store !== undefined
    && (typeof input.store.append !== 'function'
      || typeof input.store.read !== 'function')) {
    throw new TypeError('Agent config.store 必须实现 SessionStore')
  }
  if (input.now !== undefined && typeof input.now !== 'function')
    throw new TypeError('Agent config.now 必须是函数')
  if (input.createId !== undefined && typeof input.createId !== 'function')
    throw new TypeError('Agent config.createId 必须是函数')
  if (input.createSessionId !== undefined && typeof input.createSessionId !== 'function')
    throw new TypeError('Agent config.createSessionId 必须是函数')

  const model = createModelAdapter(input.model)
  const limits = createLimits(input.limits)
  const systemPrompt = input.systemPrompt?.trim()
  const now = input.now ?? (() => new Date())
  const createSessionId = input.createSessionId
    ?? (() => `session-${randomUUID()}`)

  return Object.freeze({
    model,
    tools: Object.freeze([...(input.tools ?? [])]),
    store: input.store ?? new MemorySessionStore({ now }),
    ...(systemPrompt ? { systemPrompt } : {}),
    limits,
    ...(input.toolPolicy ? { toolPolicy: input.toolPolicy } : {}),
    ...(input.requestToolApproval
      ? { requestToolApproval: input.requestToolApproval }
      : {}),
    ...(input.onToolEvent ? { onToolEvent: input.onToolEvent } : {}),
    ...(input.onTrace ? { onTrace: input.onTrace } : {}),
    now,
    ...(input.createId ? { createId: input.createId } : {}),
    createSessionId,
  })
}

/** 将声明式供应商配置或自定义实现统一转换为 ModelAdapter。 */
function createModelAdapter(input: AgentModelInput): ModelAdapter {
  if (typeof input !== 'object' || input === null)
    throw new TypeError('Agent config.model 必须是模型配置或 ModelAdapter')
  if (isModelAdapter(input)) {
    validateModelAdapter(input)
    return input
  }

  if (input.provider === 'custom') {
    validateModelAdapter(input.adapter)
    return input.adapter
  }
  if (input.provider === 'deepseek')
    return new DeepSeekModelAdapter(input)
  if (input.provider === 'openai-compatible') {
    return new OpenAICompatibleModelAdapter({
      apiKey: input.apiKey,
      model: input.model,
      ...(input.baseURL ? { baseURL: input.baseURL } : {}),
      ...(input.providerName ? { provider: input.providerName } : {}),
    })
  }

  throw new TypeError('不支持的 Agent model 配置')
}

/** 使用行为字段而非 provider 名称识别直接传入的自定义 Adapter。 */
function isModelAdapter(input: AgentModelInput): input is ModelAdapter {
  return typeof (input as ModelAdapter).complete === 'function'
    && typeof (input as ModelAdapter).stream === 'function'
}

/** 在 AgentLoop 启动前检查自定义 Adapter 的最小稳定身份。 */
function validateModelAdapter(adapter: ModelAdapter): void {
  if (typeof adapter.provider !== 'string'
    || typeof adapter.model !== 'string'
    || !adapter.provider.trim()
    || !adapter.model.trim()) {
    throw new TypeError('ModelAdapter 的 provider 和 model 不能为空')
  }
  if (typeof adapter.complete !== 'function' || typeof adapter.stream !== 'function')
    throw new TypeError('ModelAdapter 必须实现 complete() 和 stream()')
}
