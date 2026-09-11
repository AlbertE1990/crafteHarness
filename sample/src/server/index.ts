import { existsSync } from 'node:fs'
import process, { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import Agent from '../../../src'
import { serverToolGuard, serverTools } from './agent-tools'
import { createServerApp } from './app'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './database/postgres'
import { readDeepSeekRuntimeConfig } from './model-config'
import { PostgresSessionStore } from './stores/postgres-session-store'

/** 当前参考 Runtime 是单用户部署，仍显式组装固定 Session 作用域。 */
const SINGLE_USER_SCOPE_ID = 'default'

// 相对模块定位 .env.local，而不是相对当前工作目录：脚本从仓库根执行，配置文件在 sample/。
// 文件缺失时继续使用宿主环境变量，便于容器和 CI 直接注入。
const envFile = fileURLToPath(new URL('../../.env.local', import.meta.url))
if (existsSync(envFile))
  loadEnvFile(envFile)

const PORT = Number(process.env.PORT ?? 3000)

// 模型连接、可切换模型以及各自的推理能力都是会变化的部署事实，统一在启动期校验一次。
const { apiKey, baseURL, defaultModel, models, ...providerInfo } = readDeepSeekRuntimeConfig(process.env)

// Runtime 持有连接池生命周期；craft-harness 只接收 SessionStore 协议。
const databasePool = createPostgresPool(readPostgresRuntimeConfig())
const postgresSessionStore = new PostgresSessionStore(databasePool)

/**
 * 每个可切换模型一个 Agent；它们共享同一个 Session Store 与工具集合。
 *
 * 库把模型名绑定在 Adapter 实例上（不是请求参数），所以"切换模型"在 Runtime 层就是
 * 选择不同实例。同一会话先后使用不同模型是允许的：会话事实按 Session 记录，与模型无关。
 *
 * 推理等级不在这里固定：目录里的值是**按模型**的，由 HTTP 边界按本次选中的模型解析后再下发。
 */
function createAgentForModel(model: string): Agent {
  return new Agent({
    model: {
      adapter: 'deepseek',
      apiKey,
      baseURL,
      model,
    },
    systemPrompt: '你是一个AI助手',
    execution: {
      limits: {
        maxModelSteps: 5,
        maxToolCalls: 16,
        maxDurationMs: 120_000,
      },
    },
    tools: {
      workspaceRoot: process.cwd(),
      additional: serverTools,
      guard: serverToolGuard,
      approvalTimeoutMs: 120_000,
    },
    // 应用只注入持久化 Port；Session ID 由 Agent 使用固定前缀和 UUID 生成。
    sessionStore: postgresSessionStore,
  })
}

const agentsByModel = new Map(models.map(model => [model.id, createAgentForModel(model.id)]))
const defaultAgent = agentsByModel.get(defaultModel)
if (!defaultAgent)
  throw new Error(`默认模型 ${defaultModel} 没有对应的 Agent 实例`)

const fastify = createServerApp({
  agent: defaultAgent,
  model: { ...providerInfo, defaultModel, models },
  resolveAgent: model => agentsByModel.get(model),
  // 名称是可变展示属性，删除会移除事实；两者都是应用层能力，不进库的 append-only 契约。
  conversations: {
    rename: (sessionId, name) => postgresSessionStore.rename(
      { scopeId: SINGLE_USER_SCOPE_ID, sessionId },
      name,
    ),
    remove: sessionId => postgresSessionStore.remove({
      scopeId: SINGLE_USER_SCOPE_ID,
      sessionId,
    }),
  },
})
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
