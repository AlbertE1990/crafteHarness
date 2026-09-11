import type {
  ChatCompletion,
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from 'openai/resources/chat/completions'
import type {
  ModelAdapter,
  ModelAssistantMessage,
  ModelCallOptions,
  ModelCompletion,
  ModelCompletionChoice,
  ModelCustomToolCall,
  ModelFunctionToolCall,
  ModelMessage,
  ModelRequest,
  ModelStreamChunk,
  ModelTokenUsage,
  ModelToolCall,
} from '../../contracts'
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from 'openai'
import { ModelError, REASONING_OFF } from '../../contracts'

/** OpenAI Compatible Adapter 的连接、诊断来源和模型配置。 */
export interface OpenAICompatibleModelAdapterConfig {
  readonly apiKey: string
  readonly baseURL?: string
  readonly model: string
  readonly provider?: string
}

/** 供应商可选的 reasoning 字段读取器；未返回值时不向标准对象增加字段。 */
export type ReasoningContentReader = (value: unknown) => string | null | undefined

/** OpenAI 兼容请求的公共主体，允许供应商差异层增加请求字段。 */
export type OpenAICompatibleRequestParams
  = Omit<ChatCompletionCreateParamsNonStreaming, 'stream'>
    & Record<string, unknown>

/**
 * OpenAI Chat Completions 兼容模型的官方基础 Adapter。
 *
 * 子类只覆盖确有差异的消息、请求、响应或错误钩子；Core 不接触 SDK 类型。
 */
export class OpenAICompatibleModelAdapter implements ModelAdapter {
  readonly provider: string
  readonly model: string

  private readonly client: OpenAI

  /** 创建兼容 Adapter；测试可以注入不访问网络的 OpenAI 客户端替身。 */
  constructor(config: OpenAICompatibleModelAdapterConfig, client?: OpenAI) {
    const apiKey = config.apiKey.trim()
    const model = config.model.trim()
    const provider = config.provider?.trim() || 'openai'

    if (!apiKey)
      throw new Error(`${provider} apiKey 不能为空`)
    if (!model)
      throw new Error(`${provider} model 不能为空`)

    this.provider = provider
    this.model = model
    this.client = client ?? new OpenAI({
      apiKey,
      ...(config.baseURL?.trim() ? { baseURL: config.baseURL.trim() } : {}),
    })
  }

  /** 执行非流式调用并输出 CraftAgent 标准 completion。 */
  async complete(
    request: ModelRequest,
    options: ModelCallOptions = {},
  ): Promise<ModelCompletion> {
    try {
      const response = await this.client.chat.completions.create(
        this.createNonStreamingParams(request),
        { signal: options.signal },
      )
      return this.normalizeCompletion(response)
    }
    catch (error) {
      throw this.normalizeError(error)
    }
  }

  /** 执行流式调用，并统一处理创建流和迭代流期间的错误。 */
  async stream(
    request: ModelRequest,
    options: ModelCallOptions = {},
  ): Promise<AsyncIterable<ModelStreamChunk>> {
    try {
      const stream = await this.client.chat.completions.create(
        this.createStreamingParams(request),
        { signal: options.signal },
      )
      return this.normalizeStream(stream)
    }
    catch (error) {
      throw this.normalizeError(error)
    }
  }

  /** 将单条内部消息转换为 SDK 消息；供应商差异层可以覆盖。 */
  protected toMessage(message: ModelMessage): ChatCompletionMessageParam {
    return toOpenAICompatibleMessage(message)
  }

  /** 创建兼容请求主体；供应商差异层可在保留标准语义的前提下扩展。 */
  protected createBaseParams(request: ModelRequest): OpenAICompatibleRequestParams {
    const reasoningParams = this.createReasoningParams(request.reasoningEffort)
    return {
      model: this.model,
      messages: request.messages.map(message => this.toMessage(message)),
      ...(request.tools?.length
        ? { tools: request.tools.map(toOpenAICompatibleTool) }
        : {}),
      ...(request.max_completion_tokens === undefined
        ? {}
        : { max_completion_tokens: request.max_completion_tokens }),
      ...(request.parallel_tool_calls === undefined
        ? {}
        : { parallel_tool_calls: request.parallel_tool_calls }),
      ...(request.tool_choice === undefined
        ? {}
        : { tool_choice: request.tool_choice }),
      ...reasoningParams,
    }
  }

  /**
   * 将 Core 的单轴推理强度转换为 OpenAI Chat Completions 字段。
   *
   * 供应商扩展出的等级保持开放字符串，由目标服务最终校验；Core 保留值 `'off'` 映射为
   * OpenAI 的 `none`。存在不同语义的兼容供应商应在自己的差异层覆盖本方法。
   */
  protected createReasoningParams(
    reasoningEffort: string | undefined,
  ): Record<string, unknown> {
    if (reasoningEffort === undefined)
      return {}
    return {
      reasoning_effort: reasoningEffort === REASONING_OFF ? 'none' : reasoningEffort,
    }
  }

  /** 标准化非流响应；供应商差异层可以增加 reasoning 等字段。 */
  protected normalizeCompletion(response: ChatCompletion): ModelCompletion {
    return normalizeOpenAICompatibleCompletion(response, this.provider)
  }

  /** 标准化单个流块；供应商差异层可以增加 reasoning 等字段。 */
  protected normalizeChunk(chunk: ChatCompletionChunk): ModelStreamChunk {
    return normalizeOpenAICompatibleChunk(chunk, this.provider)
  }

  /** 将 SDK 异常映射为稳定模型错误；Adapter 不在此处重试。 */
  protected normalizeError(error: unknown): ModelError {
    return normalizeOpenAICompatibleError(error, this.provider)
  }

  /** 创建非流式 SDK 参数。 */
  private createNonStreamingParams(
    request: ModelRequest,
  ): ChatCompletionCreateParamsNonStreaming {
    return {
      ...this.createBaseParams(request),
      stream: false,
    } as ChatCompletionCreateParamsNonStreaming
  }

  /** 创建流式 SDK 参数，并要求兼容服务在末块返回 token 用量。 */
  private createStreamingParams(
    request: ModelRequest,
  ): ChatCompletionCreateParamsStreaming {
    return {
      ...this.createBaseParams(request),
      stream: true,
      stream_options: { include_usage: true },
    } as ChatCompletionCreateParamsStreaming
  }

  /** 延迟标准化供应商流，确保迭代期间的错误也经过同一分类钩子。 */
  private async* normalizeStream(
    stream: AsyncIterable<ChatCompletionChunk>,
  ): AsyncGenerator<ModelStreamChunk> {
    try {
      for await (const chunk of stream)
        yield this.normalizeChunk(chunk)
    }
    catch (error) {
      throw this.normalizeError(error)
    }
  }
}

/** 将 CraftAgent 消息投影为标准 OpenAI Chat Completions 消息。 */
export function toOpenAICompatibleMessage(
  message: ModelMessage,
): ChatCompletionMessageParam {
  if (message.role === 'assistant') {
    const assistantMessage: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: message.content ?? '',
      ...(message.name ? { name: message.name } : {}),
      ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
      ...(message.function_call === undefined
        ? {}
        : { function_call: message.function_call }),
      ...(message.tool_calls?.length
        ? { tool_calls: message.tool_calls.map(toOpenAICompatibleToolCall) }
        : {}),
    }
    return assistantMessage
  }

  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      tool_call_id: message.tool_call_id,
    }
  }

  if (message.role === 'function') {
    return {
      role: 'function',
      content: message.content,
      name: message.name,
    }
  }

  return {
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
  }
}

/** 将 CraftAgent 工具描述投影为严格函数工具。 */
export function toOpenAICompatibleTool(
  tool: NonNullable<ModelRequest['tools']>[number],
): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: true,
    },
  }
}

/** 将 CraftAgent 完整工具调用投影为 SDK 工具调用。 */
export function toOpenAICompatibleToolCall(
  toolCall: ModelToolCall,
): ChatCompletionMessageToolCall {
  if (toolCall.type === 'custom') {
    return {
      id: toolCall.id,
      type: 'custom',
      custom: toolCall.custom,
    }
  }

  return {
    id: toolCall.id,
    type: 'function',
    function: toolCall.function,
  }
}

/** 将 SDK token 用量复制到 Core 自有结构，避免 SDK 类型穿过边界。 */
export function normalizeOpenAICompatibleUsage(
  usage: ChatCompletion['usage'],
): ModelTokenUsage | undefined {
  if (!usage)
    return undefined

  const {
    completion_tokens_details: completionDetails,
    prompt_tokens_details: promptDetails,
    ...preservedUsage
  } = usage

  return {
    ...preservedUsage,
    completion_tokens: usage.completion_tokens,
    prompt_tokens: usage.prompt_tokens,
    total_tokens: usage.total_tokens,
    ...(completionDetails
      ? { completion_tokens_details: { ...completionDetails } }
      : {}),
    ...(promptDetails
      ? { prompt_tokens_details: { ...promptDetails } }
      : {}),
  }
}

/** 将 SDK 工具调用转换为 Core 自有结构。 */
export function normalizeOpenAICompatibleToolCall(
  toolCall: ChatCompletionMessageToolCall,
): ModelToolCall {
  if (toolCall.type === 'custom') {
    const normalized: ModelCustomToolCall = {
      ...toolCall,
      id: toolCall.id,
      type: 'custom',
      custom: {
        name: toolCall.custom.name,
        input: toolCall.custom.input,
      },
    }
    return normalized
  }

  const normalized: ModelFunctionToolCall = {
    ...toolCall,
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.function.name,
      arguments: toolCall.function.arguments,
    },
  }
  return normalized
}

/** 将 SDK assistant 消息标准化，并按需读取供应商 reasoning 字段。 */
export function normalizeOpenAICompatibleAssistantMessage(
  message: ChatCompletion.Choice['message'],
  getReasoningContent?: ReasoningContentReader,
): ModelAssistantMessage {
  const reasoningContent = getReasoningContent?.(message)

  return {
    ...message,
    role: 'assistant',
    content: message.content,
    ...(message.refusal === null ? {} : { refusal: message.refusal }),
    ...(reasoningContent === undefined
      ? {}
      : { reasoning_content: reasoningContent }),
    ...(message.tool_calls?.length
      ? { tool_calls: message.tool_calls.map(normalizeOpenAICompatibleToolCall) }
      : {}),
  }
}

/** 保留 OpenAI completion 字段，并增加稳定的 provider 诊断来源。 */
export function normalizeOpenAICompatibleCompletion(
  response: ChatCompletion,
  provider: string,
  getReasoningContent?: ReasoningContentReader,
): ModelCompletion {
  const choices: ModelCompletionChoice[] = response.choices.map(choice => ({
    ...choice,
    finish_reason: choice.finish_reason,
    index: choice.index,
    logprobs: choice.logprobs as unknown as ModelCompletionChoice['logprobs'],
    message: normalizeOpenAICompatibleAssistantMessage(
      choice.message,
      getReasoningContent,
    ),
  }))
  const usage = normalizeOpenAICompatibleUsage(response.usage)
  const preservedResponse = response as unknown as Omit<
    ModelCompletion,
    'choices' | 'metadata' | 'moderation' | 'usage'
  >

  return {
    ...preservedResponse,
    id: response.id,
    choices,
    created: response.created,
    model: response.model,
    object: 'chat.completion',
    metadata: response.metadata as unknown as ModelCompletion['metadata'],
    moderation: response.moderation as unknown as ModelCompletion['moderation'],
    ...(response.service_tier === undefined
      ? {}
      : { service_tier: response.service_tier }),
    ...(response.system_fingerprint
      ? { system_fingerprint: response.system_fingerprint }
      : {}),
    ...(usage ? { usage } : {}),
    provider,
  }
}

/** 保留 OpenAI chunk 的所有字段，并按需增加标准化 reasoning。 */
export function normalizeOpenAICompatibleChunk(
  chunk: ChatCompletionChunk,
  provider: string,
  getReasoningContent?: ReasoningContentReader,
): ModelStreamChunk {
  return {
    ...chunk,
    choices: chunk.choices.map((choice) => {
      const reasoningContent = getReasoningContent?.(choice.delta)
      return {
        ...choice,
        logprobs: choice.logprobs as unknown as ModelStreamChunk['choices'][number]['logprobs'],
        delta: {
          ...choice.delta,
          ...(reasoningContent === undefined
            ? {}
            : { reasoning_content: reasoningContent }),
        },
      }
    }),
    moderation: chunk.moderation as unknown as ModelStreamChunk['moderation'],
    usage: normalizeOpenAICompatibleUsage(chunk.usage ?? undefined) ?? null,
    provider,
  }
}

/** 将 OpenAI SDK 异常映射为供应商无关错误，不执行隐式重试。 */
export function normalizeOpenAICompatibleError(
  error: unknown,
  provider: string,
): ModelError {
  if (error instanceof ModelError)
    return error

  if (error instanceof APIUserAbortError) {
    return new ModelError({
      code: 'MODEL_ABORTED',
      message: '模型调用已取消',
      provider,
      cause: error,
    })
  }

  if (error instanceof APIConnectionTimeoutError) {
    return new ModelError({
      code: 'MODEL_TIMEOUT',
      message: '模型服务连接超时',
      provider,
      retryable: true,
      cause: error,
    })
  }

  if (error instanceof AuthenticationError)
    return createApiModelError(error, provider, 'MODEL_AUTHENTICATION_FAILED', false)
  if (error instanceof PermissionDeniedError)
    return createApiModelError(error, provider, 'MODEL_PERMISSION_DENIED', false)
  if (error instanceof RateLimitError)
    return createApiModelError(error, provider, 'MODEL_RATE_LIMITED', true)
  if (error instanceof BadRequestError) {
    const isContextLengthError = error.code === 'context_length_exceeded'
      || error.message.toLowerCase().includes('context length')
    return createApiModelError(
      error,
      provider,
      isContextLengthError
        ? 'MODEL_CONTEXT_LENGTH_EXCEEDED'
        : 'MODEL_INVALID_REQUEST',
      false,
    )
  }
  if (error instanceof InternalServerError || error instanceof APIConnectionError) {
    return new ModelError({
      code: 'MODEL_UNAVAILABLE',
      message: error.message,
      provider,
      retryable: true,
      ...(error instanceof APIError ? { status: error.status } : {}),
      cause: error,
    })
  }
  if (error instanceof APIError) {
    return createApiModelError(
      error,
      provider,
      error.status >= 500 ? 'MODEL_UNAVAILABLE' : 'MODEL_CALL_FAILED',
      error.status >= 500,
    )
  }

  return new ModelError({
    code: 'MODEL_CALL_FAILED',
    message: error instanceof Error ? error.message : String(error),
    provider,
    cause: error,
  })
}

/** 使用 SDK HTTP 状态创建规范模型错误。 */
function createApiModelError(
  error: APIError,
  provider: string,
  code: ConstructorParameters<typeof ModelError>[0]['code'],
  retryable: boolean,
): ModelError {
  return new ModelError({
    code,
    message: error.message,
    provider,
    retryable,
    status: error.status,
    cause: error,
  })
}
