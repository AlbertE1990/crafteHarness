import type { ModelStreamChunk } from 'craft-harness'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import process, { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import Agent, { SessionStoreError } from 'craft-harness'
import { ScriptedModelAdapter } from '../../test/support/scripted-model-adapter'
import { assertSessionStoreContract } from '../../test/support/session-store-contract'
import { runMySqlMigrations } from '../src/server/database/migrations'
import {
  createMySqlPool,
  readMySqlRuntimeConfig,
} from '../src/server/database/mysql'
import { MySqlSessionStore } from '../src/server/stores/mysql-session-store'

// 相对模块定位 sample/.env.local，而不是相对当前工作目录：脚本从仓库根执行。
const envFile = fileURLToPath(new URL('../.env.local', import.meta.url))
if (existsSync(envFile))
  loadEnvFile(envFile)

/**
 * 对 MySQL Store 执行真实契约测试；随机 scope 隔离测试数据，结束后主动清理。
 */
async function main(): Promise<void> {
  const pool = createMySqlPool(readMySqlRuntimeConfig())
  const prefix = `mysql-contract-${randomUUID()}`
  const store = new MySqlSessionStore(pool)
  let migrationsReady = false

  try {
    await runMySqlMigrations(pool)
    migrationsReady = true
    const result = await assertSessionStoreContract(store, {
      sessionIdPrefix: prefix,
      requireCatalog: true,
    })
    await assertConcurrentAppend(store, prefix)
    await assertAgentRestoresFromDatabase(store, prefix)
    await assertRenameAndRemove(store, prefix)
    process.stdout.write(`MySqlSessionStore 契约测试通过：${JSON.stringify(result, null, 2)}\n`)
  }
  finally {
    try {
      if (migrationsReady) {
        for (const scopeId of [
          `${prefix}:scope`,
          `${prefix}:other-scope`,
          `${prefix}:agent-scope`,
          `${prefix}:mutation-scope`,
          `${prefix}:concurrency-scope`,
        ]) {
          await cleanupScope(store, scopeId)
        }
      }
    }
    finally {
      await pool.end()
    }
  }
}

/** 验证新 Agent 实例会从数据库恢复旧消息，而不是依赖前一个实例的内存。 */
async function assertAgentRestoresFromDatabase(store: MySqlSessionStore, prefix: string): Promise<void> {
  const scopeId = `${prefix}:agent-scope`
  const sessionId = `${prefix}:agent-restore`
  const firstAdapter = new ScriptedModelAdapter({
    script: [{ method: 'stream', chunks: [completionChunk('第一轮回答')] }],
  })
  await consume(new Agent({
    adapter: firstAdapter,
    model: { id: 'scripted-model' },
    sessionStore: store,
  }).stream({
    scopeId,
    sessionId,
    input: '第一轮问题',
  }))

  const secondAdapter = new ScriptedModelAdapter({
    script: [{ method: 'stream', chunks: [completionChunk('第二轮回答')] }],
  })
  await consume(new Agent({
    adapter: secondAdapter,
    model: { id: 'scripted-model' },
    sessionStore: store,
  }).stream({
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
    throw new Error('MySQL Agent 恢复失败：新实例未加载第一轮数据库历史')
}

/**
 * 验证重命名与删除在真实数据库上的行为。
 *
 * 名称是目录投影：改名后 list/read 都应看到新名称，而 `session.created` 事件仍保留
 * 创建时的原始名称。删除必须连同事件一起移除，否则外键会让目录行删不掉。
 */
async function assertRenameAndRemove(store: MySqlSessionStore, prefix: string): Promise<void> {
  const scopeId = `${prefix}:mutation-scope`
  const sessionId = `${prefix}:mutation`
  await consume(new Agent({
    adapter: new ScriptedModelAdapter({
      script: [{ method: 'stream', chunks: [completionChunk('待重命名回答')] }],
    }),
    model: { id: 'scripted-model' },
    sessionStore: store,
  }).stream({
    scopeId,
    sessionId,
    sessionName: '原始名称',
    input: '第一问',
  }))

  const renamed = await store.rename({ scopeId, sessionId }, '改后的名称')
  if (renamed?.sessionName !== '改后的名称')
    throw new Error(`重命名未返回更新后的摘要：${JSON.stringify(renamed)}`)

  const listed = await store.list({ scopeId })
  if (listed.sessions.find(item => item.sessionId === sessionId)?.sessionName !== '改后的名称')
    throw new Error('重命名后目录未反映新名称')

  const page = await store.read({ scopeId, sessionId })
  if (page.sessionName !== '改后的名称')
    throw new Error('重命名后 read() 未反映新名称')
  const created = page.events.find(event => event.type === 'session.created')
  if (created?.type !== 'session.created' || created.sessionName !== '原始名称')
    throw new Error('重命名不应改写 session.created 事件里的原始名称')

  if (await store.rename({ scopeId, sessionId: `${prefix}:absent` }, '名称') !== undefined)
    throw new Error('对不存在的会话重命名应返回 undefined')

  if (!await store.remove({ scopeId, sessionId }))
    throw new Error('删除已存在的会话应返回 true')
  if (await store.remove({ scopeId, sessionId }))
    throw new Error('重复删除应返回 false')

  const afterRemove = await store.list({ scopeId })
  if (afterRemove.sessions.some(item => item.sessionId === sessionId))
    throw new Error('删除后会话仍出现在目录中')
  const eventsAfterRemove = await store.read({ scopeId, sessionId })
  if (eventsAfterRemove.events.length !== 0 || eventsAfterRemove.latestVersion !== 0)
    throw new Error('删除后事件应全部移除')
}

/** 完整消费 Agent 输出；数据库契约只关心最终持久化事实。 */
async function consume(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events)
    void _event
}

/** 构造数据库集成探针使用的确定性模型完成块。 */
function completionChunk(content: string): ModelStreamChunk {
  return {
    id: `mysql-contract-${content}`,
    choices: [{
      index: 0,
      finish_reason: 'stop',
      delta: { content },
    }],
    created: 1_788_748_800,
    model: 'scripted-mysql-model',
    object: 'chat.completion.chunk',
  }
}

/** 验证两个连接基于同一版本写入时，行锁只允许一个提交成功。 */
async function assertConcurrentAppend(store: MySqlSessionStore, prefix: string): Promise<void> {
  const scopeId = `${prefix}:concurrency-scope`
  const sessionId = `${prefix}:concurrency`
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
    throw new Error('MySQL 并发契约失败：同一 expectedVersion 必须一成一败')
  const reason = rejected[0]?.reason
  if (!(reason instanceof SessionStoreError) || reason.code !== 'SESSION_VERSION_CONFLICT')
    throw new Error('MySQL 并发契约失败：失败写入必须返回 SESSION_VERSION_CONFLICT')
  if ((await store.read({ scopeId, sessionId })).latestVersion !== 2)
    throw new Error('MySQL 并发契约失败：冲突写入不能推进 Session 版本')
}

async function cleanupScope(store: MySqlSessionStore, scopeId: string): Promise<void> {
  for (;;) {
    const page = await store.list({ scopeId, limit: 100 })
    if (page.sessions.length === 0)
      return
    for (const session of page.sessions)
      await store.remove({ scopeId, sessionId: session.sessionId })
  }
}

main().catch((error: unknown) => {
  console.error('MySqlSessionStore 契约测试失败：', error)
  process.exitCode = 1
})
