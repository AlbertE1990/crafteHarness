import type {
  AgentLoopModelExecutionOptions,
  DefinedAgentLoopModelExecutionOptions,
} from './types'

/**
 * 校验并合并模型执行设置。
 *
 * 参数顺序遵循“本次输入优先、基础默认值其次”：调用方最常提供的是 input，base 只在
 * Agent 门面把构造配置与单次 Run 配置合并时使用。
 */
export function defineAgentLoopModelExecutionOptions(
  input: AgentLoopModelExecutionOptions | undefined,
  base?: DefinedAgentLoopModelExecutionOptions,
): DefinedAgentLoopModelExecutionOptions {
  assertOptionsObject(input, 'Agent model execution options')
  assertKnownFields(input, ['stream', 'reasoning'], 'Agent model execution options')

  if (input?.stream !== undefined && typeof input.stream !== 'boolean')
    throw new TypeError('Agent model execution options.stream 必须是 boolean')

  const reasoningInput = input?.reasoning
  assertOptionsObject(reasoningInput, 'Agent model execution options.reasoning')
  assertKnownFields(
    reasoningInput,
    ['enabled', 'effort'],
    'Agent model execution options.reasoning',
  )
  if (reasoningInput?.enabled !== undefined && typeof reasoningInput.enabled !== 'boolean')
    throw new TypeError('Agent model execution options.reasoning.enabled 必须是 boolean')
  if (reasoningInput?.effort !== undefined
    && (typeof reasoningInput.effort !== 'string' || !reasoningInput.effort.trim())) {
    throw new TypeError('Agent model execution options.reasoning.effort 必须是非空字符串')
  }

  const stream = input?.stream ?? base?.stream ?? true
  const reasoning = mergeReasoning(reasoningInput, base?.reasoning)
  return Object.freeze({
    stream,
    ...(reasoning ? { reasoning } : {}),
  })
}

/** 合并嵌套推理配置；显式关闭时不会继承基础 effort，避免产生自相矛盾的请求。 */
function mergeReasoning(
  input: AgentLoopModelExecutionOptions['reasoning'],
  base: DefinedAgentLoopModelExecutionOptions['reasoning'],
): DefinedAgentLoopModelExecutionOptions['reasoning'] {
  if (input === undefined)
    return base

  const enabled = input.enabled ?? base?.enabled
  const effort = input.effort?.trim()
    ?? (enabled === false ? undefined : base?.effort)
  if (enabled === undefined && effort === undefined)
    return undefined

  return Object.freeze({
    ...(enabled === undefined ? {} : { enabled }),
    ...(effort === undefined ? {} : { effort }),
  })
}

/** 可选配置必须是非数组对象。 */
function assertOptionsObject(value: unknown, path: string): void {
  if (value !== undefined
    && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new TypeError(`${path} 必须是对象`)
  }
}

/** 拒绝拼写错误字段，避免一次 Run 静默退回默认设置。 */
function assertKnownFields(
  value: object | undefined,
  allowedFields: readonly string[],
  path: string,
): void {
  if (value === undefined)
    return
  const allowed = new Set(allowedFields)
  const unknown = Object.keys(value).find(field => !allowed.has(field))
  if (unknown)
    throw new TypeError(`${path} 包含未知字段：${unknown}`)
}
