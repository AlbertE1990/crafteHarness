import type { ModelTokenUsage } from '../contracts'
import type { AgentTokenUsage } from './types'

/** 单次 Run 内的可变执行游标；它不会跨 Run 保存，也不是 Session 的第二事实源。 */
export interface MutableRunState {
  readonly runId: string
  readonly turnId: string
  readonly sessionId: string
  sessionVersion: number
  turnStarted: boolean
  steps: number
  toolCalls: number
  content: string
  reasoning: string
  readonly usage: {
    completion_tokens: number
    prompt_tokens: number
    total_tokens: number
  }
}

/** 合并本 Step 最后一次 usage，避免流中重复上报时被多次累计。 */
export function addUsage(state: MutableRunState, usage?: ModelTokenUsage): void {
  if (!usage)
    return
  state.usage.completion_tokens += usage.completion_tokens
  state.usage.prompt_tokens += usage.prompt_tokens
  state.usage.total_tokens += usage.total_tokens
}

/** 多个模型 Step 的 reasoning 用空行分隔，单个 Step 内保持供应商原始顺序。 */
export function appendReasoning(state: MutableRunState, reasoning: string): void {
  if (!reasoning)
    return
  state.reasoning += state.reasoning ? `\n\n${reasoning}` : reasoning
}

/** 将内部可变统计复制成对外只读结果。 */
export function createResultBase(state: MutableRunState) {
  const usage: AgentTokenUsage = { ...state.usage }
  return {
    runId: state.runId,
    turnId: state.turnId,
    sessionId: state.sessionId,
    content: state.content,
    reasoning: state.reasoning,
    steps: state.steps,
    toolCalls: state.toolCalls,
    usage,
    sessionVersion: state.sessionVersion,
  }
}
