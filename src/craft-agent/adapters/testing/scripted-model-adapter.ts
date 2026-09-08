import type {
  ModelAdapter,
  ModelCallOptions,
  ModelCompletion,
  ModelRequest,
  ModelStreamChunk,
} from '../../contracts'
import { ModelError } from '../../contracts'

/** ScriptedModelAdapter 支持的单次调用脚本。 */
export type ScriptedModelStep
  = | {
    readonly method: 'complete'
    readonly result: ModelCompletion
  }
  | {
    readonly method: 'stream'
    readonly chunks: readonly ModelStreamChunk[]
    readonly errorAfterChunks?: unknown
  }
  | {
    readonly method: 'complete' | 'stream'
    readonly error: unknown
  }

/** 创建测试 Adapter 时使用的固定身份和调用脚本。 */
export interface ScriptedModelAdapterConfig {
  readonly provider?: string
  readonly model?: string
  readonly script: readonly ScriptedModelStep[]
}

/** 测试 Adapter 捕获的标准调用，不包含可变的供应商 SDK 对象。 */
export interface ScriptedModelCall {
  readonly method: 'complete' | 'stream'
  readonly request: ModelRequest
  readonly options: ModelCallOptions
}

/**
 * 无网络的确定性 ModelAdapter，用于 Agent、Runtime 和第三方 Adapter 示例测试。
 *
 * 每次调用严格消费一个脚本步骤；方法错位或脚本耗尽会作为协议错误暴露，避免测试静默通过。
 */
export class ScriptedModelAdapter implements ModelAdapter {
  readonly provider: string
  readonly model: string
  readonly calls: ScriptedModelCall[] = []

  private readonly script: readonly ScriptedModelStep[]
  private cursor = 0

  /** 创建固定脚本 Adapter；输入脚本会复制，避免外部随后修改执行顺序。 */
  constructor(config: ScriptedModelAdapterConfig) {
    this.provider = config.provider?.trim() || 'scripted'
    this.model = config.model?.trim() || 'scripted-model'
    this.script = [...config.script]
  }

  /** 消费一个非流式脚本步骤。 */
  async complete(
    request: ModelRequest,
    options: ModelCallOptions = {},
  ): Promise<ModelCompletion> {
    this.captureCall('complete', request, options)
    this.assertNotAborted(options.signal)
    const step = this.takeStep('complete')

    if ('error' in step)
      throw this.toModelError(step.error)
    return step.result
  }

  /** 消费一个流式脚本步骤，并可在最后一个 chunk 后模拟迭代错误。 */
  async stream(
    request: ModelRequest,
    options: ModelCallOptions = {},
  ): Promise<AsyncIterable<ModelStreamChunk>> {
    this.captureCall('stream', request, options)
    this.assertNotAborted(options.signal)
    const step = this.takeStep('stream')

    if ('error' in step)
      throw this.toModelError(step.error)

    return this.playStream(step, options.signal)
  }

  /** 播放 chunk，并在每次产出前响应取消或在末尾抛出脚本错误。 */
  private async* playStream(
    step: Extract<ScriptedModelStep, { readonly method: 'stream' }>,
    signal?: AbortSignal,
  ): AsyncGenerator<ModelStreamChunk> {
    for (const chunk of step.chunks) {
      this.assertNotAborted(signal)
      yield chunk
    }
    if (step.errorAfterChunks !== undefined)
      throw this.toModelError(step.errorAfterChunks)
  }

  /** 捕获调用时的消息和工具数组快照，供测试断言。 */
  private captureCall(
    method: ScriptedModelCall['method'],
    request: ModelRequest,
    options: ModelCallOptions,
  ): void {
    this.calls.push({
      method,
      request: {
        ...request,
        messages: [...request.messages],
        ...(request.tools ? { tools: [...request.tools] } : {}),
      },
      options: { ...options },
    })
  }

  /** 严格取得下一个指定方法的脚本步骤。 */
  private takeStep<TMethod extends ScriptedModelCall['method']>(
    method: TMethod,
  ): Extract<ScriptedModelStep, { readonly method: TMethod }> {
    const step = this.script[this.cursor++]
    if (!step) {
      throw new ModelError({
        code: 'MODEL_PROTOCOL_ERROR',
        message: `ScriptedModelAdapter 脚本已耗尽，无法执行 ${method}`,
        provider: this.provider,
      })
    }
    if (step.method !== method) {
      throw new ModelError({
        code: 'MODEL_PROTOCOL_ERROR',
        message: `ScriptedModelAdapter 预期 ${step.method}，实际收到 ${method}`,
        provider: this.provider,
      })
    }
    return step as Extract<ScriptedModelStep, { readonly method: TMethod }>
  }

  /** 在调用前和流迭代期间遵守标准取消信号。 */
  private assertNotAborted(signal?: AbortSignal): void {
    if (!signal?.aborted)
      return

    throw new ModelError({
      code: 'MODEL_ABORTED',
      message: '模型调用已取消',
      provider: this.provider,
      cause: signal.reason,
    })
  }

  /** 保留规范错误；原始测试异常统一转换为稳定调用失败。 */
  private toModelError(error: unknown): ModelError {
    if (error instanceof ModelError)
      return error

    return new ModelError({
      code: 'MODEL_CALL_FAILED',
      message: error instanceof Error ? error.message : String(error),
      provider: this.provider,
      cause: error,
    })
  }
}
