import type { JsonObject, JsonSchema } from '../types/json'
import type {
  DefinedTool,
  ToolDefinition,
  ToolExecutionConfig,
  ToolRetryPolicy,
} from './types'
import { z } from 'zod'
import { cloneJsonObject, isJsonObject } from '../types/json'

const TOOL_NAME_PATTERN = /^[A-Z][\w-]{0,63}$/i
const MAX_TIMER_DELAY_MS = 2_147_483_647
const TOOL_DEFINITION_FIELDS = new Set([
  'name',
  'description',
  'inputSchema',
  'outputSchema',
  'metadata',
  'guard',
  'execution',
  'renderOutput',
  'execute',
])

/**
 * 校验并冻结工具定义，同时预编译模型输入和成功输出的 JSON Schema。
 *
 * 无法表示为 JSON Schema 的 Zod 类型会在注册阶段直接失败。
 */
export function defineTool<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext = undefined,
  TMetadata extends JsonObject = JsonObject,
>(
  definition: ToolDefinition<TInputSchema, TOutputSchema, TContext, TMetadata>,
): DefinedTool<TInputSchema, TOutputSchema, TContext, TMetadata> {
  validateDefinition(definition)

  const inputJsonSchema = toJsonSchema(definition.inputSchema, 'input')
  if (inputJsonSchema.type !== 'object')
    throw new TypeError(`工具 ${definition.name} 的 inputSchema 根节点必须是 object`)
  const outputJsonSchema = toJsonSchema(definition.outputSchema, 'output')
  assertClosedObjects(inputJsonSchema, 'inputSchema', definition.name)
  assertClosedObjects(outputJsonSchema, 'outputSchema', definition.name)
  const rawMetadata = definition.metadata ?? {} as TMetadata
  if (!isJsonObject(rawMetadata))
    throw new TypeError(`工具 ${definition.name} 的 metadata 必须是可序列化 JSON 对象`)
  // 复制后再冻结，避免 defineTool() 意外冻结调用方仍在其他地方使用的原始 metadata。
  const metadata = cloneJsonObject(rawMetadata) as TMetadata
  const execution = freezeExecutionConfig(definition.execution)

  return Object.freeze({
    ...definition,
    metadata: deepFreeze(metadata),
    ...(execution ? { execution } : {}),
    model: Object.freeze({
      name: definition.name,
      description: definition.description.trim(),
      inputSchema: deepFreeze(inputJsonSchema),
    }),
    outputJsonSchema: deepFreeze(outputJsonSchema),
  })
}

/** 将一个 JSON 可表示的 Zod Schema 转换为 Draft 7 JSON Schema。 */
function toJsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'draft-7',
    io,
    unrepresentable: 'throw',
  }) as JsonSchema
}

/** 注册期检查可以提前暴露配置错误，而不是等模型真正调用工具。 */
function validateDefinition<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext,
  TMetadata extends JsonObject,
>(
  definition: ToolDefinition<TInputSchema, TOutputSchema, TContext, TMetadata>,
): void {
  if (typeof definition !== 'object' || definition === null)
    throw new TypeError('工具定义必须是对象')
  const unknownField = Object.keys(definition)
    .find(field => !TOOL_DEFINITION_FIELDS.has(field))
  if (unknownField)
    throw new TypeError(`工具定义包含未知字段：${unknownField}`)

  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new TypeError(
      '工具名必须以字母开头，只包含字母、数字、下划线或连字符，且不超过 64 个字符',
    )
  }

  if (!definition.description.trim())
    throw new TypeError(`工具 ${definition.name} 缺少有效 description`)

  if (definition.guard !== undefined && typeof definition.guard !== 'function')
    throw new TypeError(`工具 ${definition.name} 的 guard 必须是函数`)

  if (definition.execution !== undefined) {
    if (typeof definition.execution !== 'object'
      || definition.execution === null
      || Array.isArray(definition.execution)) {
      throw new TypeError(`工具 ${definition.name} 的 execution 必须是对象`)
    }
    const unknownField = Object.keys(definition.execution)
      .find(field => field !== 'timeoutMs' && field !== 'retry')
    if (unknownField)
      throw new TypeError(`工具 ${definition.name} 的 execution 包含未知字段：${unknownField}`)

    const timeoutMs = definition.execution.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isInteger(timeoutMs)
        || timeoutMs <= 0
        || timeoutMs > MAX_TIMER_DELAY_MS)) {
      throw new RangeError(`工具 ${definition.name} 的 execution.timeoutMs 必须是有效的正整数`)
    }

    if (definition.execution.retry)
      validateRetryPolicy(definition.execution.retry, definition.name)
  }
}

/** 复制并冻结执行配置，防止注册后改变重试次数或超时。 */
function freezeExecutionConfig(
  execution: ToolExecutionConfig | undefined,
): Readonly<ToolExecutionConfig> | undefined {
  if (!execution)
    return undefined
  const retry = execution.retry
    ? Object.freeze({ ...execution.retry })
    : undefined
  return Object.freeze({
    ...(execution.timeoutMs !== undefined ? { timeoutMs: execution.timeoutMs } : {}),
    ...(retry ? { retry } : {}),
  })
}

/** 检查退避参数，避免无效策略在执行时制造忙循环或超长定时器。 */
function validateRetryPolicy(retry: ToolRetryPolicy, toolName: string): void {
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)
    throw new RangeError(`工具 ${toolName} 的 retry.maxAttempts 必须是正整数`)

  for (const [field, value] of [
    ['baseDelayMs', retry.baseDelayMs],
    ['maxDelayMs', retry.maxDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS)
      throw new RangeError(`工具 ${toolName} 的 retry.${field} 无效`)
  }

  if (retry.maxDelayMs < retry.baseDelayMs)
    throw new RangeError(`工具 ${toolName} 的 retry.maxDelayMs 不能小于 baseDelayMs`)

  const jitterRatio = retry.jitterRatio ?? 0.2
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
    throw new RangeError(`工具 ${toolName} 的 retry.jitterRatio 必须在 0 到 1 之间`)
}

/** 深度冻结模型 Schema，防止 adapter 或调用方修改已注册协议。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value

  for (const child of Object.values(value))
    deepFreeze(child)

  return Object.freeze(value)
}

/**
 * 要求所有嵌套对象都拒绝未知字段，保证 Zod 运行时行为与模型看到的协议一致。
 * 动态键记录暂不属于第一阶段工具 Schema 子集。
 */
function assertClosedObjects(
  value: unknown,
  schemaName: 'inputSchema' | 'outputSchema',
  toolName: string,
  path: string = schemaName,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertClosedObjects(child, schemaName, toolName, `${path}[${index}]`)
    })
    return
  }

  if (typeof value !== 'object' || value === null)
    return

  const node = value as Record<string, unknown>
  if (node.type === 'object' && node.additionalProperties !== false) {
    throw new TypeError(
      `工具 ${toolName} 的 ${path} 必须拒绝未知字段，请使用 z.strictObject()`,
    )
  }

  for (const [key, child] of Object.entries(node))
    assertClosedObjects(child, schemaName, toolName, `${path}.${key}`)
}
