import type { ModelAdapter, ToolEventListener } from '../common-agent'
import type { DeepSeekModelAdapterConfig, DeepSeekThinkingMode } from '../common-agent/adapters/deepseek'
import type { OpenAICompatibleModelAdapterConfig } from '../common-agent/adapters/openai-compatible'
import process from 'node:process'
import { DeepSeekModelAdapter } from '../common-agent/adapters/deepseek'
import { OpenAICompatibleModelAdapter } from '../common-agent/adapters/openai-compatible'

/** Runtime 内置的 DeepSeek 模型配置。 */
export interface DeepSeekAgentModelConfig extends DeepSeekModelAdapterConfig {
  readonly provider: 'deepseek'
  readonly apiKey: string
  readonly baseURL: string
  readonly model: string
  readonly thinking: DeepSeekThinkingMode
}

/** Runtime 内置的 OpenAI Chat Completions 兼容模型配置。 */
export interface OpenAICompatibleAgentModelConfig
  extends Omit<OpenAICompatibleModelAdapterConfig, 'provider'> {
  readonly provider: 'openai-compatible'
  /** 进入日志与标准响应的真实供应商名称，默认 `openai`。 */
  readonly providerName?: string
}

/** 高级调用方直接提供的自定义 Adapter 配置。 */
export interface CustomAgentModelConfig {
  readonly provider: 'custom'
  readonly adapter: ModelAdapter
}

/** Agent 唯一配置根支持的内置模型与自定义 Adapter 判别联合。 */
export type AgentModelConfig
  = | DeepSeekAgentModelConfig
    | OpenAICompatibleAgentModelConfig
    | CustomAgentModelConfig

/** 构造统一 AgentConfig 时使用的全部基础配置与模型配置。 */
export interface AgentConfigOptions {
  readonly systemPrompt?: string
  readonly maxModelSteps?: number
  readonly model: AgentModelConfig
  readonly onToolEvent?: ToolEventListener
}

/** 从环境变量创建配置时允许覆盖的非敏感选项。 */
export interface AgentEnvironmentOverrides {
  readonly systemPrompt?: string
  readonly maxModelSteps?: number
  readonly onToolEvent?: ToolEventListener
}

/**
 * Agent 的统一配置根。
 *
 * Agent 基础配置和模型供应商配置只从本类进入 Runtime，避免构造函数、环境变量和 Adapter
 * 分别维护默认值。未来新增 Store、审批和预算配置时继续挂在同一根对象下。
 */
export class AgentConfig {
  readonly systemPrompt: string
  readonly maxModelSteps: number
  readonly model: Readonly<AgentModelConfig>
  readonly onToolEvent?: ToolEventListener

  constructor(options: AgentConfigOptions) {
    const systemPrompt = options.systemPrompt?.trim() || '你是一个AI助手'
    const maxModelSteps = options.maxModelSteps ?? 5
    if (!Number.isInteger(maxModelSteps) || maxModelSteps < 1)
      throw new Error('maxModelSteps 必须是大于 0 的整数')
    validateModelConfig(options.model)

    this.systemPrompt = systemPrompt
    this.maxModelSteps = maxModelSteps
    this.model = Object.freeze({ ...options.model })
    this.onToolEvent = options.onToolEvent
  }

  /** 从进程环境创建当前服务的完整配置。 */
  static fromEnv(overrides: AgentEnvironmentOverrides = {}): AgentConfig {
    const apiKey = process.env.DEEPSEEK_API_KEY
    if (!apiKey)
      throw new Error('缺少环境变量 DEEPSEEK_API_KEY')

    return new AgentConfig({
      ...overrides,
      model: {
        provider: 'deepseek',
        apiKey,
        baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
        model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
        thinking: process.env.DEEPSEEK_THINKING === 'disabled' ? 'disabled' : 'enabled',
        reasoningEffort: normalizeReasoningEffort(process.env.DEEPSEEK_REASONING_EFFORT),
      },
    })
  }

  /** 根据统一模型配置创建供应商 Adapter；供应商选择只发生在 Runtime 组装边界。 */
  createModelAdapter(): ModelAdapter {
    if (this.model.provider === 'deepseek')
      return new DeepSeekModelAdapter(this.model)

    if (this.model.provider === 'openai-compatible') {
      return new OpenAICompatibleModelAdapter({
        apiKey: this.model.apiKey,
        baseURL: this.model.baseURL,
        model: this.model.model,
        provider: this.model.providerName,
      })
    }

    return this.model.adapter
  }
}

/** 在创建 Agent 前验证所有模型配置分支的稳定身份和必需凭据。 */
function validateModelConfig(model: AgentModelConfig): void {
  if (model.provider === 'custom') {
    if (!model.adapter.provider.trim() || !model.adapter.model.trim())
      throw new Error('自定义 ModelAdapter 的 provider 和 model 不能为空')
    if (typeof model.adapter.complete !== 'function'
      || typeof model.adapter.stream !== 'function') {
      throw new TypeError('自定义 ModelAdapter 必须实现 complete 和 stream')
    }
    return
  }

  if (!model.apiKey.trim())
    throw new Error('模型 apiKey 不能为空')
  if (!model.model.trim())
    throw new Error('模型 model 不能为空')
  if (model.provider === 'openai-compatible'
    && model.providerName !== undefined
    && !model.providerName.trim()) {
    throw new Error('模型 providerName 不能为空字符串')
  }
}

/** 环境变量只接受 DeepSeek 当前支持的思考强度。 */
function normalizeReasoningEffort(
  value: string | undefined,
): DeepSeekAgentModelConfig['reasoningEffort'] {
  if (value === undefined || value === '')
    return undefined
  if (value === 'low' || value === 'high' || value === 'max')
    return value
  throw new Error('DEEPSEEK_REASONING_EFFORT 必须是 low、high 或 max')
}
