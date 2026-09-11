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

const DEFAULT_MODEL = Object.freeze({ id: 'scripted-model' })

function baseConfig(adapter = new ScriptedModelAdapter({ script: [] })) {
  return { adapter, model: DEFAULT_MODEL }
}

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
    const adapter = new ScriptedModelAdapter({ provider: 'deepseek', script: [] })
    const config = defineAgentConfig({
      adapter,
      systemPrompt: '  你是测试助手  ',
      execution: {
        limits: { maxModelSteps: 8 },
      },
      model: {
        id: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    })

    expect(config).toMatchObject({
      systemPrompt: '你是测试助手',
      execution: {
        limits: { maxModelSteps: 8, maxToolCalls: 32 },
      },
      model: {
        id: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    })
    expect(config.adapter).toBe(adapter)
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
      ...baseConfig(),
      execution: { limits: { maxModelSteps: 0 } },
    })).toThrow('maxModelSteps')
  })

  it('normalizes an open reasoning level inside the model selection', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const config = defineAgentConfig({
      adapter,
      model: { id: 'future-model', reasoningEffort: 'provider-future-level' },
    })

    // 等级集合由供应商定义并会变化，因此 Core 只校验“提供了非空值”，不固定枚举。
    expect(config.model.reasoningEffort).toBe('provider-future-level')
    expect(() => defineAgentConfig({
      adapter,
      model: { id: 'future-model', reasoningEffort: ' ' },
    })).toThrow('Agent config.model.reasoningEffort 必须是非空字符串')

    // 只有保留值做大小写归一化；供应商等级原样保留，避免改写它的真实取值。
    expect(defineAgentConfig({
      adapter,
      model: { id: 'future-model', reasoningEffort: ' OFF ' },
    }).model.reasoningEffort).toBe('off')
    expect(defineAgentConfig({
      adapter,
      model: { id: 'future-model', reasoningEffort: 'High' },
    }).model.reasoningEffort).toBe('High')

    expect(() => defineAgentConfig({
      adapter,
      model: { id: 'future-model', reasoningEffort: { enabled: true } },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'reasoningEffort 必须是非空字符串',
    )

    // 推理设置已经离开 execution，旧配置必须被明确拒绝。
    expect(() => defineAgentConfig({
      adapter,
      model: { id: 'future-model' },
      execution: { reasoningEffort: 'high' },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.execution 包含未知字段：reasoningEffort',
    )
  })

  it('rejects removed flat fields and unknown grouped fields', () => {
    const base = baseConfig()

    expect(() => defineAgentConfig({
      ...base,
      store: new MemorySessionStore(),
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config 包含未知字段：store',
    )

    expect(() => defineAgentConfig({
      ...base,
      execution: { timeout: 1_000 },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.execution 包含未知字段：timeout',
    )

    expect(() => defineAgentConfig({
      ...base,
      session: { store: new MemorySessionStore() },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config 包含未知字段：session',
    )

    expect(() => defineAgentConfig({
      ...base,
      toolGuard: { evaluate: () => ({ decision: 'allow' }) },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config 包含未知字段：toolGuard',
    )

    expect(() => defineAgentConfig({
      ...base,
      execution: { createId: () => 'legacy-id' },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.execution 包含未知字段：createId',
    )
  })

  it('rejects removed declarative adapter fields instead of silently ignoring them', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    expect(() => defineAgentConfig({
      adapter,
      model: {
        id: 'legacy-model',
        adapter: 'openai-compatible',
      },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.model 包含未知字段：adapter',
    )

    expect(() => defineAgentConfig({
      model: { id: 'legacy-model' },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow(
      'Agent config.adapter 必须实现 ModelAdapter',
    )
  })

  it('keeps the injected adapter separate from the default model selection', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const config = defineAgentConfig({ adapter, model: DEFAULT_MODEL })

    expect(config.adapter).toBe(adapter)
    expect(config.model).toEqual(DEFAULT_MODEL)
  })

  it('lets Agent consume the same configuration shape directly', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const agent = new Agent({ adapter, model: DEFAULT_MODEL })

    expect(agent.store).toBe(agent.config.sessionStore)
    expect(agent.limits).toEqual({ maxModelSteps: 8, maxToolCalls: 32 })
  })

  it('normalizes Tool Guard defaults under the Agent configuration root', () => {
    const evaluate = () => ({ decision: 'allow' as const })
    const config = defineAgentConfig({
      ...baseConfig(),
      tools: { guard: evaluate, approvalTimeoutMs: 90_000 },
    })

    expect(config.tools).toMatchObject({ guard: evaluate, approvalTimeoutMs: 90_000 })
    expect(Object.isFrozen(config.tools)).toBe(true)

    const neverExpires = defineAgentConfig({
      ...baseConfig(),
      tools: { guard: evaluate, approvalTimeoutMs: -1 },
    })
    expect(neverExpires.tools.approvalTimeoutMs).toBe(-1)

    const unguarded = defineAgentConfig({
      ...baseConfig(),
    })
    expect(unguarded.tools.approvalTimeoutMs).toBe(120_000)
    expect(unguarded.tools).not.toHaveProperty('guard')
  })

  it('rejects invalid Tool Guard configuration before a Run starts', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    expect(() => defineAgentConfig({
      adapter,
      model: DEFAULT_MODEL,
      tools: { guard: () => ({ decision: 'allow' }), approvalTimeoutMs: 0 },
    })).toThrow('approvalTimeoutMs 必须是 -1，或 1 到 2147483647 的整数')

    expect(() => defineAgentConfig({
      adapter,
      model: DEFAULT_MODEL,
      // 验证运行时边界，而不依赖 TypeScript 编译期检查。
      tools: { guard: 'invalid' },
    } as unknown as Parameters<typeof defineAgentConfig>[0])).toThrow('tools.guard 必须是函数')
  })

  it('automatically registers only workspace-independent tools by default', () => {
    const config = defineAgentConfig({
      ...baseConfig(),
    })

    expect(config.tools.registered.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
    ])
    expect(Object.isFrozen(config.tools.registered)).toBe(true)
  })

  it('configures the workspace boundary only in extend mode', () => {
    const config = defineAgentConfig({
      ...baseConfig(),
      tools: { workspaceRoot: process.cwd() },
    })
    expect(config.tools.registered.some(tool => tool.name === 'read')).toBe(true)

    expect(() => defineAgentConfig({
      ...baseConfig(),
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
      ...baseConfig(),
      tools: {
        disabledBuiltins: ['calculator'],
        additional: [weather],
      },
    })

    expect(config.tools.registered.map(tool => tool.name)).toEqual([
      'get_current_time',
      'get_weather',
    ])
    expect(config.tools.registered.at(-1)).not.toBe(weather)
  })

  it('can explicitly override one built-in tool', () => {
    const calculator = createTestTool('calculator')
    const config = defineAgentConfig({
      ...baseConfig(),
      tools: {
        overrides: { calculator },
      },
    })

    expect(config.tools.registered.map(tool => tool.name)).toEqual([
      'get_current_time',
      'calculator',
    ])
    expect(config.tools.registered[1]).not.toBe(calculator)
    expect(config.tools.registered[1]?.model).toBe(calculator.model)
  })

  it('can replace a built-in tool Guard without replacing its implementation', async () => {
    const config = defineAgentConfig({
      ...baseConfig(),
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
      ...baseConfig(),
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
      ...baseConfig(),
      tools: {
        disabledBuiltins: ['calculator'],
        overrides: { calculator },
      },
    })).toThrow('不能同时禁用和覆盖')

    expect(() => defineAgentConfig({
      ...baseConfig(),
      tools: {
        additional: [calculator],
      },
    })).toThrow('Agent 工具名称重复：calculator')

    const wrongName = createTestTool('business_calculator')
    expect(() => defineAgentConfig({
      ...baseConfig(),
      tools: {
        overrides: { calculator: wrongName },
      },
    })).toThrow('覆盖实现必须使用相同名称')
  })
})
