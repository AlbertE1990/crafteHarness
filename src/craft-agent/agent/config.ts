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
  AgentModelExecutionOptions,
  AgentTool,
  DefinedAgentModelExecutionOptions,
} from '../core'
import type {
  ToolEventListener,
} from '../tools'
import type { AgentToolInput } from './normalize-tools'
import type { DefinedToolGuardConfig, ToolGuardConfig } from './tool-guard'
import { randomUUID } from 'node:crypto'
import { DeepSeekModelAdapter } from '../adapters/deepseek'
import { OpenAICompatibleModelAdapter } from '../adapters/openai-compatible'
import { builtinToolNames, createBuiltinTools } from '../builtins/registry'
import { defineAgentModelExecutionOptions } from '../core/model-options'
import { createLimits } from '../core/stop-policy'
import { MemorySessionStore } from '../sessions'
import { normalizeAgentToolDefinitions } from './normalize-tools'
import { defineToolGuardConfig } from './tool-guard'

/** 使用内置 DeepSeek Adapter 时需要的声明式配置。 */
export interface DeepSeekAgentModelConfig extends DeepSeekModelAdapterConfig {
  /** DeepSeek 存在 thinking、reasoning 和消息回放差异，因此需要显式选择专属差异层。 */
  readonly adapter: 'deepseek'
  readonly apiKey: string
}

/**
 * 使用任意 OpenAI Chat Completions 兼容服务时需要的声明式配置。
 *
 * 这是声明式模型配置的默认分支；普通兼容供应商无需填写 adapter 或实现 ModelAdapter。
 */
export interface OpenAICompatibleAgentModelConfig
  extends Omit<OpenAICompatibleModelAdapterConfig, 'provider'> {
  readonly adapter?: 'openai-compatible'
  /** 写入模型事件的真实供应商名称，默认 `openai`。 */
  readonly provider?: string
}

/** Agent 支持内置模型配置，也允许直接传入自定义 ModelAdapter。 */
export type AgentModelInput
  = | DeepSeekAgentModelConfig
    | OpenAICompatibleAgentModelConfig
    | ModelAdapter

/** 保留默认内置工具，并允许对它们进行显式调整和追加。 */
export interface ExtendAgentToolsConfig {
  readonly mode?: 'extend'
  readonly disabledBuiltins?: readonly BuiltinToolName[]
  readonly overrides?: Readonly<Partial<Record<BuiltinToolName, AgentToolInput>>>
  readonly additional?: readonly AgentToolInput[]
}

/** 完全跳过默认内置工具，仅注册调用方给出的工具集合。 */
export interface ReplaceAgentToolsConfig {
  readonly mode: 'replace'
  readonly tools: readonly AgentToolInput[]
}

/** Agent 工具配置：默认扩展内置集合，也可以显式整体替换。 */
export type AgentToolsInput = ExtendAgentToolsConfig | ReplaceAgentToolsConfig

/** CraftAgent 生成运行、轮次、事件和审批标识时使用的稳定种类。 */
export type AgentIdKind = 'run' | 'turn' | 'event' | 'approval'

/** 宿主可注入的 ID 生成器；未注入时由 CraftAgent 生成随机 ID。 */
export type AgentIdFactory = (kind: AgentIdKind) => string

/** Session Store 与会话 ID 的宿主集成配置。 */
export interface AgentSessionConfig {
  /** 默认使用进程内 MemorySessionStore；生产环境应注入持久化实现。 */
  readonly store?: SessionStore
  /** 未指定 sessionId 时使用的 ID 生成器。 */
  readonly createSessionId?: () => string
}

/** AgentLoop 的模型调用方式、预算和确定性运行基础设施。 */
export interface AgentExecutionConfig {
  /** 所有 Run 默认采用的模型调用方式；Agent.run() 可以按次覆盖。 */
  readonly model?: AgentModelExecutionOptions
  /** 单次 Run 的模型步数、工具调用数、耗时和 Token 预算。 */
  readonly limits?: Partial<AgentLoopLimits>
  /** 测试或宿主环境可注入的时钟。 */
  readonly now?: () => Date
  /** 测试或宿主环境可注入的 Run、Turn、Event 和 Approval ID 生成器。 */
  readonly createId?: AgentIdFactory
}

/** 不参与控制流的全局轨迹与工具生命周期观察器。 */
export interface AgentObservabilityConfig {
  /** Tool Harness 的完整生命周期观察器。 */
  readonly onToolEvent?: ToolEventListener
  /** 所有低层 AgentEvent 的全局观察器。 */
  readonly onTrace?: AgentEventListener
}

/** 创建 CraftAgent 时由开发者提供的单一配置根。 */
export interface AgentConfigInput {
  readonly model: AgentModelInput
  /** Agent 的系统指令，不属于模型供应商连接配置。 */
  readonly systemPrompt?: string
  /** 未配置时自动装载全部内置工具。 */
  readonly tools?: AgentToolsInput
  /** 工具风险评估与通用审批时限的唯一配置入口；等待用户由 Agent 内部完成。 */
  readonly toolGuard?: ToolGuardConfig
  /** Session Store 和会话标识配置。 */
  readonly session?: AgentSessionConfig
  /** AgentLoop 模型调用方式、预算、时钟和运行标识配置。 */
  readonly execution?: AgentExecutionConfig
  /** 全局轨迹与工具事件观察器。 */
  readonly observability?: AgentObservabilityConfig
}

/** defineAgentConfig() 归一化后的 Session 配置。 */
export interface DefinedAgentSessionConfig {
  readonly store: SessionStore
  readonly createSessionId: () => string
}

/** defineAgentConfig() 归一化后的执行配置。 */
export interface DefinedAgentExecutionConfig {
  readonly model: DefinedAgentModelExecutionOptions
  readonly limits: AgentLoopLimits
  readonly now: () => Date
  readonly createId?: AgentIdFactory
}

/** defineAgentConfig() 归一化后的观察器配置。 */
export interface DefinedAgentObservabilityConfig {
  readonly onToolEvent?: ToolEventListener
  readonly onTrace?: AgentEventListener
}

/** defineAgentConfig() 返回的已归一化、只读配置。 */
export interface DefinedAgentConfig {
  readonly model: ModelAdapter
  readonly tools: readonly AgentTool[]
  readonly systemPrompt?: string
  readonly toolGuard: DefinedToolGuardConfig
  readonly session: DefinedAgentSessionConfig
  readonly execution: DefinedAgentExecutionConfig
  readonly observability: DefinedAgentObservabilityConfig
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
  assertKnownConfigFields(
    input,
    ['model', 'systemPrompt', 'tools', 'toolGuard', 'session', 'execution', 'observability'],
    'Agent config',
  )
  assertOptionalConfigGroup(input.session, 'session')
  assertOptionalConfigGroup(input.execution, 'execution')
  assertOptionalConfigGroup(input.observability, 'observability')
  assertKnownConfigFields(input.session, ['store', 'createSessionId'], 'Agent config.session')
  assertKnownConfigFields(input.execution, ['model', 'limits', 'now', 'createId'], 'Agent config.execution')
  assertKnownConfigFields(
    input.observability,
    ['onToolEvent', 'onTrace'],
    'Agent config.observability',
  )

  if (input.session?.store !== undefined
    && (typeof input.session.store.append !== 'function'
      || typeof input.session.store.read !== 'function')) {
    throw new TypeError('Agent config.session.store 必须实现 SessionStore')
  }
  if (input.execution?.now !== undefined && typeof input.execution.now !== 'function')
    throw new TypeError('Agent config.execution.now 必须是函数')
  if (input.execution?.createId !== undefined && typeof input.execution.createId !== 'function')
    throw new TypeError('Agent config.execution.createId 必须是函数')
  if (input.session?.createSessionId !== undefined && typeof input.session.createSessionId !== 'function')
    throw new TypeError('Agent config.session.createSessionId 必须是函数')
  if (input.observability?.onToolEvent !== undefined
    && typeof input.observability.onToolEvent !== 'function') {
    throw new TypeError('Agent config.observability.onToolEvent 必须是函数')
  }
  if (input.observability?.onTrace !== undefined
    && typeof input.observability.onTrace !== 'function') {
    throw new TypeError('Agent config.observability.onTrace 必须是函数')
  }

  const model = createModelAdapter(input.model)
  const tools = createTools(input.tools)
  const limits = createLimits(input.execution?.limits)
  const modelExecution = defineAgentModelExecutionOptions(input.execution?.model)
  const toolGuard = defineToolGuardConfig(input.toolGuard)
  const systemPrompt = input.systemPrompt?.trim()
  const now = input.execution?.now ?? (() => new Date())
  const createSessionId = input.session?.createSessionId
    ?? (() => `session-${randomUUID()}`)
  const session = Object.freeze({
    store: input.session?.store ?? new MemorySessionStore({ now }),
    createSessionId,
  })
  const execution = Object.freeze({
    model: modelExecution,
    limits,
    now,
    ...(input.execution?.createId ? { createId: input.execution.createId } : {}),
  })
  const observability = Object.freeze({
    ...(input.observability?.onToolEvent
      ? { onToolEvent: input.observability.onToolEvent }
      : {}),
    ...(input.observability?.onTrace
      ? { onTrace: input.observability.onTrace }
      : {}),
  })

  return Object.freeze({
    model,
    tools,
    ...(systemPrompt ? { systemPrompt } : {}),
    toolGuard,
    session,
    execution,
    observability,
  })
}

/** 可选配置组必须是普通对象，避免数组或原始值在归一化时被静默忽略。 */
function assertOptionalConfigGroup(value: unknown, name: string): void {
  if (value !== undefined
    && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new TypeError(`Agent config.${name} 必须是对象`)
  }
}

/** 配置边界拒绝拼写错误和已移除的扁平字段，避免 JavaScript 调用方被静默降级到默认值。 */
function assertKnownConfigFields(
  value: object | undefined,
  allowedFields: readonly string[],
  path: string,
): void {
  if (value === undefined)
    return

  const allowed = new Set(allowedFields)
  const unknownField = Object.keys(value).find(field => !allowed.has(field))
  if (unknownField)
    throw new TypeError(`${path} 包含未知字段：${unknownField}`)
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
    return freezeUniqueTools(normalizeAgentToolDefinitions(input.tools))
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
  const normalizedOverrides: Partial<Record<BuiltinToolName, AgentTool>> = {}
  for (const name of Object.keys(overrides)) {
    if (!builtinNames.has(name))
      throw new TypeError(`不能覆盖未知的内置工具：${name}`)
    if (disabled.has(name))
      throw new TypeError(`内置工具不能同时禁用和覆盖：${name}`)
    const builtinName = name as BuiltinToolName
    const source = overrides[builtinName]
    const tool = source ? normalizeAgentToolDefinitions([source])[0] : undefined
    if (!tool || tool.name !== name)
      throw new TypeError(`内置工具 ${name} 的覆盖实现必须使用相同名称`)
    normalizedOverrides[builtinName] = tool
  }

  const builtins = createBuiltinTools()
  const resolved = builtins.flatMap((tool) => {
    if (disabled.has(tool.name))
      return []
    const name = tool.name as BuiltinToolName
    const override = Object.hasOwn(normalizedOverrides, name)
      ? normalizedOverrides[name]
      : undefined
    return [override ?? tool]
  })
  const additional = normalizeAgentToolDefinitions(extend.additional ?? [])
  return freezeUniqueTools([...resolved, ...additional])
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

  const config = input as DeepSeekAgentModelConfig | OpenAICompatibleAgentModelConfig
  if (config.adapter === 'deepseek') {
    assertKnownConfigFields(
      config,
      ['adapter', 'apiKey', 'baseURL', 'model'],
      'Agent config.model',
    )
    return new DeepSeekModelAdapter({
      apiKey: config.apiKey,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      ...(config.model ? { model: config.model } : {}),
    })
  }
  if (config.adapter !== undefined && config.adapter !== 'openai-compatible')
    throw new TypeError(`不支持的 Agent model adapter：${String(config.adapter)}`)

  if (config.adapter === undefined
    && (config.provider === 'deepseek' || config.provider === 'openai-compatible')) {
    throw new TypeError(
      `Agent config.model.provider 只表示真实供应商；请选择 adapter: '${config.provider}'`,
    )
  }
  assertKnownConfigFields(
    config,
    ['adapter', 'provider', 'apiKey', 'baseURL', 'model'],
    'Agent config.model',
  )
  return new OpenAICompatibleModelAdapter({
    apiKey: config.apiKey,
    model: config.model,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.provider ? { provider: config.provider } : {}),
  })
}

/** 使用行为字段而非 adapter/provider 名称识别直接传入的自定义 Adapter。 */
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
