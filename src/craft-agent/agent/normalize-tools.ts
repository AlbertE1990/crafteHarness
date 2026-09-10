import type { z } from 'zod'
import type { AgentTool } from '../core'
import type {
  DefinedTool,
  ToolExecutionConfig,
  ToolModelDefinition,
  ToolRunContext,
} from '../tools'
import type { JsonObject, JsonSchema } from '../types/json'
import { createAgentTool } from '../core'

/**
 * Agent 配置可接受的 `defineTool()` 结果结构。
 *
 * 此结构用于容纳输入、输出 Schema 不同的工具数组；`never[]` 仅存在于配置边界，
 * 不会改变工具作者在 `defineTool()` 中获得的精确参数类型。
 *
 * 调用方通常不需要显式标注此类型；它只用于封装可接收任意 `defineTool()` 结果的配置。
 */
export interface AgentToolInput<TContext = undefined> {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType
  readonly outputSchema: z.ZodType
  readonly metadata: JsonObject
  readonly guard?: (...values: never[]) => unknown
  readonly execution?: ToolExecutionConfig
  readonly renderOutput?: (...values: never[]) => string
  readonly execute: (
    input: never,
    context: ToolRunContext<TContext>,
  ) => unknown
  readonly model: ToolModelDefinition
  readonly outputJsonSchema: JsonSchema
}

/**
 * 将 `defineTool()` 结果转换为 AgentLoop 可执行的工具注册项。
 *
 * 本函数是 Agent 配置的唯一工具归一化边界，不接受已经转换的 `AgentTool`。
 *
 * @internal
 */
export function normalizeAgentToolDefinitions<TContext = undefined>(
  tools: readonly AgentToolInput<TContext>[],
): AgentTool<TContext>[] {
  return tools.map(tool => normalizeToolDefinition(tool))
}

/** 在唯一的类型擦除边界把任意具体 Zod Schema 工具交给 Tool Harness。 */
function normalizeToolDefinition<TContext>(value: AgentToolInput<TContext>): AgentTool<TContext> {
  if (!isAgentToolDefinition(value))
    throw new TypeError('Agent 工具必须由 defineTool() 创建')

  return createAgentTool(value as DefinedTool<z.ZodType, z.ZodType, TContext>)
}

/** 识别已经完成 Schema 编译和注册期检查的 `defineTool()` 结果。 */
function isAgentToolDefinition<TContext>(value: unknown): value is AgentToolInput<TContext> {
  if (typeof value !== 'object' || value === null)
    return false
  const tool = value as Partial<AgentToolInput<TContext>>
  return typeof tool.name === 'string'
    && typeof tool.description === 'string'
    && typeof tool.execute === 'function'
    && typeof tool.inputSchema === 'object'
    && tool.inputSchema !== null
    && typeof tool.outputSchema === 'object'
    && tool.outputSchema !== null
    && typeof tool.model === 'object'
    && tool.model !== null
    && typeof tool.outputJsonSchema === 'object'
    && tool.outputJsonSchema !== null
    && typeof tool.metadata === 'object'
    && tool.metadata !== null
}
