// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Agent,
  defineAgentConfig,
  defineTool,
  MemorySessionStore,
} from '../src/craft-agent'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

/** 创建配置测试使用的最小安全工具。 */
function createTestTool(name: string) {
  return defineTool({
    name,
    description: `${name} 测试工具`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ name: z.string() }),
    security: { risk: 'safe', capabilities: [], idempotent: true },
    execute: () => ({ name }),
  })
}

describe('agent config', () => {
  it('keeps agent and model settings under one configuration root', () => {
    const config = defineAgentConfig({
      systemPrompt: '  你是测试助手  ',
      execution: { limits: { maxModelSteps: 8 } },
      model: {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        thinking: 'enabled',
        reasoningEffort: 'max',
      },
    })

    expect(config).toMatchObject({
      systemPrompt: '你是测试助手',
      execution: { limits: { maxModelSteps: 8, maxToolCalls: 32 } },
      model: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.execution)).toBe(true)
    expect(Object.isFrozen(config.execution.limits)).toBe(true)
    expect(Object.isFrozen(config.session)).toBe(true)
    expect(Object.isFrozen(config.observability)).toBe(true)
  })

  it('rejects invalid step budgets', () => {
    expect(() => defineAgentConfig({
      execution: { limits: { maxModelSteps: 0 } },
      model: {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        thinking: 'enabled',
      },
    })).toThrow('maxModelSteps')
  })

  it('rejects removed flat fields and unknown grouped fields', () => {
    const model = new ScriptedModelAdapter({ script: [] })

    expect(() => defineAgentConfig({
      model,
      store: new MemorySessionStore(),
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config 包含未知字段：store',
    )

    expect(() => defineAgentConfig({
      model,
      execution: { timeout: 1_000 },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.execution 包含未知字段：timeout',
    )
  })

  it('creates the built-in OpenAI compatible adapter from the same config root', () => {
    const config = defineAgentConfig({
      model: {
        provider: 'openai-compatible',
        providerName: 'compatible-cloud',
        apiKey: 'test-key',
        baseURL: 'https://example.com/v1',
        model: 'compatible-model',
      },
    })

    expect(config.model).toMatchObject({
      provider: 'compatible-cloud',
      model: 'compatible-model',
    })
  })

  it('returns a custom adapter without creating a second configuration root', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const config = defineAgentConfig({ model: adapter })

    expect(config.model).toBe(adapter)
  })

  it('lets Agent consume the same configuration shape directly', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const agent = new Agent({ model: adapter })

    expect(agent.store).toBe(agent.config.session.store)
    expect(agent.limits).toEqual({ maxModelSteps: 8, maxToolCalls: 32 })
  })

  it('normalizes Tool Guard defaults under the Agent configuration root', () => {
    const evaluate = () => ({ decision: 'allow' as const })
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      toolGuard: { evaluate, approvalTimeoutMs: 90_000 },
    })

    expect(config.toolGuard).toEqual({ evaluate, approvalTimeoutMs: 90_000 })
    expect(Object.isFrozen(config.toolGuard)).toBe(true)

    const neverExpires = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      toolGuard: { evaluate, approvalTimeoutMs: -1 },
    })
    expect(neverExpires.toolGuard.approvalTimeoutMs).toBe(-1)
  })

  it('rejects invalid Tool Guard configuration before a Run starts', () => {
    const model = new ScriptedModelAdapter({ script: [] })
    expect(() => defineAgentConfig({
      model,
      toolGuard: { evaluate: () => ({ decision: 'allow' }), approvalTimeoutMs: 0 },
    })).toThrow('approvalTimeoutMs 必须是 -1，或 1 到 2147483647 的整数')

    expect(() => defineAgentConfig({
      model,
      // 验证运行时边界，而不依赖 TypeScript 编译期检查。
      toolGuard: { evaluate: undefined },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow('evaluate 必须是函数')
  })

  it('automatically registers all built-in tools by default', () => {
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
    })

    expect(config.tools.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
    ])
    expect(Object.isFrozen(config.tools)).toBe(true)
  })

  it('can disable a built-in tool and append application tools', () => {
    const weather = createTestTool('get_weather')
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        disabledBuiltins: ['calculator'],
        additional: [weather],
      },
    })

    expect(config.tools.map(tool => tool.name)).toEqual([
      'get_current_time',
      'get_weather',
    ])
    expect(config.tools.at(-1)).not.toBe(weather)
  })

  it('can explicitly override one built-in tool', () => {
    const calculator = createTestTool('calculator')
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        overrides: { calculator },
      },
    })

    expect(config.tools.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
    ])
    expect(config.tools[1]).not.toBe(calculator)
    expect(config.tools[1]?.model).toBe(calculator.model)
  })

  it('can replace the complete built-in tool collection', () => {
    const custom = createTestTool('only_custom_tool')
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        mode: 'replace',
        tools: [custom],
      },
    })

    expect(config.tools.map(tool => tool.name)).toEqual(['only_custom_tool'])
    expect(config.tools[0]).not.toBe(custom)
  })

  it('rejects ambiguous or duplicate tool configuration', () => {
    const calculator = createTestTool('calculator')
    expect(() => defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        disabledBuiltins: ['calculator'],
        overrides: { calculator },
      },
    })).toThrow('不能同时禁用和覆盖')

    expect(() => defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        additional: [calculator],
      },
    })).toThrow('Agent 工具名称重复：calculator')

    const wrongName = createTestTool('business_calculator')
    expect(() => defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        overrides: { calculator: wrongName },
      },
    })).toThrow('覆盖实现必须使用相同名称')
  })
})
