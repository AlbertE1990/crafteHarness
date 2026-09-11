import type { DefinedAgentLoopModelExecutionOptions } from '../core'
import { normalizeReasoningEffort } from '../core'

/**
 * 解析单次 Run 的推理强度：本次请求优先，其次部署默认值。
 *
 * 两者都未提供时返回 undefined，表示不下发任何推理参数，由供应商或模型自身默认值决定。
 * 校验与保留值归一化由 Core 的 normalizeReasoningEffort() 统一负责，门面只决定优先级。
 */
export function resolveAgentReasoningEffort(
  input: string | undefined,
  base?: string,
): string | undefined {
  return input === undefined
    ? base
    : normalizeReasoningEffort(input, 'Agent request.reasoningEffort')
}

/**
 * 把公开的单轴推理强度转换为 AgentLoop 的执行设置。
 *
 * 门面与 AgentLoop 现在使用同一种形态，因此这里不再做维度分解，只负责构造进入循环前
 * 冻结的最终设置；`'off'` 到供应商具体字段的翻译由各 ModelAdapter 完成。
 */
export function createAgentLoopModelExecution(
  reasoningEffort: string | undefined,
  stream: boolean,
): DefinedAgentLoopModelExecutionOptions {
  return Object.freeze({
    stream,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  })
}
