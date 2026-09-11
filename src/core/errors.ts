import type { HarnessLocale } from '../locale'
import type { ToolErrorInfo, ToolExecutionFailure } from '../tools'
import type { JsonObject } from '../types/json'
import type { AgentRunErrorInfo } from './types'
import { ModelError } from '../contracts'
import { DEFAULT_LOCALE, diagnostic } from '../locale'
import { SessionStoreError } from '../sessions'

/** 解析模型提供的 JSON 参数；空文本按空对象处理。 */
export function parseToolArguments(
  argumentsText: string,
  locale: HarnessLocale = DEFAULT_LOCALE,
):
  | { readonly ok: true, readonly value: unknown }
  | { readonly ok: false, readonly error: ToolErrorInfo } {
  try {
    return { ok: true, value: JSON.parse(argumentsText || '{}') }
  }
  catch (error) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: error instanceof Error
          ? error.message
          : diagnostic(locale, '工具参数不是有效 JSON', 'Tool arguments are not valid JSON'),
        retryable: false,
      },
    }
  }
}

/** 为工具查找、JSON 解析或未执行取消创建标准 Harness 失败外壳。 */
export function createToolFailure(error: ToolErrorInfo): ToolExecutionFailure {
  return {
    ok: false,
    error,
    content: `Error: ${error.message}`,
    attempts: 0,
    durationMs: 0,
  }
}

/** 把 ModelError 或未知 Adapter 异常转换为公开 Agent 错误。 */
export function normalizeModelError(
  error: unknown,
  provider: string,
): { readonly protocol: boolean, readonly error: AgentRunErrorInfo } {
  if (error instanceof ModelError) {
    const details: JsonObject = {
      provider: error.provider,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
    }
    return {
      protocol: error.code === 'MODEL_PROTOCOL_ERROR',
      error: { code: error.code, message: error.message, details },
    }
  }
  return {
    protocol: false,
    error: {
      code: 'MODEL_CALL_FAILED',
      message: error instanceof Error ? error.message : String(error),
      details: { provider },
    },
  }
}

/** 把 Store 异常转换为稳定、可序列化的 Agent 错误。 */
export function normalizeSessionError(error: unknown, sessionId: string): AgentRunErrorInfo {
  if (error instanceof SessionStoreError) {
    return {
      code: error.code,
      message: error.message,
      details: {
        sessionId: error.sessionId ?? sessionId,
        ...(error.expectedVersion === undefined ? {} : { expectedVersion: error.expectedVersion }),
        ...(error.actualVersion === undefined ? {} : { actualVersion: error.actualVersion }),
        ...(error.operation === undefined ? {} : { operation: error.operation }),
      },
    }
  }
  return {
    code: 'SESSION_OPERATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
    details: { sessionId },
  }
}
