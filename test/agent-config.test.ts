// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Agent,
  defineAgentConfig,
  defineTool,
  MemorySessionStore,
} from '../src'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

/** 创建配置测试使用的最小安全工具。 */
function createTestTool(name: string) {
  return defineTool({
    name,
    description: `${name} 测试工具`,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ name: z.string() }),
    execute: () => ({ name }),
  })
}

describe('agent config', () => {
  it('keeps agent and model settings under one configuration root', () => {
    const config = defineAgentConfig({
      systemPrompt: '  你是测试助手  ',
      execution: {
        reasoningEffort: 'max',
        limits: { maxModelSteps: 8 },
      },
      model: {
        adapter: 'deepseek',
        apiKey: 'test-key',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
      },
    })

    expect(config).toMatchObject({
      systemPrompt: '你是测试助手',
      execution: {
        reasoningEffort: 'max',
        limits: { maxModelSteps: 8, maxToolCalls: 32 },
      },
      model: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      },
    })
    expect(Object.isFrozen(config)).toBe(true)
    expect(Object.isFrozen(config.execution)).toBe(true)
    expect(Object.isFrozen(config.execution.limits)).toBe(true)
    expect(config.sessionStore).toBeInstanceOf(MemorySessionStore)
    expect(Object.isFrozen(config.tools)).toBe(true)
    expect(Object.isFrozen(config.tools.registered)).toBe(true)
    expect(Object.isFrozen(config.observability)).toBe(true)
  })

  it('rejects invalid step budgets', () => {
    expect(() => defineAgentConfig({
      execution: { limits: { maxModelSteps: 0 } },
      model: {
        adapter: 'deepseek',
        apiKey: 'test-key',
        baseURL: 'https://api.deepseek.com',
        model: 'deepseek-v4-flash',
      },
    })).toThrow('maxModelSteps')
  })

  it('accepts an open reasoning level and rejects the removed model group', () => {
    const model = new ScriptedModelAdapter({ script: [] })
    const config = defineAgentConfig({
      model,
      execution: { reasoningEffort: 'provider-future-level' },
    })

    // 等级集合由供应商定义并会变化，因此 Core 只校验“提供了非空值”，不固定枚举。
    expect(config.execution.reasoningEffort).toBe('provider-future-level')
    expect(() => defineAgentConfig({
      model,
      execution: { reasoningEffort: ' ' },
    })).toThrow('Agent config.execution.reasoningEffort 必须是非空字符串')

    // 只有保留值做大小写归一化；供应商等级原样保留，避免改写它的真实取值。
    expect(defineAgentConfig({
      model,
      execution: { reasoningEffort: ' OFF ' },
    }).execution.reasoningEffort).toBe('off')
    expect(defineAgentConfig({
      model,
      execution: { reasoningEffort: 'High' },
    }).execution.reasoningEffort).toBe('High')

    expect(() => defineAgentConfig({
      model,
      execution: { reasoningEffort: { enabled: true } },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'reasoningEffort 必须是非空字符串',
    )

    // 旧的单字段包装组已被移除，误写时必须在配置边界报错而不是静默退回默认值。
    expect(() => defineAgentConfig({
      model,
      execution: { model: { reasoningEffort: 'high' } },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.execution 包含未知字段：model',
    )
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

    expect(() => defineAgentConfig({
      model,
      session: { store: new MemorySessionStore() },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config 包含未知字段：session',
    )

    expect(() => defineAgentConfig({
      model,
      toolGuard: { evaluate: () => ({ decision: 'allow' }) },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config 包含未知字段：toolGuard',
    )

    expect(() => defineAgentConfig({
      model,
      execution: { createId: () => 'legacy-id' },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.execution 包含未知字段：createId',
    )
  })

  it('creates the built-in OpenAI compatible adapter from the same config root', () => {
    const config = defineAgentConfig({
      model: {
        provider: 'compatible-cloud',
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

  it('allows explicitly selecting the OpenAI compatible default adapter', () => {
    const config = defineAgentConfig({
      model: {
        adapter: 'openai-compatible',
        apiKey: 'test-key',
        model: 'openai-model',
      },
    })

    expect(config.model).toMatchObject({
      provider: 'openai',
      model: 'openai-model',
    })
  })

  it('rejects removed model discriminators instead of silently ignoring them', () => {
    expect(() => defineAgentConfig({
      model: {
        provider: 'openai-compatible',
        providerName: 'legacy-provider',
        apiKey: 'test-key',
        model: 'legacy-model',
      },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      '请选择 adapter: \'openai-compatible\'',
    )

    expect(() => defineAgentConfig({
      model: {
        provider: 'legacy-provider',
        providerName: 'legacy-provider',
        apiKey: 'test-key',
        model: 'legacy-model',
      },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.model 包含未知字段：providerName',
    )

    expect(() => defineAgentConfig({
      model: {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: 'deepseek-model',
      },
    })).toThrow('请选择 adapter: \'deepseek\'')
  })

  it('returns a custom adapter without creating a second configuration root', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const config = defineAgentConfig({ model: adapter })

    expect(config.model).toBe(adapter)
  })

  it('lets Agent consume the same configuration shape directly', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const agent = new Agent({ model: adapter })

    expect(agent.store).toBe(agent.config.sessionStore)
    expect(agent.limits).toEqual({ maxModelSteps: 8, maxToolCalls: 32 })
  })

  it('normalizes Tool Guard defaults under the Agent configuration root', () => {
    const evaluate = () => ({ decision: 'allow' as const })
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: { guard: evaluate, approvalTimeoutMs: 90_000 },
    })

    expect(config.tools).toMatchObject({ guard: evaluate, approvalTimeoutMs: 90_000 })
    expect(Object.isFrozen(config.tools)).toBe(true)

    const neverExpires = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: { guard: evaluate, approvalTimeoutMs: -1 },
    })
    expect(neverExpires.tools.approvalTimeoutMs).toBe(-1)

    const unguarded = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
    })
    expect(unguarded.tools.approvalTimeoutMs).toBe(120_000)
    expect(unguarded.tools).not.toHaveProperty('guard')
  })

  it('rejects invalid Tool Guard configuration before a Run starts', () => {
    const model = new ScriptedModelAdapter({ script: [] })
    expect(() => defineAgentConfig({
      model,
      tools: { guard: () => ({ decision: 'allow' }), approvalTimeoutMs: 0 },
    })).toThrow('approvalTimeoutMs 必须是 -1，或 1 到 2147483647 的整数')

    expect(() => defineAgentConfig({
      model,
      // 验证运行时边界，而不依赖 TypeScript 编译期检查。
      tools: { guard: 'invalid' },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow('tools.guard 必须是函数')
  })

  it('automatically registers all built-in tools by default', () => {
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
    })

    expect(config.tools.registered.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'terminal',
    ])
    expect(Object.isFrozen(config.tools.registered)).toBe(true)
  })

  it('configures the workspace boundary only in extend mode', () => {
    const model = new ScriptedModelAdapter({ script: [] })
    const config = defineAgentConfig({ model, tools: { workspaceRoot: process.cwd() } })
    expect(config.tools.registered.some(tool => tool.name === 'read')).toBe(true)

    expect(() => defineAgentConfig({
      model,
      tools: {
        mode: 'replace',
        tools: [],
        workspaceRoot: process.cwd(),
      } as unknown as Parameters<typeof defineAgentConfig>[0]['tools'],
    })).toThrow('replace 模式')
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

    expect(config.tools.registered.map(tool => tool.name)).toEqual([
      'get_current_time',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'terminal',
      'get_weather',
    ])
    expect(config.tools.registered.at(-1)).not.toBe(weather)
  })

  it('can explicitly override one built-in tool', () => {
    const calculator = createTestTool('calculator')
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        overrides: { calculator },
      },
    })

    expect(config.tools.registered.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'terminal',
    ])
    expect(config.tools.registered[1]).not.toBe(calculator)
    expect(config.tools.registered[1]?.model).toBe(calculator.model)
  })

  it('can replace a built-in tool Guard without replacing its implementation', async () => {
    const config = defineAgentConfig({
      model: new ScriptedModelAdapter({ script: [] }),
      tools: {
        guardOverrides: {
          calculator: () => ({ decision: 'deny', reason: '当前部署禁用计算器' }),
        },
      },
    })
    const calculator = config.tools.registered.find(tool => tool.name === 'calculator')!

    await expect(calculator.execute({ operation: 'add', values: [1, 2] }, {
      callId: 'call-overridden-builtin',
    })).resolves.toMatchObject({
      ok: false,
      attempts: 0,
      error: { code: 'TOOL_PERMISSION_DENIED', message: '当前部署禁用计算器' },
    })
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

    expect(config.tools.registered.map(tool => tool.name)).toEqual(['only_custom_tool'])
    expect(config.tools.registered[0]).not.toBe(custom)
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
