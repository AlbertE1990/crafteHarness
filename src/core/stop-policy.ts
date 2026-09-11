import type { HarnessLocale } from '../locale'
import type {
  AgentLoopLimits,
  AgentRunErrorInfo,
} from './types'
import { DEFAULT_LOCALE, diagnostic } from '../locale'

const DEFAULT_LIMITS: AgentLoopLimits = Object.freeze({
  maxModelSteps: 8,
  maxToolCalls: 32,
})

/** 一次 Run 的调用方取消、时限取消和组合信号。 */
export interface RunSignals {
  readonly signal: AbortSignal
  readonly callerSignal?: AbortSignal
  readonly durationSignal: AbortSignal
  readonly clear: () => void
}

/** 创建并验证不可变预算快照。 */
export function createLimits(
  input: Partial<AgentLoopLimits> = {},
  locale: HarnessLocale = DEFAULT_LOCALE,
): AgentLoopLimits {
  const limits: AgentLoopLimits = {
    maxModelSteps: input.maxModelSteps ?? DEFAULT_LIMITS.maxModelSteps,
    maxToolCalls: input.maxToolCalls ?? DEFAULT_LIMITS.maxToolCalls,
    ...(input.maxCompletionTokensPerStep === undefined
      ? {}
      : { maxCompletionTokensPerStep: input.maxCompletionTokensPerStep }),
    ...(input.maxTotalTokens === undefined ? {} : { maxTotalTokens: input.maxTotalTokens }),
    ...(input.maxDurationMs === undefined ? {} : { maxDurationMs: input.maxDurationMs }),
  }

  validatePositiveInteger(limits.maxModelSteps, 'limits.maxModelSteps', locale)
  validatePositiveInteger(limits.maxToolCalls, 'limits.maxToolCalls', locale)
  if (limits.maxCompletionTokensPerStep !== undefined)
    validatePositiveInteger(limits.maxCompletionTokensPerStep, 'limits.maxCompletionTokensPerStep', locale)
  if (limits.maxTotalTokens !== undefined)
    validatePositiveInteger(limits.maxTotalTokens, 'limits.maxTotalTokens', locale)
  if (limits.maxDurationMs !== undefined)
    validatePositiveInteger(limits.maxDurationMs, 'limits.maxDurationMs', locale)
  return Object.freeze(limits)
}

/** 为 Run 创建调用方取消和时限取消的组合信号。 */
export function createRunSignals(
  maxDurationMs?: number,
  callerSignal?: AbortSignal,
  locale: HarnessLocale = DEFAULT_LOCALE,
): RunSignals {
  const durationController = new AbortController()
  const timer = maxDurationMs === undefined
    ? undefined
    : setTimeout(() => durationController.abort(diagnostic(locale, 'Agent Run 超时', 'Agent Run timed out')), maxDurationMs)
  const signals = callerSignal
    ? [callerSignal, durationController.signal]
    : [durationController.signal]

  return {
    signal: signals.length === 1 ? signals[0]! : AbortSignal.any(signals),
    ...(callerSignal ? { callerSignal } : {}),
    durationSignal: durationController.signal,
    clear: () => {
      if (timer !== undefined)
        clearTimeout(timer)
    },
  }
}

/** 区分用户取消和 Agent 自己的时间预算，二者使用不同停止原因。 */
export function getInterruption(signals: RunSignals, locale: HarnessLocale = DEFAULT_LOCALE):
  | {
    readonly reason: 'cancelled' | 'max_duration'
    readonly error: AgentRunErrorInfo
  }
  | undefined {
  if (signals.callerSignal?.aborted) {
    return {
      reason: 'cancelled',
      error: createStopError('AGENT_CANCELLED', diagnostic(locale, 'Run 已被调用方取消', 'Run was cancelled by the caller')),
    }
  }
  if (signals.durationSignal.aborted) {
    return {
      reason: 'max_duration',
      error: createStopError('AGENT_MAX_DURATION', diagnostic(locale, 'Run 已达到时间预算', 'Run reached its time budget')),
    }
  }
  return undefined
}

/** 把模型 finish_reason 转为 Agent 受控停止；正常 stop 和工具调用不在这里停止。 */
export function getModelFinishStop(
  finishReason?: string,
  locale: HarnessLocale = DEFAULT_LOCALE,
):
  | {
    readonly reason: 'model_length' | 'model_content_filter' | 'model_finish_reason'
    readonly error: AgentRunErrorInfo
  }
  | undefined {
  if (!finishReason || finishReason === 'stop')
    return undefined
  if (finishReason === 'length') {
    return {
      reason: 'model_length',
      error: createStopError('AGENT_MODEL_LENGTH', diagnostic(locale, '模型因长度限制停止，回答可能不完整', 'The model stopped due to its length limit; the response may be incomplete')),
    }
  }
  if (finishReason === 'content_filter') {
    return {
      reason: 'model_content_filter',
      error: createStopError('AGENT_MODEL_CONTENT_FILTER', diagnostic(locale, '模型因内容过滤停止', 'The model stopped due to content filtering')),
    }
  }
  return {
    reason: 'model_finish_reason',
    error: {
      code: 'AGENT_MODEL_FINISH_REASON',
      message: diagnostic(locale, `模型以未识别原因停止：${finishReason}`, `The model stopped for an unrecognized reason: ${finishReason}`),
      details: { finishReason },
    },
  }
}

/** 创建不包含原始敏感输入的预算或取消错误。 */
export function createStopError(code: string, message: string): AgentRunErrorInfo {
  return { code, message }
}

/** 合并两个可选正整数限制。 */
export function minimumDefined(left?: number, right?: number): number | undefined {
  if (left === undefined)
    return right
  if (right === undefined)
    return left
  return Math.min(left, right)
}

/** 验证预算使用正安全整数。 */
function validatePositiveInteger(value: number, field: string, locale: HarnessLocale): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(diagnostic(locale, `${field} 必须是正安全整数`, `${field} must be a positive safe integer`))
}
