// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { ScriptedModelAdapter } from '../src/common-agent/adapters/testing'
import { AgentConfig } from '../src/server/agent-config'

describe('agent config', () => {
  it('keeps agent and model settings under one configuration root', () => {
    const config = new AgentConfig({
      systemPrompt: '  你是测试助手  ',
      maxModelSteps: 8,
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
      maxModelSteps: 8,
      model: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'max',
      },
    })
    expect(Object.isFrozen(config.model)).toBe(true)
  })

  it('rejects invalid step budgets', () => {
    expect(() => new AgentConfig({
      maxModelSteps: 0,
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
    const config = new AgentConfig({
      model: {
        provider: 'openai-compatible',
        providerName: 'compatible-cloud',
        apiKey: 'test-key',
        baseURL: 'https://example.com/v1',
        model: 'compatible-model',
      },
    })

    expect(config.createModelAdapter()).toMatchObject({
      provider: 'compatible-cloud',
      model: 'compatible-model',
    })
  })

  it('returns a custom adapter without moving model settings outside AgentConfig', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const config = new AgentConfig({
      model: { provider: 'custom', adapter },
    })

    expect(config.createModelAdapter()).toBe(adapter)
  })
})
