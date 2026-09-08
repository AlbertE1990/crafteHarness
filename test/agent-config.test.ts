// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Agent,
  defineAgentConfig,
  defineTool,
  defineTools,
} from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'

/** 创建配置测试使用的最小安全工具。 */
function createTestTool(name: string) {
  const [tool] = defineTools(defineTool({
    name,
    description: `${name} 测试工具`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ name: z.string() }),
    security: { risk: 'safe', capabilities: [], idempotent: true },
    execute: () => ({ name }),
  }))
  if (!tool)
    throw new Error(`测试工具 ${name} 创建失败`)
  return tool
}

describe('agent config', () => {
  it('keeps agent and model settings under one configuration root', () => {
    const config = defineAgentConfig({
      systemPrompt: '  你是测试助手  ',
      limits: { maxModelSteps: 8 },
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
      limits: { maxModelSteps: 8, maxToolCalls: 32 },
      model: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.limits)).toBe(true)
  })

  it('rejects invalid step budgets', () => {
    expect(() => defineAgentConfig({
      limits: { maxModelSteps: 0 },
      model: {
        provider: 'deepseek',
        apiKey: 'test-key',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
        thinking: 'enabled',
      },
    })).toThrow('maxModelSteps')
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

    expect(agent.store).toBe(agent.config.store)
    expect(agent.limits).toEqual({ maxModelSteps: 8, maxToolCalls: 32 })
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
    expect(config.tools[1]).toBe(calculator)
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

    expect(config.tools).toEqual([custom])
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
