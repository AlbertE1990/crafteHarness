import process, { loadEnvFile } from 'node:process'
import Agent from '../craft-agent'
import { serverToolGuard, serverTools } from './agent-tools'
import { createServerApp } from './app'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './database/postgres'
import { readDeepSeekRuntimeConfig } from './model-config'
import { PostgresSessionStore } from './stores/postgres-session-store'

loadEnvFile('.env.local')
const PORT = Number(process.env.PORT ?? 3000)

// 模型名、endpoint 和推理等级都是会变化的部署事实，统一在启动期校验一次。
const { apiKey, baseURL, ...modelInfo } = readDeepSeekRuntimeConfig(process.env)

// Runtime 持有连接池生命周期；CraftAgent 只接收 SessionStore 协议。
const databasePool = createPostgresPool(readPostgresRuntimeConfig())
const postgresSessionStore = new PostgresSessionStore(databasePool)
const agent = new Agent({
  model: {
    adapter: 'deepseek',
    apiKey,
    baseURL,
    model: modelInfo.model,
  },
  systemPrompt: '你是一个AI助手',
  execution: {
    // null 表示不覆盖：此时不下发任何推理参数，由供应商或模型自身默认值决定。
    ...(modelInfo.reasoningEffort === null
      ? {}
      : { reasoningEffort: modelInfo.reasoningEffort }),
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
})
const fastify = createServerApp({ agent, model: modelInfo })
fastify.addHook('onClose', async () => {
  await databasePool.end()
})

/** 启动本地 HTTP 服务；启动失败会由运行时记录为未处理异常并终止进程。 */
async function start(): Promise<void> {
  const database = await inspectPostgresConnection(databasePool)
  if (!database.sessionsTableExists || !database.eventsTableExists)
    throw new Error('PostgreSQL Session Log 表不存在，请先运行 pnpm db:migrate')
  await fastify.listen({ port: PORT, host: '127.0.0.1' })
}

void start()
