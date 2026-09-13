import { existsSync } from 'node:fs'
import path from 'node:path'
import process, { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import Agent from 'craft-harness'
import { DeepSeekAdapter } from 'craft-harness/adapters'
import { serverToolGuard, serverTools } from './agent-tools'
import { createServerApp } from './app'
import { runPostgresMigrations } from './database/migrations'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './database/postgres'
import { readDeepSeekRuntimeConfig } from './model-config'
import { PostgresSessionStore } from './stores/postgres-session-store'
import { PostgresTrajectoryStore } from './stores/postgres-trajectory-store'

// 相对模块定位 .env.local，而不是相对当前工作目录：脚本从仓库根执行，配置文件在 sample/。
// 文件缺失时继续使用宿主环境变量，便于容器和 CI 直接注入。
const envFile = process.env.CRAFT_SAMPLE_ENV_FILE?.trim()
  ? path.resolve(process.env.CRAFT_SAMPLE_ENV_FILE)
  : fileURLToPath(new URL('../../.env.local', import.meta.url))
if (existsSync(envFile))
  loadEnvFile(envFile)

const PORT = Number(process.env.PORT ?? 3000)
const staticRoot = path.resolve(
  process.env.CRAFT_SAMPLE_STATIC_ROOT?.trim()
  || fileURLToPath(new URL('../../dist/', import.meta.url)),
)
const staticIndex = path.join(staticRoot, 'index.html')
if (process.env.NODE_ENV === 'production' && !existsSync(staticIndex))
  throw new Error(`生产模式缺少前端构建产物：${staticIndex}`)

// 模型连接、可切换模型以及各自的推理能力都是会变化的部署事实，统一在启动期校验一次。
const { apiKey, baseURL, defaultModel, models, ...providerInfo } = readDeepSeekRuntimeConfig(process.env)

// Runtime 持有连接池生命周期；craft-harness 只接收 SessionStore 协议。
const databasePool = createPostgresPool(readPostgresRuntimeConfig())
const postgresSessionStore = new PostgresSessionStore(databasePool)
const postgresTrajectoryStore = new PostgresTrajectoryStore(databasePool)

const defaultCapability = models.find(model => model.id === defaultModel)
if (!defaultCapability)
  throw new Error(`默认模型 ${defaultModel} 没有对应的 Agent 实例`)

// Adapter 只持有连接和供应商协议；模型与推理强度可以在每次 Run 开始时整体切换。
const agent = new Agent({
  adapter: new DeepSeekAdapter({ apiKey, baseURL }),
  model: {
    id: defaultModel,
    ...(defaultCapability.defaultReasoningEffort
      ? { reasoningEffort: defaultCapability.defaultReasoningEffort }
      : {}),
  },
  systemPrompt: `你是一个 AI 助手。
当用户询问 Craft Harness 自身的功能、使用方式、API、架构或开发方式时，必须先调用 search_craft_harness_docs 检索官方项目文档，再依据检索结果回答并列出来源文件；文档没有明确说明的内容要如实说明。`,
  execution: {
    limits: {
      maxModelSteps: 5,
      maxToolCalls: 16,
      maxDurationMs: 120_000,
    },
  },
  tools: {
    additional: serverTools,
    guard: serverToolGuard,
    approvalTimeoutMs: 120_000,
  },
  // 应用只注入持久化 Port；Session ID 由 Agent 使用固定前缀和 UUID 生成。
  sessionStore: postgresSessionStore,
  observability: {
    onTrace: postgresTrajectoryStore.record,
  },
})

const fastify = createServerApp({
  agent,
  model: { ...providerInfo, defaultModel, models },
  // 名称是可变展示属性，删除会移除事实；两者都是应用层能力，不进库的 append-only 契约。
  conversations: {
    rename: (scopeId, sessionId, name) => postgresSessionStore.rename(
      { scopeId, sessionId },
      name,
    ),
    remove: (scopeId, sessionId) => postgresSessionStore.remove({
      scopeId,
      sessionId,
    }),
  },
  trajectory: postgresTrajectoryStore,
  ...(existsSync(staticIndex) ? { staticRoot } : {}),
})
fastify.addHook('onClose', async () => {
  await databasePool.end()
})

/** 启动本地 HTTP 服务；失败时由下方入口记录错误、关闭连接池并设置退出码。 */
async function start(): Promise<void> {
  const migration = await runPostgresMigrations(databasePool)
  const database = await inspectPostgresConnection(databasePool)
  if (!database.sessionsTableExists || !database.eventsTableExists)
    throw new Error('PostgreSQL 自动迁移后仍缺少 Session Log 表')
  if (migration.appliedMigrations.length > 0) {
    process.stdout.write(
      `PostgreSQL 已应用迁移：${migration.appliedMigrations.join(', ')}\n`,
    )
  }
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
}

void start().catch(async (error: unknown) => {
  console.error('sample Server 启动失败：', error)
  await databasePool.end().catch(() => undefined)
  process.exitCode = 1
})
