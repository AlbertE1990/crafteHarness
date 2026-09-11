import type { ModelSelection } from '../contracts'
import type { AgentLoopModelExecutionOptions } from '../core'
import { normalizeModelId, normalizeReasoningEffort } from '../core'

/**
 * 解析单次 Run 的模型选择。请求一旦提供 model 就整体替换默认选择，避免跨模型继承推理强度。
 */
export function resolveAgentModelSelection(
  input: ModelSelection | undefined,
  base: Readonly<ModelSelection>,
): Readonly<ModelSelection> {
  if (input === undefined)
    return base
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('Agent request.model 必须是模型选择对象')
  const unknown = Object.keys(input).find(field => field !== 'id' && field !== 'reasoningEffort')
  if (unknown)
    throw new TypeError(`Agent request.model 包含未知字段：${unknown}`)
  const id = normalizeModelId(input.id, 'Agent request.model.id')
  const reasoningEffort = input.reasoningEffort === undefined
    ? undefined
    : normalizeReasoningEffort(input.reasoningEffort, 'Agent request.model.reasoningEffort')
  return Object.freeze({ id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) })
}

/**
 * 把公开的单轴推理强度转换为 AgentLoop 的执行设置。
 *
 * 门面与 AgentLoop 现在使用同一种形态，因此这里不再做维度分解，只负责构造进入循环前
 * 冻结的最终设置；`'off'` 到供应商具体字段的翻译由各 ModelAdapter 完成。
 */
export function createAgentLoopModelExecution(
  model: Readonly<ModelSelection>,
  stream: boolean,
): AgentLoopModelExecutionOptions {
  return Object.freeze({
    stream,
    id: model.id,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
  })
}
