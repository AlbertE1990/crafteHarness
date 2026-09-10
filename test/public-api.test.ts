// @vitest-environment node

import type {
  AgentConfigInput,
  AgentExecutionConfig,
  AgentModelExecutionOptions,
  AgentObservabilityConfig,
  AgentSessionConfig,
  AgentToolInput,
  DefinedAgentModelExecutionOptions,
  ModelAdapter,
  ModelReasoningOptions,
  SessionStore,
  ToolGuardConfig,
} from '../src/craft-agent'
import { describe, expect, it } from 'vitest'
import Agent, {
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  defineAgentConfig,
  defineTool,
  MemorySessionStore,
} from '../src/craft-agent'
import * as publicApi from '../src/craft-agent'
import {
  DeepSeekModelAdapter,
  OpenAICompatibleModelAdapter,
} from '../src/craft-agent/adapters'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

/** 编译期覆盖普通使用者需要命名的配置与扩展端口类型。 */
function acceptsPublicTypes(_value: {
  config: AgentConfigInput
  execution?: AgentExecutionConfig
  modelExecution?: AgentModelExecutionOptions
  definedModelExecution?: DefinedAgentModelExecutionOptions
  reasoning?: ModelReasoningOptions
  observability?: AgentObservabilityConfig
  session?: AgentSessionConfig
  tool?: AgentToolInput
  model?: ModelAdapter
  store?: SessionStore
  guard?: ToolGuardConfig
}): void {}

describe('craft-agent public API', () => {
  it('exports the normal developer facade and keeps internal normalization private', () => {
    const model = new ScriptedModelAdapter({ script: [] })
    const config: AgentConfigInput = {
      model,
      session: { store: new MemorySessionStore() },
      execution: { limits: { maxModelSteps: 2 } },
      observability: {},
    }

    acceptsPublicTypes({ config })
    expect(defineAgentConfig(config).model).toBe(model)
    expect(Agent).toBe(publicApi.Agent)
    expect(defineTool).toBeTypeOf('function')
    expect(DEFAULT_TOOL_APPROVAL_TIMEOUT_MS).toBeGreaterThan(0)
    expect('normalizeAgentToolDefinitions' in publicApi).toBe(false)
    expect('ToolApprovalManager' in publicApi).toBe(false)
  })

  it('types OpenAI compatible as the default and keeps provider separate from adapter', () => {
    const kimiConfig: AgentConfigInput = {
      model: {
        provider: 'moonshot',
        apiKey: 'test-key',
        baseURL: 'https://api.moonshot.cn/v1',
        model: 'kimi-k3',
      },
    }
    const deepSeekConfig: AgentConfigInput = {
      model: {
        adapter: 'deepseek',
        apiKey: 'test-key',
        model: 'deepseek-flash',
      },
      execution: { model: { reasoning: { enabled: true, effort: 'high' } } },
    }

    expect(defineAgentConfig(kimiConfig).model.provider).toBe('moonshot')
    expect(defineAgentConfig(deepSeekConfig).model.provider).toBe('deepseek')
  })

  it('exports production adapters only from the dedicated advanced entry', () => {
    expect(DeepSeekModelAdapter).toBeTypeOf('function')
    expect(OpenAICompatibleModelAdapter).toBeTypeOf('function')
    expect('DeepSeekModelAdapter' in publicApi).toBe(false)
  })
})
