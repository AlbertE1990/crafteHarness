import type { z } from 'zod'
import type { DefinedTool } from '../tools'
import type { JsonObject } from '../types/json'
import type { AgentTool } from './types'
import { executeTool } from '../tools'

/**
 * 将带具体 Zod 输入输出类型的 DefinedTool 转为 Agent Loop 的统一注册项。
 *
 * 泛型只在这个闭包边界被擦除；实际调用仍由 executeTool() 完成输入输出校验、权限和重试。
 */
export function createAgentTool<
  TInputSchema extends z.ZodType,
  TOutputSchema extends z.ZodType,
  TContext = undefined,
  TMetadata extends JsonObject = JsonObject,
>(tool: DefinedTool<TInputSchema, TOutputSchema, TContext, TMetadata>): AgentTool<TContext> {
  const execute: AgentTool<TContext>['execute'] = async (rawInput, options) => (
    executeTool(tool, rawInput, options)
  )
  return Object.freeze({
    name: tool.name,
    model: tool.model,
    ...(tool.guard ? { guard: tool.guard as AgentTool<TContext>['guard'] } : {}),
    execute,
  })
}

/** 构造只读工具索引，并在 Agent 启动时拒绝重复名称。 */
export function createAgentToolMap<TContext = undefined>(
  tools: readonly AgentTool<TContext>[],
): ReadonlyMap<string, AgentTool<TContext>> {
  const entries = new Map<string, AgentTool<TContext>>()
  for (const tool of tools) {
    if (entries.has(tool.name))
      throw new TypeError(`Agent 工具名称重复：${tool.name}`)
    entries.set(tool.name, tool)
  }
  return entries
}
