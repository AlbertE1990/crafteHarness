import type { z } from 'zod'
import type { AgentTool } from '../core'
import type { DefinedTool } from '../tools'
import { createAgentTool } from '../core'

/** 保留每个 DefinedTool 泛型的编译期约束，同时允许一个数组包含不同 Schema。 */
type ValidateToolTuple<TTools extends readonly unknown[]> = {
  readonly [TIndex in keyof TTools]: TTools[TIndex] extends AgentTool
    ? TTools[TIndex]
    : TTools[TIndex] extends DefinedTool<infer _TInput, infer _TOutput>
      ? TTools[TIndex]
      : never
}

/**
 * 将多个 defineTool() 结果一次性转换为 Agent 注册项。
 *
 * 已经由 createAgentTool() 转换的注册项也可以混用；返回数组会被冻结，避免启动后被修改。
 */
export function defineTools<const TTools extends readonly unknown[]>(
  ...tools: TTools & ValidateToolTuple<TTools>
): readonly AgentTool[] {
  return Object.freeze(tools.map(tool => normalizeTool(tool)))
}

/** 判断调用方是否已经提供了 AgentLoop 可直接消费的工具注册项。 */
function isAgentTool(value: unknown): value is AgentTool {
  if (typeof value !== 'object' || value === null)
    return false
  const tool = value as Partial<AgentTool>
  return typeof tool.name === 'string'
    && typeof tool.execute === 'function'
    && typeof tool.model === 'object'
    && tool.model !== null
    && !('outputJsonSchema' in value)
}

/** 在唯一的类型擦除边界把任意具体 Zod Schema 工具交给 Tool Harness。 */
function normalizeTool(value: unknown): AgentTool {
  if (isAgentTool(value))
    return value
  if (typeof value !== 'object' || value === null || !('outputJsonSchema' in value))
    throw new TypeError('defineTools() 只接受 defineTool() 或 createAgentTool() 的结果')

  return createAgentTool(value as DefinedTool<z.ZodType, z.ZodType>)
}
