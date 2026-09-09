import type { z } from 'zod'
import type { AgentTool } from '../core'
import type {
  DefinedTool,
  ToolModelDefinition,
  ToolRetryPolicy,
  ToolSecurityMetadata,
} from '../tools'
import type { JsonSchema } from '../types/json'
import { createAgentTool } from '../core'

/**
 * Agent 配置可接受的 `defineTool()` 结果结构。
 *
 * 此结构用于容纳输入、输出 Schema 不同的工具数组；`never[]` 仅存在于配置边界，
 * 不会改变工具作者在 `defineTool()` 中获得的精确参数类型。
 *
 * @internal
 */
export interface AgentToolDefinitionInput {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType
  readonly outputSchema: z.ZodType
  readonly timeoutMs?: number
  readonly retry?: ToolRetryPolicy
  readonly security: ToolSecurityMetadata
  readonly renderOutput?: (...values: never[]) => string
  readonly execute: (...values: never[]) => unknown
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
export function normalizeAgentToolDefinitions(
  tools: readonly AgentToolDefinitionInput[],
): AgentTool[] {
  return tools.map(tool => normalizeToolDefinition(tool))
}

/** 在唯一的类型擦除边界把任意具体 Zod Schema 工具交给 Tool Harness。 */
function normalizeToolDefinition(value: AgentToolDefinitionInput): AgentTool {
  if (!isAgentToolDefinition(value))
    throw new TypeError('Agent 工具必须由 defineTool() 创建')

  return createAgentTool(value as DefinedTool<z.ZodType, z.ZodType>)
}

/** 识别已经完成 Schema 编译和注册期检查的 `defineTool()` 结果。 */
function isAgentToolDefinition(value: unknown): value is AgentToolDefinitionInput {
  if (typeof value !== 'object' || value === null)
    return false
  const tool = value as Partial<AgentToolDefinitionInput>
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
    && typeof tool.security === 'object'
    && tool.security !== null
}
