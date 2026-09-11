import type {
  ModelAdapter,
  ModelSelection,
  SessionStore,
} from '../contracts'
import type {
  AgentEventListener,
  AgentLoopLimits,
  AgentTool,
} from '../core'
import type {
  ToolEventListener,
  ToolGuardEvaluator,
} from '../tools'
import type { BuiltinToolName } from '../tools/builtins/registry'
import type { AgentToolInput } from './normalize-tools'
import { normalizeModelId, normalizeReasoningEffort } from '../core'
import { createLimits } from '../core/stop-policy'
import { MemorySessionStore } from '../sessions'
import { builtinToolNames, createBuiltinTools } from '../tools/builtins/registry'
import { normalizeAgentToolDefinitions } from './normalize-tools'
import { defineToolGuardConfig } from './tool-guard'

/** 两种工具集合模式共用的全局 Guard 和审批设置。 */
export interface AgentToolsCommonConfig<TContext = undefined> {
  /** 与工具自身 guard 使用相同请求和决定协议的 Agent 级全局 Guard。 */
  readonly guard?: ToolGuardEvaluator<TContext>
  /** Guard 返回 ask 且未指定时限时采用的毫秒数；-1 表示不自动过期。 */
  readonly approvalTimeoutMs?: number
}

/** 保留默认内置工具，并允许对它们进行显式调整和追加。 */
export interface ExtendAgentToolsConfig<TContext = undefined>
  extends AgentToolsCommonConfig<TContext> {
  readonly mode?: 'extend'
  /** 文件、搜索和终端内置工具的工作区边界；省略时不装载这些工作区工具。 */
  readonly workspaceRoot?: string
  readonly disabledBuiltins?: readonly BuiltinToolName[]
  readonly overrides?: Readonly<Partial<Record<BuiltinToolName, AgentToolInput<TContext>>>>
  readonly additional?: readonly AgentToolInput<TContext>[]
  /**
   * 只替换内置工具自身的局部 Guard。传函数表示替换，传 null 表示移除；全局 Guard 始终照常执行。
   */
  readonly guardOverrides?: Readonly<Partial<Record<
    BuiltinToolName,
    ToolGuardEvaluator<TContext> | null
  >>>
}

/** 完全跳过默认内置工具，仅注册调用方给出的工具集合。 */
export interface ReplaceAgentToolsConfig<TContext = undefined>
  extends AgentToolsCommonConfig<TContext> {
  readonly mode: 'replace'
  readonly tools: readonly AgentToolInput<TContext>[]
}

/** Agent 工具配置：默认扩展内置集合，也可以显式整体替换。 */
export type AgentToolsInput<TContext = undefined>
  = ExtendAgentToolsConfig<TContext> | ReplaceAgentToolsConfig<TContext>

/** AgentLoop 的预算和确定性运行基础设施。 */
export interface AgentExecutionConfig {
  /** 单次 Run 的模型步数、工具调用数、耗时和 Token 预算。 */
  readonly limits?: Partial<AgentLoopLimits>
  /** 测试或宿主环境可注入的时钟。 */
  readonly now?: () => Date
}

/** 不参与控制流的全局轨迹与工具生命周期观察器。 */
export interface AgentObservabilityConfig {
  /** Tool Harness 的完整生命周期观察器。 */
  readonly onToolEvent?: ToolEventListener
  /** 所有低层 AgentEvent 的全局观察器。 */
  readonly onTrace?: AgentEventListener
}

/** 创建 CraftAgent 时由开发者提供的单一配置根。 */
export interface AgentConfigInput<TContext = undefined> {
  /** 处理供应商连接、鉴权和线协议，不绑定具体模型。 */
  readonly adapter: ModelAdapter
  /** 默认模型选择；请求级 model 会整体替换它。 */
  readonly model: ModelSelection
  /** Agent 的系统指令，不属于模型供应商连接配置。 */
  readonly systemPrompt?: string
  /** 未配置时自动装载不依赖工作区的内置工具。 */
  readonly tools?: AgentToolsInput<TContext>
  /** 默认使用 MemorySessionStore；生产环境可直接注入持久化实现。 */
  readonly sessionStore?: SessionStore
  /** AgentLoop 模型默认值、预算和时钟配置。 */
  readonly execution?: AgentExecutionConfig
  /** 全局轨迹与工具事件观察器。 */
  readonly observability?: AgentObservabilityConfig
}

/** defineAgentConfig() 归一化后的工具集合与全局策略。 */
export interface DefinedAgentToolsConfig<TContext = undefined> {
  readonly registered: readonly AgentTool<TContext>[]
  readonly guard?: ToolGuardEvaluator<TContext>
  readonly approvalTimeoutMs: number
}

/** defineAgentConfig() 归一化后的执行配置。 */
export interface DefinedAgentExecutionConfig {
  readonly limits: AgentLoopLimits
  readonly now: () => Date
}

/** defineAgentConfig() 归一化后的观察器配置。 */
export interface DefinedAgentObservabilityConfig {
  readonly onToolEvent?: ToolEventListener
  readonly onTrace?: AgentEventListener
}

/** defineAgentConfig() 返回的已归一化、只读配置。 */
export interface DefinedAgentConfig<TContext = undefined> {
  readonly adapter: ModelAdapter
  readonly model: Readonly<ModelSelection>
  readonly tools: DefinedAgentToolsConfig<TContext>
  readonly systemPrompt?: string
  readonly sessionStore: SessionStore
  readonly execution: DefinedAgentExecutionConfig
  readonly observability: DefinedAgentObservabilityConfig
}

/**
 * 校验并归一化 Agent 的完整配置。
 *
 * 直接 `new Agent(config)` 会自动调用本函数；显式调用适合在应用启动阶段提前暴露配置错误。
 * 本函数不读取环境变量，密钥和部署配置仍由外部 Runtime 负责提供。
 */
export function defineAgentConfig<TContext = undefined>(
  input: AgentConfigInput<TContext>,
): DefinedAgentConfig<TContext> {
  if (typeof input !== 'object' || input === null)
    throw new TypeError('Agent 配置必须是对象')
  assertKnownConfigFields(
    input,
    ['adapter', 'model', 'systemPrompt', 'tools', 'sessionStore', 'execution', 'observability'],
    'Agent config',
  )
  assertOptionalConfigGroup(input.execution, 'execution')
  assertOptionalConfigGroup(input.observability, 'observability')
  assertKnownConfigFields(input.execution, ['limits', 'now'], 'Agent config.execution')
  assertKnownConfigFields(
    input.observability,
    ['onToolEvent', 'onTrace'],
    'Agent config.observability',
  )

  if (input.sessionStore !== undefined
    && (typeof input.sessionStore.append !== 'function'
      || typeof input.sessionStore.read !== 'function')) {
    throw new TypeError('Agent config.sessionStore 必须实现 SessionStore')
  }
  if (input.execution?.now !== undefined && typeof input.execution.now !== 'function')
    throw new TypeError('Agent config.execution.now 必须是函数')
  if (input.observability?.onToolEvent !== undefined
    && typeof input.observability.onToolEvent !== 'function') {
    throw new TypeError('Agent config.observability.onToolEvent 必须是函数')
  }
  if (input.observability?.onTrace !== undefined
    && typeof input.observability.onTrace !== 'function') {
    throw new TypeError('Agent config.observability.onTrace 必须是函数')
  }

  validateModelAdapter(input.adapter)
  const model = defineModelSelection(input.model, 'Agent config.model')
  const registeredTools = createTools<TContext>(input.tools)
  const limits = createLimits(input.execution?.limits)
  const guardConfig = defineToolGuardConfig(
    input.tools?.guard,
    input.tools?.approvalTimeoutMs,
  )
  const systemPrompt = input.systemPrompt?.trim()
  const now = input.execution?.now ?? (() => new Date())
  const tools = Object.freeze({
    registered: registeredTools,
    ...(guardConfig.guard ? { guard: guardConfig.guard } : {}),
    approvalTimeoutMs: guardConfig.approvalTimeoutMs,
  })
  const execution = Object.freeze({
    limits,
    now,
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
    adapter: input.adapter,
    model,
    tools,
    ...(systemPrompt ? { systemPrompt } : {}),
    sessionStore: input.sessionStore ?? new MemorySessionStore({ now }),
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
function createTools<TContext = undefined>(
  input: AgentToolsInput<TContext> | undefined,
): readonly AgentTool<TContext>[] {
  if (input === undefined)
    return createBuiltinTools<TContext>()
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Agent config.tools 必须是工具配置对象')

  if (input.mode === 'replace') {
    rejectReplaceOnlyFields(input)
    assertKnownConfigFields(
      input,
      ['mode', 'tools', 'guard', 'approvalTimeoutMs'],
      'Agent config.tools',
    )
    if (!Array.isArray(input.tools))
      throw new TypeError('Agent config.tools.tools 必须是数组')
    return freezeUniqueTools(normalizeAgentToolDefinitions<TContext>(input.tools))
  }
  if (input.mode !== undefined && input.mode !== 'extend')
    throw new TypeError('Agent config.tools.mode 必须是 extend 或 replace')

  const extend = input as ExtendAgentToolsConfig<TContext>
  assertKnownConfigFields(
    extend,
    [
      'mode',
      'workspaceRoot',
      'disabledBuiltins',
      'overrides',
      'additional',
      'guardOverrides',
      'guard',
      'approvalTimeoutMs',
    ],
    'Agent config.tools',
  )
  if (extend.disabledBuiltins !== undefined
    && !Array.isArray(extend.disabledBuiltins)) {
    throw new TypeError('Agent config.tools.disabledBuiltins 必须是数组')
  }
  if (extend.additional !== undefined && !Array.isArray(extend.additional))
    throw new TypeError('Agent config.tools.additional 必须是数组')
  if (extend.workspaceRoot !== undefined
    && (typeof extend.workspaceRoot !== 'string' || !extend.workspaceRoot.trim())) {
    throw new TypeError('Agent config.tools.workspaceRoot 必须是非空字符串')
  }
  if (extend.overrides !== undefined
    && (typeof extend.overrides !== 'object'
      || extend.overrides === null
      || Array.isArray(extend.overrides))) {
    throw new TypeError('Agent config.tools.overrides 必须是对象')
  }
  if (extend.guardOverrides !== undefined
    && (typeof extend.guardOverrides !== 'object'
      || extend.guardOverrides === null
      || Array.isArray(extend.guardOverrides))) {
    throw new TypeError('Agent config.tools.guardOverrides 必须是对象')
  }

  const builtinNames = new Set<string>(builtinToolNames)
  const disabled = new Set<string>()
  for (const name of extend.disabledBuiltins ?? []) {
    if (!builtinNames.has(name))
      throw new TypeError(`未知的内置工具：${name}`)
    disabled.add(name)
  }

  const overrides = extend.overrides ?? {}
  const normalizedOverrides: Partial<Record<BuiltinToolName, AgentTool<TContext>>> = {}
  for (const name of Object.keys(overrides)) {
    if (!builtinNames.has(name))
      throw new TypeError(`不能覆盖未知的内置工具：${name}`)
    if (disabled.has(name))
      throw new TypeError(`内置工具不能同时禁用和覆盖：${name}`)
    const builtinName = name as BuiltinToolName
    const source = overrides[builtinName]
    const tool = source ? normalizeAgentToolDefinitions<TContext>([source])[0] : undefined
    if (!tool || tool.name !== name)
      throw new TypeError(`内置工具 ${name} 的覆盖实现必须使用相同名称`)
    normalizedOverrides[builtinName] = tool
  }

  const guardOverrides = extend.guardOverrides ?? {}
  for (const name of Object.keys(guardOverrides)) {
    if (!builtinNames.has(name))
      throw new TypeError(`不能覆盖未知内置工具的 Guard：${name}`)
    if (disabled.has(name))
      throw new TypeError(`内置工具不能同时禁用和覆盖 Guard：${name}`)
    const guard = guardOverrides[name as BuiltinToolName]
    if (guard !== null && guard !== undefined && typeof guard !== 'function')
      throw new TypeError(`内置工具 ${name} 的 Guard 覆盖必须是函数或 null`)
  }

  const builtins = createBuiltinTools<TContext>({
    ...(extend.workspaceRoot ? { workspaceRoot: extend.workspaceRoot } : {}),
  })
  const resolved = builtins.flatMap((tool) => {
    if (disabled.has(tool.name))
      return []
    const name = tool.name as BuiltinToolName
    const override = Object.hasOwn(normalizedOverrides, name)
      ? normalizedOverrides[name]
      : undefined
    const selected = override ?? tool
    if (!Object.hasOwn(guardOverrides, name))
      return [selected]
    const guard = guardOverrides[name] ?? null
    const execute: AgentTool<TContext>['execute'] = (rawInput, options) => (
      selected.execute(rawInput, {
        ...options,
        guardOverride: guard,
      })
    )
    return [Object.freeze({
      ...selected,
      guard,
      // 将覆盖收进注册项本身，直接调用 AgentTool.execute() 与经 AgentLoop 调用保持一致。
      execute,
    })]
  })
  const additional = normalizeAgentToolDefinitions<TContext>(extend.additional ?? [])
  return freezeUniqueTools([...resolved, ...additional])
}

/** replace 是互斥模式，运行时也拒绝混入 extend 专属字段。 */
function rejectReplaceOnlyFields<TContext>(input: ReplaceAgentToolsConfig<TContext>): void {
  const value = input as ReplaceAgentToolsConfig<TContext> & {
    readonly disabledBuiltins?: unknown
    readonly overrides?: unknown
    readonly additional?: unknown
    readonly guardOverrides?: unknown
    readonly workspaceRoot?: unknown
  }
  if (value.disabledBuiltins !== undefined
    || value.overrides !== undefined
    || value.additional !== undefined
    || value.guardOverrides !== undefined
    || value.workspaceRoot !== undefined) {
    throw new TypeError('Agent config.tools 的 replace 模式不能配置 workspaceRoot、禁用、覆盖或追加字段')
  }
}

/** 冻结工具集合，并在 Agent 启动阶段拒绝空名称和任何重复注册。 */
function freezeUniqueTools<TContext>(
  tools: readonly AgentTool<TContext>[],
): readonly AgentTool<TContext>[] {
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

/** 归一化模型选择；配置与请求使用同一形状。 */
function defineModelSelection(input: ModelSelection, path: string): Readonly<ModelSelection> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError(`${path} 必须是模型选择对象`)
  assertKnownConfigFields(input, ['id', 'reasoningEffort'], path)
  const id = normalizeModelId(input.id, `${path}.id`)
  const reasoningEffort = input.reasoningEffort === undefined
    ? undefined
    : normalizeReasoningEffort(input.reasoningEffort, `${path}.reasoningEffort`)
  return Object.freeze({
    id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

/** 在 AgentLoop 启动前检查 Adapter 的最小稳定身份。 */
function validateModelAdapter(adapter: ModelAdapter): void {
  if (typeof adapter !== 'object' || adapter === null)
    throw new TypeError('Agent config.adapter 必须实现 ModelAdapter')
  if (typeof adapter.provider !== 'string' || !adapter.provider.trim())
    throw new TypeError('ModelAdapter 的 provider 不能为空')
  if (typeof adapter.complete !== 'function' || typeof adapter.stream !== 'function')
    throw new TypeError('ModelAdapter 必须实现 complete() 和 stream()')
}
