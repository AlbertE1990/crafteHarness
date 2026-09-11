// @vitest-environment node

import type {
  AgentConfigInput,
  AgentExecutionConfig,
  AgentObservabilityConfig,
  AgentToolInput,
  AgentToolsCommonConfig,
  CalculatorToolOptions,
  DefineToolOptions,
  HarnessLocale,
  ModelAdapter,
  ModelSelection,
  SessionStore,
  ToolExecutionConfig,
  ToolGuardDecision,
  ToolGuardEvaluator,
  ToolGuardRequest,
  ToolGuardToolInfo,
  ToolRunContext,
} from '../src'
import { describe, expect, it } from 'vitest'
import Agent, {
  DEFAULT_TOOL_APPROVAL_TIMEOUT_MS,
  defineAgentConfig,
  defineTool,
  MemorySessionStore,
  SUPPORTED_LOCALES,
} from '../src'
import * as publicApi from '../src'
import {
  DeepSeekAdapter,
  OpenAICompatibleAdapter,
} from '../src/adapters'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

/** 编译期覆盖普通使用者需要命名的配置与扩展端口类型。 */
function acceptsPublicTypes(_value: {
  config: AgentConfigInput
  locale?: HarnessLocale
  defineToolOptions?: DefineToolOptions
  calculatorOptions?: CalculatorToolOptions
  execution?: AgentExecutionConfig
  observability?: AgentObservabilityConfig
  tools?: AgentToolsCommonConfig
  tool?: AgentToolInput
  adapter?: ModelAdapter
  model?: ModelSelection
  store?: SessionStore
  toolExecution?: ToolExecutionConfig
  guardDecision?: ToolGuardDecision
  guardEvaluator?: ToolGuardEvaluator
  guardRequest?: ToolGuardRequest
  guardTool?: ToolGuardToolInfo
  toolRunContext?: ToolRunContext
}): void {}

describe('craft-harness public API', () => {
  it('exports the normal developer facade and keeps internal normalization private', () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const config: AgentConfigInput = {
      adapter,
      model: { id: 'scripted-model' },
      sessionStore: new MemorySessionStore(),
      execution: { limits: { maxModelSteps: 2 } },
      observability: {},
    }

    acceptsPublicTypes({ config })
    expect(defineAgentConfig(config).adapter).toBe(adapter)
    expect(defineAgentConfig(config).model).toEqual({ id: 'scripted-model' })
    expect(Agent).toBe(publicApi.Agent)
    expect(new Agent(config).invoke).toBeTypeOf('function')
    expect(new Agent(config).stream).toBeTypeOf('function')
    expect('run' in new Agent(config)).toBe(false)
    expect(defineTool).toBeTypeOf('function')
    expect(DEFAULT_TOOL_APPROVAL_TIMEOUT_MS).toBeGreaterThan(0)
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US'])
    expect('normalizeAgentToolDefinitions' in publicApi).toBe(false)
    expect('ToolApprovalManager' in publicApi).toBe(false)
  })

  it('keeps provider connection settings in the adapter and model choice beside it', () => {
    const kimiConfig: AgentConfigInput = {
      adapter: new OpenAICompatibleAdapter({
        provider: 'moonshot',
        apiKey: 'test-key',
        baseURL: 'https://api.moonshot.cn/v1',
      }),
      model: { id: 'kimi-k3' },
    }
    const deepSeekConfig: AgentConfigInput = {
      adapter: new DeepSeekAdapter({
        apiKey: 'test-key',
      }),
      model: { id: 'deepseek-flash', reasoningEffort: 'high' },
    }

    expect(defineAgentConfig(kimiConfig).adapter.provider).toBe('moonshot')
    expect(defineAgentConfig(kimiConfig).model.id).toBe('kimi-k3')
    expect(defineAgentConfig(deepSeekConfig).adapter.provider).toBe('deepseek')
    expect(defineAgentConfig(deepSeekConfig).model.reasoningEffort).toBe('high')
  })

  it('exports production adapters only from the dedicated advanced entry', () => {
    expect(DeepSeekAdapter).toBeTypeOf('function')
    expect(OpenAICompatibleAdapter).toBeTypeOf('function')
    expect('DeepSeekAdapter' in publicApi).toBe(false)
  })

  it('types trusted per-run context at the Agent boundary', () => {
    interface AppContext {
      readonly tenantId: string
      readonly environment: 'test'
    }
    const config: AgentConfigInput<AppContext> = {
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
      tools: {
        guard: request => request.context.tenantId
          ? { decision: 'allow' }
          : { decision: 'deny', reason: '缺少租户' },
      },
    }
    const agent = new Agent<AppContext>(config)
    const request: Parameters<typeof agent.invoke>[0] = {
      scopeId: 'scope-public-api',
      input: '测试上下文类型',
      context: { tenantId: 'tenant-a', environment: 'test' },
    }

    expect(agent).toBeInstanceOf(Agent)
    expect(request.context.tenantId).toBe('tenant-a')
  })
})
