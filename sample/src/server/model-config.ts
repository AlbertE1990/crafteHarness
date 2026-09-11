import type { ServerModelInfo } from './app'

/** 未配置 DEEPSEEK_REASONING_EFFORTS 时的下拉候选；只影响 UI 提示，不限制请求。 */
const DEFAULT_REASONING_EFFORTS: readonly string[] = ['off', 'low', 'high', 'max']

/** 未配置 DEEPSEEK_BASE_URL 时使用的 DeepSeek 官方 endpoint。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/**
 * 从环境变量读取的 DeepSeek 部署配置。
 *
 * 模型名和推理等级集合都由供应商定义并会频繁变化，因此它们是部署配置而不是库配置：
 * 换模型或增删等级只需要修改 `.env.local` 并重启，不需要改库或前端代码。
 */
export interface DeepSeekRuntimeConfig extends ServerModelInfo {
  readonly apiKey: string
  readonly baseURL: string
}

/**
 * 校验并归一化 DeepSeek 部署配置。
 *
 * 缺失或非法的部署值在这里一次性失败，避免进程带着半套配置启动后在第一次请求才报错。
 * 本函数不读取全局环境，调用方显式传入环境对象，使部署约束可以独立测试。
 *
 * `reasoningEfforts` 只用于两件事：驱动前端下拉，以及校验部署自己的默认等级。
 * 它**不**参与请求校验——否则运维漏更新一个等级就会让合法请求失败，这正是要在库层
 * 消除的“过期枚举 fail closed”问题。
 */
export function readDeepSeekRuntimeConfig(env: NodeJS.ProcessEnv): DeepSeekRuntimeConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey)
    throw new Error('缺少环境变量 DEEPSEEK_API_KEY')

  // 库不再内置默认模型名：模型名会过期，必须由部署显式声明。
  const model = env.DEEPSEEK_MODEL?.trim()
  if (!model)
    throw new Error('缺少环境变量 DEEPSEEK_MODEL')

  const reasoningEfforts = readReasoningEfforts(env.DEEPSEEK_REASONING_EFFORTS)
  const reasoningEffort = readReasoningEffort(
    env.DEEPSEEK_REASONING_EFFORT,
    reasoningEfforts,
  )

  return Object.freeze({
    provider: 'deepseek',
    model,
    baseURL: env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    reasoningEffort,
    reasoningEfforts,
  })
}

/**
 * 解析允许的推理等级列表。
 *
 * 未设置时使用当前已知的候选，方便默认可用；显式设为空表示运维主动关闭下拉候选，
 * 此时前端退化为自由输入。非空列表始终包含保留值 `'off'`，且把它排在最前。
 */
function readReasoningEfforts(value: string | undefined): readonly string[] {
  if (value === undefined)
    return DEFAULT_REASONING_EFFORTS

  const parsed = dedupe(
    value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean),
  )
  if (!parsed.length)
    return []
  // 保留值始终排在最前，让“关闭推理”在候选列表中的位置稳定可预期。
  return Object.freeze(['off', ...parsed.filter(item => item !== 'off')])
}

/**
 * 解析部署默认推理等级；返回 null 表示不覆盖，让供应商或模型使用自身默认值。
 *
 * 默认等级由运维同时配置列表和默认值，因此这里在启动期就校验，属于部署配置自查。
 */
function readReasoningEffort(
  value: string | undefined,
  allowed: readonly string[],
): string | null {
  const effort = value?.trim().toLowerCase()
  if (!effort)
    return null
  if (allowed.length && !allowed.includes(effort)) {
    throw new Error(
      `DEEPSEEK_REASONING_EFFORT 取值 ${effort} 不在 DEEPSEEK_REASONING_EFFORTS 中：${allowed.join(', ')}`,
    )
  }
  return effort
}

/** 保持声明顺序去重，让下拉顺序稳定可预期。 */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)]
}
