import type OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import type {
  ModelCompletion,
  ModelMessage,
  ModelReasoningOptions,
  ModelRequest,
  ModelStreamChunk,
} from '../../contracts'
import type { OpenAICompatibleRequestParams } from '../openai-compatible'
import { ModelError } from '../../contracts'
import {
  normalizeOpenAICompatibleChunk,
  normalizeOpenAICompatibleCompletion,
  normalizeOpenAICompatibleError,
  OpenAICompatibleModelAdapter,
} from '../openai-compatible'

const DEEPSEEK_PROVIDER = 'deepseek'

/** DeepSeek 请求体内部使用的思考开关，不属于构造配置。 */
type DeepSeekThinkingMode = 'enabled' | 'disabled'

/** DeepSeek Chat Completions Adapter 的连接与模型配置。 */
export interface DeepSeekModelAdapterConfig {
  readonly apiKey: string
  readonly baseURL?: string
  readonly model?: string
}

interface DeepSeekRequestExtension {
  readonly thinking?: { readonly type: DeepSeekThinkingMode }
  readonly reasoning_effort?: 'low' | 'high' | 'max'
}

interface DeepSeekReasoningContainer {
  reasoning_content?: unknown
}

/** 从 OpenAI 兼容对象中安全读取 DeepSeek 的思考扩展。 */
export function getDeepSeekReasoningContent(value: unknown): string {
  if (typeof value !== 'object' || value === null)
    return ''

  const reasoning = (value as DeepSeekReasoningContainer).reasoning_content
  return typeof reasoning === 'string' ? reasoning : ''
}

/**
 * DeepSeek 的官方模型 Adapter。
 *
 * 通用请求、响应、流和错误处理由 OpenAICompatibleModelAdapter 提供；本类只描述
 * DeepSeek 的消息降级、token 参数和 reasoning 扩展。
 */
export class DeepSeekModelAdapter extends OpenAICompatibleModelAdapter {
  /** 创建 DeepSeek 差异层；可注入客户端进行无网络契约测试。 */
  constructor(config: DeepSeekModelAdapterConfig, client?: OpenAI) {
    super({
      provider: DEEPSEEK_PROVIDER,
      apiKey: config.apiKey,
      baseURL: config.baseURL?.trim() || 'https://api.deepseek.com',
      model: config.model?.trim() || 'deepseek-v4-flash',
    }, client)
  }

  /** 将 DeepSeek 不支持的 developer 消息降级，并完整回放 reasoning_content。 */
  protected override toMessage(message: ModelMessage): ChatCompletionMessageParam {
    if (message.role === 'developer') {
      return {
        role: 'system',
        content: message.content,
        ...(message.name ? { name: message.name } : {}),
      }
    }

    const compatibleMessage = super.toMessage(message)
    if (message.role !== 'assistant')
      return compatibleMessage

    const assistantMessage = compatibleMessage as ChatCompletionAssistantMessageParam
      & DeepSeekReasoningContainer
    assistantMessage.reasoning_content = message.reasoning_content ?? ''
    return assistantMessage
  }

  /** 将标准 token 参数转换为 DeepSeek 字段，并增加思考配置。 */
  protected override createBaseParams(
    request: ModelRequest,
  ): OpenAICompatibleRequestParams {
    const {
      max_completion_tokens: maxCompletionTokens,
      reasoning_effort: _compatibleReasoningEffort,
      ...compatibleParams
    } = super.createBaseParams(request)
    const extension = this.createDeepSeekReasoningParams(request.reasoning)

    return {
      ...compatibleParams,
      ...(maxCompletionTokens === undefined
        ? {}
        : { max_tokens: maxCompletionTokens }),
      ...extension,
    }
  }

  /** DeepSeek 使用 thinking 开关，并在差异层校验当前支持的 effort。 */
  private createDeepSeekReasoningParams(
    reasoning: ModelReasoningOptions | undefined,
  ): DeepSeekRequestExtension {
    if (!reasoning)
      return {}
    const effort = reasoning.effort
    if (reasoning.enabled === false && effort) {
      throw new ModelError({
        code: 'MODEL_INVALID_REQUEST',
        message: '关闭 DeepSeek thinking 时不能同时指定 reasoning.effort',
        provider: DEEPSEEK_PROVIDER,
      })
    }
    let validatedEffort: DeepSeekRequestExtension['reasoning_effort']
    if (effort) {
      if (!isDeepSeekReasoningEffort(effort)) {
        throw new ModelError({
          code: 'MODEL_INVALID_REQUEST',
          message: `DeepSeek reasoning.effort 不支持：${effort}`,
          provider: DEEPSEEK_PROVIDER,
        })
      }
      validatedEffort = effort
    }

    return {
      ...(reasoning.enabled === undefined && effort === undefined
        ? {}
        : { thinking: { type: reasoning.enabled === false ? 'disabled' : 'enabled' } }),
      ...(validatedEffort ? { reasoning_effort: validatedEffort } : {}),
    }
  }

  /** 在通用 completion 上增加 DeepSeek reasoning_content。 */
  protected override normalizeCompletion(response: ChatCompletion): ModelCompletion {
    return normalizeDeepSeekCompletion(response)
  }

  /** 在通用 chunk 上增加 DeepSeek reasoning_content。 */
  protected override normalizeChunk(chunk: ChatCompletionChunk): ModelStreamChunk {
    return normalizeDeepSeekChunk(chunk)
  }

  /** 使用通用 OpenAI SDK 错误分类，并固定供应商来源。 */
  protected override normalizeError(error: unknown): ModelError {
    return normalizeDeepSeekError(error)
  }
}

/** DeepSeek 当前支持的推理强度只在专属 Adapter 内维护。 */
function isDeepSeekReasoningEffort(
  value: string,
): value is NonNullable<DeepSeekRequestExtension['reasoning_effort']> {
  return value === 'low' || value === 'high' || value === 'max'
}

/** 保留兼容 completion 字段，并标准化 DeepSeek reasoning。 */
export function normalizeDeepSeekCompletion(response: ChatCompletion): ModelCompletion {
  return normalizeOpenAICompatibleCompletion(
    response,
    DEEPSEEK_PROVIDER,
    getDeepSeekReasoningContent,
  )
}

/** 保留兼容 chunk 字段，并标准化 DeepSeek reasoning。 */
export function normalizeDeepSeekChunk(chunk: ChatCompletionChunk): ModelStreamChunk {
  return normalizeOpenAICompatibleChunk(
    chunk,
    DEEPSEEK_PROVIDER,
    getDeepSeekReasoningContent,
  )
}

/** 使用官方兼容层的稳定错误分类，不在 Adapter 内执行重试。 */
export function normalizeDeepSeekError(error: unknown): ModelError {
  return normalizeOpenAICompatibleError(error, DEEPSEEK_PROVIDER)
}
