import type { DefinedAgentLoopModelExecutionOptions } from '../core'
import type {
  AgentModelExecutionOptions,
  DefinedAgentModelExecutionOptions,
} from './types'

/** 校验并合并 Agent 门面的扁平模型选项。 */
export function defineAgentModelExecutionOptions(
  input: AgentModelExecutionOptions | undefined,
  base?: DefinedAgentModelExecutionOptions,
): DefinedAgentModelExecutionOptions {
  assertOptionsObject(input)
  assertKnownFields(input)

  if (input?.reasoningEnabled !== undefined
    && typeof input.reasoningEnabled !== 'boolean') {
    throw new TypeError('Agent model options.reasoningEnabled 必须是 boolean')
  }
  if (input?.reasoningEffort !== undefined
    && (typeof input.reasoningEffort !== 'string' || !input.reasoningEffort.trim())) {
    throw new TypeError('Agent model options.reasoningEffort 必须是非空字符串')
  }
  if (input?.reasoningEnabled === false && input.reasoningEffort !== undefined) {
    throw new TypeError(
      'Agent model options.reasoningEnabled=false 时不能同时提供 reasoningEffort',
    )
  }

  const explicitlyEnablesReasoning = input?.reasoningEffort !== undefined
  const reasoningEnabled = input?.reasoningEnabled
    ?? (explicitlyEnablesReasoning ? true : base?.reasoningEnabled)
  const reasoningEffort = input?.reasoningEffort?.trim()
    ?? (reasoningEnabled === false ? undefined : base?.reasoningEffort)

  return Object.freeze({
    ...(reasoningEnabled === undefined ? {} : { reasoningEnabled }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

/** 把易用的公开选项转换为 AgentLoop/ModelAdapter 使用的稳定内部结构。 */
export function createAgentLoopModelExecution(
  options: DefinedAgentModelExecutionOptions,
  stream: boolean,
): DefinedAgentLoopModelExecutionOptions {
  const hasReasoning = options.reasoningEnabled !== undefined
    || options.reasoningEffort !== undefined
  return Object.freeze({
    stream,
    ...(hasReasoning
      ? {
          reasoning: Object.freeze({
            ...(options.reasoningEnabled === undefined
              ? {}
              : { enabled: options.reasoningEnabled }),
            ...(options.reasoningEffort === undefined
              ? {}
              : { effort: options.reasoningEffort }),
          }),
        }
      : {}),
  })
}

function assertOptionsObject(value: unknown): void {
  if (value !== undefined
    && (typeof value !== 'object' || value === null || Array.isArray(value))) {
    throw new TypeError('Agent model options 必须是对象')
  }
}

function assertKnownFields(value: object | undefined): void {
  if (value === undefined)
    return
  const allowed = new Set(['reasoningEnabled', 'reasoningEffort'])
  const unknown = Object.keys(value).find(field => !allowed.has(field))
  if (unknown)
    throw new TypeError(`Agent model options 包含未知字段：${unknown}`)
}
