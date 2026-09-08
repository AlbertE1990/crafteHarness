import type {
  DeepSeekModelAdapterConfig,
} from '../adapters/deepseek'
import type {
  OpenAICompatibleModelAdapterConfig,
} from '../adapters/openai-compatible'
import type { BuiltinToolName } from '../builtins/registry'
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
import { builtinToolNames, createBuiltinTools } from '../builtins/registry'
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

/** 保留默认内置工具，并允许对它们进行显式调整和追加。 */
export interface ExtendAgentToolsConfig {
  readonly mode?: 'extend'
  readonly disabledBuiltins?: readonly BuiltinToolName[]
  readonly overrides?: Readonly<Partial<Record<BuiltinToolName, AgentTool>>>
  readonly additional?: readonly AgentTool[]
}

/** 完全跳过默认内置工具，仅注册调用方给出的工具集合。 */
export interface ReplaceAgentToolsConfig {
  readonly mode: 'replace'
  readonly tools: readonly AgentTool[]
}

/** Agent 工具配置：默认扩展内置集合，也可以显式整体替换。 */
export type AgentToolsInput = ExtendAgentToolsConfig | ReplaceAgentToolsConfig

/** 创建 CraftAgent 时由开发者提供的单一配置根。 */
export interface AgentConfigInput {
  readonly model: AgentModelInput
  /** 未配置时自动装载全部内置工具。 */
  readonly tools?: AgentToolsInput
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
  const tools = createTools(input.tools)
  const limits = createLimits(input.limits)
  const systemPrompt = input.systemPrompt?.trim()
  const now = input.now ?? (() => new Date())
  const createSessionId = input.createSessionId
    ?? (() => `session-${randomUUID()}`)

  return Object.freeze({
    model,
    tools,
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

/** 将工具选择配置解析为 AgentLoop 可直接消费的最终只读集合。 */
function createTools(input: AgentToolsInput | undefined): readonly AgentTool[] {
  if (input === undefined)
    return createBuiltinTools()
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Agent config.tools 必须是工具配置对象')

  if (input.mode === 'replace') {
    rejectReplaceOnlyFields(input)
    if (!Array.isArray(input.tools))
      throw new TypeError('Agent config.tools.tools 必须是数组')
    return freezeUniqueTools(input.tools)
  }
  if (input.mode !== undefined && input.mode !== 'extend')
    throw new TypeError('Agent config.tools.mode 必须是 extend 或 replace')

  const extend = input as ExtendAgentToolsConfig
  if (extend.disabledBuiltins !== undefined
    && !Array.isArray(extend.disabledBuiltins)) {
    throw new TypeError('Agent config.tools.disabledBuiltins 必须是数组')
  }
  if (extend.additional !== undefined && !Array.isArray(extend.additional))
    throw new TypeError('Agent config.tools.additional 必须是数组')
  if (extend.overrides !== undefined
    && (typeof extend.overrides !== 'object'
      || extend.overrides === null
      || Array.isArray(extend.overrides))) {
    throw new TypeError('Agent config.tools.overrides 必须是对象')
  }

  const builtinNames = new Set<string>(builtinToolNames)
  const disabled = new Set<string>()
  for (const name of extend.disabledBuiltins ?? []) {
    if (!builtinNames.has(name))
      throw new TypeError(`未知的内置工具：${name}`)
    disabled.add(name)
  }

  const overrides = extend.overrides ?? {}
  for (const name of Object.keys(overrides)) {
    if (!builtinNames.has(name))
      throw new TypeError(`不能覆盖未知的内置工具：${name}`)
    if (disabled.has(name))
      throw new TypeError(`内置工具不能同时禁用和覆盖：${name}`)
    const tool = overrides[name as BuiltinToolName]
    if (!tool || tool.name !== name)
      throw new TypeError(`内置工具 ${name} 的覆盖实现必须使用相同名称`)
  }

  const builtins = createBuiltinTools()
  const resolved = builtins.flatMap((tool) => {
    if (disabled.has(tool.name))
      return []
    const name = tool.name as BuiltinToolName
    const override = Object.hasOwn(overrides, name) ? overrides[name] : undefined
    return [override ?? tool]
  })
  resolved.push(...(extend.additional ?? []))
  return freezeUniqueTools(resolved)
}

/** replace 是互斥模式，运行时也拒绝混入 extend 专属字段。 */
function rejectReplaceOnlyFields(input: ReplaceAgentToolsConfig): void {
  const value = input as ReplaceAgentToolsConfig & {
    readonly disabledBuiltins?: unknown
    readonly overrides?: unknown
    readonly additional?: unknown
  }
  if (value.disabledBuiltins !== undefined
    || value.overrides !== undefined
    || value.additional !== undefined) {
    throw new TypeError('Agent config.tools 的 replace 模式不能配置禁用、覆盖或追加字段')
  }
}

/** 冻结工具集合，并在 Agent 启动阶段拒绝空名称和任何重复注册。 */
function freezeUniqueTools(tools: readonly AgentTool[]): readonly AgentTool[] {
  const names = new Set<string>()
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null || typeof tool.name !== 'string' || !tool.name.trim())
      throw new TypeError('Agent 工具必须提供非空名称')
    if (names.has(tool.name))
      throw new TypeError(`Agent 工具名称重复：${tool.name}`)
    names.add(tool.name)
  }
  return Object.freeze([...tools])
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
