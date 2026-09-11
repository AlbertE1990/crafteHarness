import type OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions'
import type {
  ModelCompletion,
  ModelError,
  ModelMessage,
  ModelRequest,
  ModelStreamChunk,
} from '../../contracts'
import type { OpenAICompatibleRequestParams } from '../openai-compatible'
import { REASONING_OFF } from '../../contracts'
import {
  normalizeOpenAICompatibleChunk,
  normalizeOpenAICompatibleCompletion,
  normalizeOpenAICompatibleError,
  OpenAICompatibleAdapter,
} from '../openai-compatible'

const DEEPSEEK_PROVIDER = 'deepseek'
const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** DeepSeek 请求体内部使用的思考开关，不属于构造配置。 */
type DeepSeekThinkingMode = 'enabled' | 'disabled'

/** DeepSeek Chat Completions Adapter 的连接配置。 */
export interface DeepSeekAdapterConfig {
  readonly apiKey: string
  readonly baseURL?: string
}

/**
 * DeepSeek 请求体的扩展字段。
 *
 * 这里刻意使用开放索引签名，而不是 SDK 自带的 `ReasoningEffort` 联合类型或库内固定枚举：
 * 推理等级集合由 DeepSeek 按模型维护并会独立变化，固定枚举会在供应商新增等级时把合法
 * 请求判为非法。取值最终由部署配置或供应商自身校验。
 */
interface DeepSeekRequestExtension extends Record<string, unknown> {
  readonly thinking?: { readonly type: DeepSeekThinkingMode }
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
 * 通用请求、响应、流和错误处理由 OpenAICompatibleAdapter 提供；本类只描述
 * DeepSeek 的消息降级、token 参数和 reasoning 扩展。
 */
export class DeepSeekAdapter extends OpenAICompatibleAdapter {
  /** 创建 DeepSeek 差异层；可注入客户端进行无网络契约测试。 */
  constructor(config: DeepSeekAdapterConfig, client?: OpenAI) {
    super({
      provider: DEEPSEEK_PROVIDER,
      apiKey: config.apiKey,
      baseURL: config.baseURL?.trim() || DEEPSEEK_DEFAULT_BASE_URL,
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
    const extension = this.createDeepSeekReasoningParams(request.reasoningEffort)

    return {
      ...compatibleParams,
      ...(maxCompletionTokens === undefined
        ? {}
        : { max_tokens: maxCompletionTokens }),
      ...extension,
    }
  }

  /**
   * 把 Core 的单轴推理强度翻译成 DeepSeek 的思考开关与等级。
   *
   * DeepSeek 的线协议把这两件事分成两个字段：开关是对象 `thinking.type`，等级是标量
   * `reasoning_effort`。翻译只发生在这里——开关完全由等级派生（关闭就是关闭，其余一律
   * 开启），因此不存在“关闭却指定等级”这种自相矛盾的请求。
   *
   * 这里刻意不校验等级取值：DeepSeek 的等级集合会变化，库内固定枚举会在供应商新增等级时
   * 把合法请求判为非法。真实非法值由 DeepSeek 拒绝，并已被 normalizeDeepSeekError()
   * 归类为 MODEL_INVALID_REQUEST。
   */
  private createDeepSeekReasoningParams(
    reasoningEffort: string | undefined,
  ): DeepSeekRequestExtension {
    if (reasoningEffort === undefined)
      return {}
    if (reasoningEffort === REASONING_OFF)
      return { thinking: { type: 'disabled' } }

    return {
      thinking: { type: 'enabled' },
      reasoning_effort: reasoningEffort,
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
