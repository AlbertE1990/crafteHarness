import type { HarnessLocale } from '../locale'
import type { JsonObject, JsonSchema } from '../types/json'
import type {
  DefinedTool,
  ToolDefinition,
  ToolExecutionConfig,
  ToolRetryPolicy,
} from './types'
import { z } from 'zod'
import { diagnostic, resolveLocale } from '../locale'
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

/** defineTool() 注册期诊断选项。 */
export interface DefineToolOptions {
  readonly locale?: HarnessLocale
}

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
  options: DefineToolOptions = {},
): DefinedTool<TInputSchema, TOutputSchema, TContext, TMetadata> {
  const locale = resolveLocale(options.locale)
  validateDefinition(definition, locale)

  const inputJsonSchema = toJsonSchema(definition.inputSchema, 'input')
  if (inputJsonSchema.type !== 'object')
    throw new TypeError(diagnostic(locale, `工具 ${definition.name} 的 inputSchema 根节点必须是 object`, `Tool ${definition.name} inputSchema root must be an object`))
  const outputJsonSchema = toJsonSchema(definition.outputSchema, 'output')
  assertClosedObjects(inputJsonSchema, 'inputSchema', definition.name, locale)
  assertClosedObjects(outputJsonSchema, 'outputSchema', definition.name, locale)
  const rawMetadata = definition.metadata ?? {} as TMetadata
  if (!isJsonObject(rawMetadata))
    throw new TypeError(diagnostic(locale, `工具 ${definition.name} 的 metadata 必须是可序列化 JSON 对象`, `Tool ${definition.name} metadata must be a serializable JSON object`))
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
  locale: HarnessLocale,
): void {
  if (typeof definition !== 'object' || definition === null)
    throw new TypeError(diagnostic(locale, '工具定义必须是对象', 'Tool definition must be an object'))
  const unknownField = Object.keys(definition)
    .find(field => !TOOL_DEFINITION_FIELDS.has(field))
  if (unknownField)
    throw new TypeError(diagnostic(locale, `工具定义包含未知字段：${unknownField}`, `Tool definition contains unknown field: ${unknownField}`))

  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new TypeError(
      diagnostic(
        locale,
        '工具名必须以字母开头，只包含字母、数字、下划线或连字符，且不超过 64 个字符',
        'Tool name must start with a letter, contain only letters, numbers, underscores, or hyphens, and be at most 64 characters',
      ),
    )
  }

  if (!definition.description.trim())
    throw new TypeError(diagnostic(locale, `工具 ${definition.name} 缺少有效 description`, `Tool ${definition.name} requires a valid description`))

  if (definition.guard !== undefined && typeof definition.guard !== 'function')
    throw new TypeError(diagnostic(locale, `工具 ${definition.name} 的 guard 必须是函数`, `Tool ${definition.name} guard must be a function`))

  if (definition.execution !== undefined) {
    if (typeof definition.execution !== 'object'
      || definition.execution === null
      || Array.isArray(definition.execution)) {
      throw new TypeError(diagnostic(locale, `工具 ${definition.name} 的 execution 必须是对象`, `Tool ${definition.name} execution must be an object`))
    }
    const unknownField = Object.keys(definition.execution)
      .find(field => field !== 'timeoutMs' && field !== 'retry')
    if (unknownField)
      throw new TypeError(diagnostic(locale, `工具 ${definition.name} 的 execution 包含未知字段：${unknownField}`, `Tool ${definition.name} execution contains unknown field: ${unknownField}`))

    const timeoutMs = definition.execution.timeoutMs
    if (timeoutMs !== undefined
      && (!Number.isInteger(timeoutMs)
        || timeoutMs <= 0
        || timeoutMs > MAX_TIMER_DELAY_MS)) {
      throw new RangeError(diagnostic(locale, `工具 ${definition.name} 的 execution.timeoutMs 必须是有效的正整数`, `Tool ${definition.name} execution.timeoutMs must be a valid positive integer`))
    }

    if (definition.execution.retry)
      validateRetryPolicy(definition.execution.retry, definition.name, locale)
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
function validateRetryPolicy(retry: ToolRetryPolicy, toolName: string, locale: HarnessLocale): void {
  if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1)
    throw new RangeError(diagnostic(locale, `工具 ${toolName} 的 retry.maxAttempts 必须是正整数`, `Tool ${toolName} retry.maxAttempts must be a positive integer`))

  for (const [field, value] of [
    ['baseDelayMs', retry.baseDelayMs],
    ['maxDelayMs', retry.maxDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_TIMER_DELAY_MS)
      throw new RangeError(diagnostic(locale, `工具 ${toolName} 的 retry.${field} 无效`, `Tool ${toolName} retry.${field} is invalid`))
  }

  if (retry.maxDelayMs < retry.baseDelayMs)
    throw new RangeError(diagnostic(locale, `工具 ${toolName} 的 retry.maxDelayMs 不能小于 baseDelayMs`, `Tool ${toolName} retry.maxDelayMs cannot be less than baseDelayMs`))

  const jitterRatio = retry.jitterRatio ?? 0.2
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1)
    throw new RangeError(diagnostic(locale, `工具 ${toolName} 的 retry.jitterRatio 必须在 0 到 1 之间`, `Tool ${toolName} retry.jitterRatio must be between 0 and 1`))
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
  locale: HarnessLocale,
  path: string = schemaName,
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => {
      assertClosedObjects(child, schemaName, toolName, locale, `${path}[${index}]`)
    })
    return
  }

  if (typeof value !== 'object' || value === null)
    return

  const node = value as Record<string, unknown>
  if (node.type === 'object' && node.additionalProperties !== false) {
    throw new TypeError(
      diagnostic(
        locale,
        `工具 ${toolName} 的 ${path} 必须拒绝未知字段，请使用 z.strictObject()`,
        `Tool ${toolName} ${path} must reject unknown fields; use z.strictObject()`,
      ),
    )
  }

  for (const [key, child] of Object.entries(node))
    assertClosedObjects(child, schemaName, toolName, locale, `${path}.${key}`)
}
