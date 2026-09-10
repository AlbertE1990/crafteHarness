import process, { loadEnvFile } from 'node:process'
import Agent from '../craft-agent'
import { serverToolGuard, serverTools } from './agent-tools'
import { createServerApp } from './app'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './database/postgres'
import { PostgresSessionStore } from './stores/postgres-session-store'

loadEnvFile('.env.local')
const PORT = Number(process.env.PORT ?? 3000)
const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
if (!apiKey)
  throw new Error('缺少环境变量 DEEPSEEK_API_KEY')

// Runtime 持有连接池生命周期；CraftAgent 只接收 SessionStore 协议。
const databasePool = createPostgresPool(readPostgresRuntimeConfig())
const postgresSessionStore = new PostgresSessionStore(databasePool)
const agent = new Agent({
  model: {
    adapter: 'deepseek',
    apiKey,
    baseURL: process.env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
  },
  systemPrompt: '你是一个AI助手',
  execution: {
    model: {
      stream: true,
      reasoning: {
        enabled: process.env.DEEPSEEK_THINKING !== 'disabled',
        ...(process.env.DEEPSEEK_REASONING_EFFORT?.trim()
          ? { effort: process.env.DEEPSEEK_REASONING_EFFORT.trim() }
          : {}),
      },
    },
    limits: {
      maxModelSteps: 5,
      maxToolCalls: 16,
      maxDurationMs: 120_000,
    },
  },
  tools: {
    additional: serverTools,
  },
  // 应用只实现风险评估规则；等待、超时、取消和防重复提交都由 Agent 内部完成。
  toolGuard: serverToolGuard,
  session: {
    store: postgresSessionStore,
  },
})
const fastify = createServerApp({ agent })
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
