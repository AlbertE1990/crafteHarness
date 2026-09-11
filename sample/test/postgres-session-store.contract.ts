import type { ModelStreamChunk } from '../src/craft-agent'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import process, { loadEnvFile } from 'node:process'
import { Pool } from 'pg'
import Agent, { SessionStoreError } from '../src/craft-agent'
import {
  createPostgresPool,
  readPostgresRuntimeConfig,
} from '../src/server/database/postgres'
import { PostgresSessionStore } from '../src/server/stores/postgres-session-store'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'
import { assertSessionStoreContract } from './support/session-store-contract'

if (existsSync('.env.local'))
  loadEnvFile('.env.local')

/**
 * 对学习者完成的 PostgreSQL Store 执行真实契约测试。
 *
 * 每次运行创建独立临时 schema，避免历史测试数据和开发会话影响目录顺序断言。
 */
async function main(): Promise<void> {
  const config = readPostgresRuntimeConfig()
  const administrationPool = createPostgresPool(config)
  const schema = `craft_agent_contract_${randomUUID().replaceAll('-', '')}`
  const migrationsUrl = new URL('../database/migrations/', import.meta.url)
  let pool: Pool | undefined

  try {
    await administrationPool.query(`CREATE SCHEMA ${schema}`)
    pool = new Pool({
      connectionString: config.connectionString,
      max: config.maxConnections,
      application_name: 'craft-agent-store-contract',
      // pg_trgm 安装在 public；隔离业务表时仍需让 PostgreSQL 找到扩展的 operator class。
      options: `-c search_path=${schema},public`,
      ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
    })
    const filenames = (await readdir(migrationsUrl))
      .filter(filename => /^\d+-[a-z0-9-]+\.sql$/i.test(filename))
      .sort((left, right) => left.localeCompare(right))
    for (const filename of filenames)
      await pool.query(await readFile(new URL(filename, migrationsUrl), 'utf8'))
    const store = new PostgresSessionStore(pool)
    const result = await assertSessionStoreContract(store, {
      sessionIdPrefix: 'postgres-contract',
      requireCatalog: true,
    })
    await assertConcurrentAppend(store)
    await assertAgentRestoresFromDatabase(store)
    process.stdout.write(`PostgresSessionStore 契约测试通过：${JSON.stringify(result, null, 2)}\n`)
  }
  finally {
    await pool?.end()
    // schema 名只由本进程生成；CASCADE 只删除本次契约测试创建的隔离对象。
    await administrationPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await administrationPool.end()
  }
}

/** 验证新 Agent 实例会从数据库恢复旧消息，而不是依赖前一个实例的内存。 */
async function assertAgentRestoresFromDatabase(store: PostgresSessionStore): Promise<void> {
  const scopeId = 'postgres-contract:agent-scope'
  const sessionId = 'postgres-contract:agent-restore'
  const firstAdapter = new ScriptedModelAdapter({
    script: [{ method: 'stream', chunks: [completionChunk('第一轮回答')] }],
  })
  await consume(new Agent({ model: firstAdapter, sessionStore: store }).stream({
    scopeId,
    sessionId,
    input: '第一轮问题',
  }))

  const secondAdapter = new ScriptedModelAdapter({
    script: [{ method: 'stream', chunks: [completionChunk('第二轮回答')] }],
  })
  await consume(new Agent({ model: secondAdapter, sessionStore: store }).stream({
    scopeId,
    sessionId,
    input: '第二轮问题',
  }))
  const rolesAndContent = secondAdapter.calls[0]?.request.messages.map(message => ({
    role: message.role,
    content: 'content' in message ? message.content : undefined,
  }))
  const expected = [
    { role: 'user', content: '第一轮问题' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '第二轮问题' },
  ]
  if (JSON.stringify(rolesAndContent) !== JSON.stringify(expected))
    throw new Error('PostgreSQL Agent 恢复失败：新实例未加载第一轮数据库历史')
}

/** 完整消费 Agent 输出；数据库契约只关心最终持久化事实。 */
async function consume(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events)
    void _event
}

/** 构造数据库集成探针使用的确定性模型完成块。 */
function completionChunk(content: string): ModelStreamChunk {
  return {
    id: `postgres-contract-${content}`,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      delta: { content },
    }],
    created: 1_788_748_800,
    model: 'scripted-postgres-model',
    object: 'chat.completion.chunk',
  }
}

/** 验证两个连接基于同一版本写入时，行锁只允许一个提交成功。 */
async function assertConcurrentAppend(store: PostgresSessionStore): Promise<void> {
  const scopeId = 'postgres-contract:concurrency-scope'
  const sessionId = 'postgres-contract:concurrency'
  await store.append({
    scopeId,
    sessionId,
    expectedVersion: 0,
    events: [{ type: 'session.created' }],
  })

  const results = await Promise.allSettled([
    store.append({
      scopeId,
      sessionId,
      expectedVersion: 1,
      events: [{
        type: 'message.appended',
        message: { role: 'user', content: '并发写入 A' },
      }],
    }),
    store.append({
      scopeId,
      sessionId,
      expectedVersion: 1,
      events: [{
        type: 'message.appended',
        message: { role: 'user', content: '并发写入 B' },
      }],
    }),
  ])
  const fulfilled = results.filter(result => result.status === 'fulfilled')
  const rejected = results.filter(result => result.status === 'rejected')
  if (fulfilled.length !== 1 || rejected.length !== 1)
    throw new Error('PostgreSQL 并发契约失败：同一 expectedVersion 必须一成一败')
  const reason = rejected[0]?.reason
  if (!(reason instanceof SessionStoreError) || reason.code !== 'SESSION_VERSION_CONFLICT')
    throw new Error('PostgreSQL 并发契约失败：失败写入必须返回 SESSION_VERSION_CONFLICT')
  if ((await store.read({ scopeId, sessionId })).latestVersion !== 2)
    throw new Error('PostgreSQL 并发契约失败：冲突写入不能推进 Session 版本')
}

main().catch((error: unknown) => {
  console.error('PostgresSessionStore 契约测试失败：', error)
  process.exitCode = 1
})
