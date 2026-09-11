import type {
  ModelAdapter,
  ModelCallOptions,
  ModelCompletion,
  ModelRequest,
  ModelStreamChunk,
} from '../../src/contracts'

/** 契约探针成功后返回的标准结果，便于调用方继续做供应商专属断言。 */
export interface ModelAdapterContractResult {
  readonly completion: ModelCompletion
  readonly chunks: readonly ModelStreamChunk[]
}

/** 执行 ModelAdapter 契约探针时使用的请求与取消上下文。 */
export interface ModelAdapterContractOptions {
  readonly request?: ModelRequest
  readonly callOptions?: ModelCallOptions
}

/** 最小契约请求；真实 Adapter 测试应注入客户端替身，不能因此访问生产模型。 */
export const modelAdapterContractRequest: ModelRequest = Object.freeze({
  model: 'contract-model',
  messages: Object.freeze([
    Object.freeze({ role: 'user' as const, content: 'contract probe' }),
  ]),
})

/**
 * 同时探测 complete 与 stream 的最小运行时契约。
 *
 * 本函数不依赖具体测试框架；推荐在注入 SDK 客户端替身后由 Vitest、Jest 或 Node Test 调用。
 */
export async function assertModelAdapterContract(
  adapter: ModelAdapter,
  options: ModelAdapterContractOptions = {},
): Promise<ModelAdapterContractResult> {
  assertNonEmptyString(adapter.provider, 'adapter.provider')

  const request = options.request ?? modelAdapterContractRequest
  const completion = await adapter.complete(request, options.callOptions)
  assertCompletion(completion, adapter.provider)

  const source = await adapter.stream(request, options.callOptions)
  if (!source || typeof source[Symbol.asyncIterator] !== 'function')
    throw new Error('adapter.stream 必须返回 AsyncIterable<ModelStreamChunk>')

  const chunks: ModelStreamChunk[] = []
  for await (const chunk of source) {
    assertChunk(chunk, adapter.provider)
    chunks.push(chunk)
  }
  if (chunks.length === 0)
    throw new Error('adapter.stream 契约探针至少需要返回一个 chunk')

  return { completion, chunks }
}

/** 验证非流式结果的稳定骨架和诊断来源。 */
function assertCompletion(completion: ModelCompletion, provider: string): void {
  if (completion.object !== 'chat.completion')
    throw new Error('adapter.complete 返回了错误的 object')
  assertNonEmptyString(completion.id, 'completion.id')
  assertNonEmptyString(completion.model, 'completion.model')
  if (!Array.isArray(completion.choices))
    throw new Error('completion.choices 必须是数组')
  for (const choice of completion.choices) {
    if (!Number.isInteger(choice.index))
      throw new Error('completion choice.index 必须是整数')
    if (choice.message.role !== 'assistant')
      throw new Error('completion choice.message.role 必须是 assistant')
  }
  assertProvider(completion.provider, provider, 'completion.provider')
}

/** 验证流块的稳定骨架和诊断来源。 */
function assertChunk(chunk: ModelStreamChunk, provider: string): void {
  if (chunk.object !== 'chat.completion.chunk')
    throw new Error('adapter.stream 返回了错误的 chunk object')
  assertNonEmptyString(chunk.id, 'chunk.id')
  assertNonEmptyString(chunk.model, 'chunk.model')
  if (!Array.isArray(chunk.choices))
    throw new Error('chunk.choices 必须是数组')
  for (const choice of chunk.choices) {
    if (!Number.isInteger(choice.index))
      throw new Error('chunk choice.index 必须是整数')
    if (typeof choice.delta !== 'object' || choice.delta === null)
      throw new Error('chunk choice.delta 必须是对象')
  }
  assertProvider(chunk.provider, provider, 'chunk.provider')
}

/** provider 若由结果显式携带，必须与 Adapter 身份一致。 */
function assertProvider(
  actual: string | undefined,
  expected: string,
  path: string,
): void {
  if (actual !== undefined && actual !== expected)
    throw new Error(`${path} 必须与 adapter.provider 一致`)
}

/** 验证 Adapter 稳定身份和响应标识。 */
function assertNonEmptyString(value: string, path: string): void {
  if (!value.trim())
    throw new Error(`${path} 必须是非空字符串`)
}
