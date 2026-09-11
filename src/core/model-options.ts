import type {
  AgentLoopModelExecutionOptions,
  DefinedAgentLoopModelExecutionOptions,
} from './types'
import { REASONING_OFF } from '../contracts'

/**
 * 校验并归一化单个推理强度。
 *
 * 这是门面与 AgentLoop 唯一的校验/归一化实现：Core 只保证“提供了一个非空值”，并把
 * 保留值统一成小写 `'off'`，让下游直接按字面量识别而不必各自处理大小写；其他取值是
 * 供应商定义的等级，原样透传、不做大小写转换，也不做等级白名单校验——任何位置维护的
 * 白名单都会在供应商新增等级时把合法请求判为非法。
 *
 * Adapter 不重复这套校验，它们只消费归一化后的结果，并按 REASONING_OFF 把保留值翻译成
 * 自己协议上的关闭语义。`path` 只用于诊断，让错误信息指向调用方实际书写的位置。
 */
export function normalizeReasoningEffort(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${path} 必须是非空字符串`)

  const effort = value.trim()
  return effort.toLowerCase() === REASONING_OFF ? REASONING_OFF : effort
}

/**
 * 校验并合并模型执行设置。
 *
 * 参数顺序遵循“本次输入优先、基础默认值其次”：调用方最常提供的是 input，base 只在
 * Agent 门面把构造配置与单次 Run 配置合并时使用。
 */
export function defineAgentLoopModelExecutionOptions(
  input: AgentLoopModelExecutionOptions | undefined,
  base: DefinedAgentLoopModelExecutionOptions,
): DefinedAgentLoopModelExecutionOptions {
  assertOptionsObject(input, 'Agent model execution options')
  assertKnownFields(
    input,
    ['id', 'reasoningEffort', 'stream'],
    'Agent model execution options',
  )

  if (input?.stream !== undefined && typeof input.stream !== 'boolean')
    throw new TypeError('Agent model execution options.stream 必须是 boolean')

  const stream = input?.stream ?? base.stream
  const id = normalizeModelId(
    input?.id ?? base.id,
    'Agent model execution options.id',
  )
  // 一旦覆盖模型选择，就整体替换默认选择，避免新模型继承旧模型的推理强度。
  const selectedEffort = input === undefined ? base.reasoningEffort : input.reasoningEffort
  const reasoningEffort = selectedEffort === undefined
    ? undefined
    : normalizeReasoningEffort(
        selectedEffort,
        'Agent model execution options.reasoningEffort',
      )

  return Object.freeze({
    stream,
    id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}

/** 模型 ID 是供应商标识，不是展示名称。 */
export function normalizeModelId(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new TypeError(`${path} 必须是非空字符串`)
  return value.trim()
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
