/**
 * Sessions 学习型可执行测试。
 *
 * 运行方式：pnpm tsx test/learning/session-log.example.ts
 *
 * 这个文件刻意不使用 Vitest：它是一段可以逐行阅读、直接运行的示例，
 * 通过断言保证结果正确，并通过日志展示 Session 的作用、意义和数据流。
 */
/* eslint-disable no-console -- 本学习脚本需要通过分阶段日志展示 Session 数据流。 */
import type {
  AppendSessionEventsResult,
  ModelMessage,
  SessionEvent,
  SessionEventDraft,
} from '../../src/contracts'
import assert from 'node:assert/strict'
import process from 'node:process'
import {
  deriveModelMessages,
  loadModelMessages,
  MemorySessionStore,
  readSessionSnapshot,
  SessionStoreError,
} from '../../src/sessions'

const SESSION_ID = 'learning-session-001'
const SCOPE_ID = 'learning-scope'
const RUN_ID = 'learning-run-001'

/** 测试数据：业务代码先产生不带 eventId、sequence、timestamp 的事件草稿。 */
const firstTurnDrafts = [
  {
    type: 'session.created',
    metadata: { purpose: '学习 Session 数据流', userId: 'student-001' },
  },
  {
    type: 'message.appended',
    message: { role: 'system', content: '你是一名耐心的 TypeScript 老师。' },
  },
  {
    type: 'turn.started',
    runId: RUN_ID,
    turnId: 'turn-001',
  },
  {
    type: 'message.appended',
    runId: RUN_ID,
    turnId: 'turn-001',
    message: { role: 'user', content: 'Session 有什么作用？' },
  },
  {
    type: 'message.appended',
    runId: RUN_ID,
    turnId: 'turn-001',
    message: {
      role: 'assistant',
      content: 'Session 用追加式事件日志保存对话事实，并可据此重建模型上下文。',
    },
  },
  {
    type: 'turn.completed',
    runId: RUN_ID,
    turnId: 'turn-001',
  },
] satisfies readonly SessionEventDraft[]

/** 测试数据：同一个 Session 的第二轮对话不再写 session.created。 */
const secondTurnDrafts = [
  {
    type: 'turn.started',
    runId: RUN_ID,
    turnId: 'turn-002',
  },
  {
    type: 'message.appended',
    runId: RUN_ID,
    turnId: 'turn-002',
    message: { role: 'user', content: '下一次请求如何恢复上下文？' },
  },
  {
    type: 'message.appended',
    runId: RUN_ID,
    turnId: 'turn-002',
    message: {
      role: 'assistant',
      content: '读取一致快照，再筛出 message.appended 事件即可。',
    },
  },
  {
    type: 'turn.completed',
    runId: RUN_ID,
    turnId: 'turn-002',
  },
] satisfies readonly SessionEventDraft[]

/** 创建可重复的 Store，让每次运行得到相同的 ID 和时间，便于观察日志。 */
function createDeterministicStore(): MemorySessionStore {
  let eventNumber = 0
  let timeOffset = 0
  const baseTime = Date.parse('2026-09-08T02:00:00.000Z')

  return new MemorySessionStore({
    createEventId: () => `demo-event-${++eventNumber}`,
    now: () => new Date(baseTime + timeOffset++ * 1_000),
  })
}

/** 打印事件日志；生命周期事件和模型消息在这里可以清楚地区分。 */
function printEvents(events: readonly SessionEvent[]): void {
  console.table(events.map(event => ({
    sequence: event.sequence,
    eventId: event.eventId,
    type: event.type,
    turnId: 'turnId' in event ? (event.turnId ?? '-') : '-',
    role: event.type === 'message.appended' ? event.message.role : '-',
    content: event.type === 'message.appended' ? event.message.content : '-',
    timestamp: event.timestamp,
  })))
}

/** 打印真正会发送给模型的消息数组。 */
function printModelMessages(messages: readonly ModelMessage[]): void {
  console.table(messages.map((message, index) => ({
    index,
    role: message.role,
    content: 'content' in message ? message.content : '-',
  })))
}

/** 测试一：事件草稿经过 Store 后成为有序、不可变、可追踪的事实。 */
async function testAppendOnlyEventLog(store: MemorySessionStore): Promise<number> {
  console.log('\n========== 测试 1：写入追加式 Session Event Log ==========')
  console.log('输入：第一轮事件草稿（尚无 eventId / sequence / timestamp）')
  console.dir(firstTurnDrafts, { depth: null })

  const result = await store.append({
    scopeId: SCOPE_ID,
    sessionId: SESSION_ID,
    expectedVersion: 0,
    events: firstTurnDrafts,
  })

  console.log('\n输出：Store 为事件补齐持久化信封，并把版本从 0 推进到 6')
  printAppendResult(result)

  assert.equal(result.previousVersion, 0)
  assert.equal(result.version, 6)
  assert.deepEqual(result.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6])
  assert.ok(result.events.every(event => Object.isFrozen(event)))
  console.log('✅ 断言通过：事件严格有序，且 Store 返回的历史事实不可被篡改。')
  return result.version
}

/** 测试二：使用上一版本继续写入，展示一个 Session 如何跨 Turn 延续。 */
async function testContinueConversation(
  store: MemorySessionStore,
  expectedVersion: number,
): Promise<number> {
  console.log('\n========== 测试 2：在同一 Session 中继续第二轮对话 ==========')
  console.log(`输入：expectedVersion=${expectedVersion}，追加第二轮事件（不重复创建 Session）`)

  const result = await store.append({
    scopeId: SCOPE_ID,
    sessionId: SESSION_ID,
    expectedVersion,
    events: secondTurnDrafts,
  })

  printAppendResult(result)
  assert.equal(result.previousVersion, 6)
  assert.equal(result.version, 10)
  assert.deepEqual(result.events.map(event => event.sequence), [7, 8, 9, 10])
  console.log('✅ 断言通过：第二轮沿用旧历史，Session 版本推进到 10。')
  return result.version
}

/** 测试三：分页读取完整快照，并由事实确定性推导模型上下文。 */
async function testReadAndDeriveMessages(store: MemorySessionStore): Promise<void> {
  console.log('\n========== 测试 3：Event Log → Snapshot → Model Messages ==========')
  console.log('观察分页协议：')
  const firstPage = await store.read({
    scopeId: SCOPE_ID,
    sessionId: SESSION_ID,
    limit: 3,
    // afterSequence: 3, limit: 4,
    // throughVersion: 8,
  })
  console.dir(firstPage, { depth: null })
  console.log('--------------------------------------------')
  console.log({
    snapshotVersion: firstPage.snapshotVersion,
    latestVersion: firstPage.latestVersion,
    hasMore: firstPage.hasMore,
    nextAfterSequence: firstPage.nextAfterSequence,
  })
  printEvents(firstPage.events)

  console.log('\nreadSessionSnapshot 会自动翻页，并始终固定在首次看到的版本：')
  const snapshot = await readSessionSnapshot({ scopeId: SCOPE_ID, sessionId: SESSION_ID }, store, { pageSize: 3 })
  console.log(`snapshot.version=${snapshot.version}, events.length=${snapshot.events.length}`)
  printEvents(snapshot.events)

  console.log('\nderiveModelMessages 只保留 message.appended；Turn 生命周期事件不会发给模型：')
  const messages = deriveModelMessages(snapshot.events)
  printModelMessages(messages)

  const messagesLoadedByShortcut = await loadModelMessages(SESSION_ID, store)
  assert.deepEqual(messagesLoadedByShortcut, messages)
  assert.deepEqual(messages.map(message => message.role), [
    'system',
    'user',
    'assistant',
    'user',
    'assistant',
  ])
  assert.equal(snapshot.version, 10)
  console.log('✅ 断言通过：loadModelMessages 等于“读取快照 + 推导消息”。')
}

/** 测试四：旧版本写入会失败，避免并发调用方静默覆盖彼此的数据。 */
async function testOptimisticConcurrency(
  store: MemorySessionStore,
  actualVersion: number,
): Promise<void> {
  console.log('\n========== 测试 4：expectedVersion 乐观并发保护 ==========')
  console.log(`当前版本是 ${actualVersion}，故意使用过期版本 6 追加消息。`)

  try {
    await store.append({
      scopeId: SCOPE_ID,
      sessionId: SESSION_ID,
      expectedVersion: 6,
      events: [{
        type: 'message.appended',
        message: { role: 'user', content: '这条消息不应该被写入。' },
      }],
    })
    assert.fail('预期发生 SESSION_VERSION_CONFLICT，但写入却成功了')
  }
  catch (error) {
    assert.ok(error instanceof SessionStoreError)
    assert.equal(error.code, 'SESSION_VERSION_CONFLICT')
    assert.equal(error.expectedVersion, 6)
    assert.equal(error.actualVersion, actualVersion)
    console.log('捕获到预期错误：', {
      name: error.name,
      code: error.code,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
      message: error.message,
    })
  }

  const pageAfterFailure = await store.read({ scopeId: SCOPE_ID, sessionId: SESSION_ID })
  assert.equal(pageAfterFailure.latestVersion, actualVersion)
  console.log('✅ 断言通过：冲突批次完全没有写入，Session 仍保持原版本。')
}

function printAppendResult(result: AppendSessionEventsResult): void {
  console.log({
    sessionId: result.sessionId,
    previousVersion: result.previousVersion,
    version: result.version,
  })
  printEvents(result.events)
}

async function main(): Promise<void> {
  console.log('Sessions 的核心意义：用唯一的 append-only Event Log 保存事实，')
  console.log('既能审计 Turn 状态，又能随时重建下一次模型调用所需的消息历史。')
  console.log('\n数据流：事件草稿 → store.append → Session Event Log')
  console.log('                     ↓ store.read / readSessionSnapshot')
  console.log('                  一致快照 → deriveModelMessages → 模型上下文')

  const store = createDeterministicStore()
  const firstTurnVersion = await testAppendOnlyEventLog(store)
  const latestVersion = await testContinueConversation(store, firstTurnVersion)
  await testReadAndDeriveMessages(store)
  await testOptimisticConcurrency(store, latestVersion)

  console.log('\n🎉 所有 Sessions 学习测试均已通过。')
}

main().catch((error: unknown) => {
  console.error('\n❌ Sessions 学习测试失败：', error)
  process.exitCode = 1
})
