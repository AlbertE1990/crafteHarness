// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { Agent, defineAgentConfig } from '../src/craft-agent'
import { ScriptedModelAdapter } from '../src/craft-agent/adapters/testing'

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
})
