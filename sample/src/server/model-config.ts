import type { ServerModelCapability, ServerModelInfo } from './app'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 模型目录文件的位置。
 *
 * 有哪些模型、每个模型能用哪些推理等级都是**部署事实**，因此只从这份文件读取：
 * 换模型或增删等级改这里并重启即可，不用改库、不用改 Adapter、也不用改前端。
 */
const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('../../config/models.json', import.meta.url))

/** 未配置 DEEPSEEK_BASE_URL 时使用的 DeepSeek 官方 endpoint。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

/** 部署提供的模型目录：模型集合与默认模型。 */
export interface ModelCatalog {
  readonly defaultModel: string
  readonly models: readonly ServerModelCapability[]
}

/** 从部署读取的连接配置与模型目录。 */
export interface DeepSeekRuntimeConfig extends ServerModelInfo {
  readonly apiKey: string
  readonly baseURL: string
}

/** 读取并校验部署配置；缺失或非法都在启动阶段一次性失败，不拖到第一次请求。 */
export function readDeepSeekRuntimeConfig(env: NodeJS.ProcessEnv): DeepSeekRuntimeConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey)
    throw new Error('缺少环境变量 DEEPSEEK_API_KEY')

  return Object.freeze({
    provider: 'deepseek',
    baseURL: env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    apiKey,
    ...readModelCatalogFile(env),
  })
}

/** 读取 `config/models.json`。 */
function readModelCatalogFile(env: NodeJS.ProcessEnv): ModelCatalog {
  const catalogPath = path.resolve(env.CRAFT_AGENT_MODELS_FILE?.trim() || DEFAULT_CATALOG_PATH)
  try {
    return parseModelCatalog(readFileSync(catalogPath, 'utf8'))
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`读取模型目录 ${catalogPath} 失败：${reason}`)
  }
}

/**
 * 解析并校验模型目录内容。
 *
 * 只做让部署能正常跑起来所必需的检查（有模型、有 id、默认值自洽），其余交给类型和运行结果
 * 暴露：配置文件是运维自己写的，不必在这里再堆一层通用校验框架。
 */
export function parseModelCatalog(text: string): ModelCatalog {
  const raw: unknown = JSON.parse(text)
  if (typeof raw !== 'object' || raw === null)
    throw new TypeError('模型目录必须是 JSON 对象')

  const catalog = raw as { defaultModel?: unknown, models?: unknown }
  if (!Array.isArray(catalog.models) || catalog.models.length === 0)
    throw new TypeError('模型目录的 models 必须是非空数组')

  const models = catalog.models.map(entry => toCapability(entry))
  const defaultModel = typeof catalog.defaultModel === 'string' && catalog.defaultModel.trim()
    ? catalog.defaultModel.trim()
    : models[0]!.id
  if (!models.some(model => model.id === defaultModel))
    throw new TypeError(`defaultModel ${defaultModel} 不在 models 中`)

  return { defaultModel, models: Object.freeze(models) }
}

/** 单个模型条目：只有 `id` 是必需的，其余字段都是可选补充。 */
function toCapability(entry: unknown): ServerModelCapability {
  if (typeof entry !== 'object' || entry === null)
    throw new TypeError('模型目录的每个模型都必须是对象')

  const source = entry as Record<string, unknown>
  const id = typeof source.id === 'string' ? source.id.trim() : ''
  if (!id)
    throw new TypeError('模型目录的每个模型都需要非空的 id')

  const reasoningEfforts = (Array.isArray(source.reasoningEfforts) ? source.reasoningEfforts : [])
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map(item => item.trim())
  const defaultReasoningEffort = typeof source.defaultReasoningEffort === 'string'
    && source.defaultReasoningEffort.trim()
    ? source.defaultReasoningEffort.trim()
    : null
  // 默认等级写错属于部署自己的配置错误，启动就报出来，好过每次请求静默不下发等级。
  if (defaultReasoningEffort && !reasoningEfforts.includes(defaultReasoningEffort)) {
    throw new TypeError(
      `模型 ${id} 的 defaultReasoningEffort ${defaultReasoningEffort} 不在 reasoningEfforts 中`,
    )
  }

  return Object.freeze({
    id,
    label: typeof source.label === 'string' && source.label.trim() ? source.label.trim() : id,
    reasoningEfforts: Object.freeze(reasoningEfforts),
    defaultReasoningEffort,
  })
}
