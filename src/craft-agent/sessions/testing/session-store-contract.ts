import type {
  SessionCatalogStore,
  SessionEvent,
  SessionEventPage,
  SessionStore,
} from '../../contracts'
import { randomUUID } from 'node:crypto'
import { SessionStoreError } from '../errors'

/** SessionStore 契约探针的隔离 ID 和可选目录要求。 */
export interface SessionStoreContractOptions {
  /** 探针写入的 Session ID 前缀；默认生成随机前缀。 */
  readonly sessionIdPrefix?: string
  /** 为 true 时，没有实现 list() 也视为契约失败。 */
  readonly requireCatalog?: boolean
}

/** 契约探针成功后返回的写入标识，便于测试夹具清理隔离数据。 */
export interface SessionStoreContractResult {
  readonly sessionIds: readonly string[]
  readonly catalogChecked: boolean
}

/**
 * 对一个全新、隔离的 SessionStore 执行可复用协议探针。
 *
 * 探针会写入数据且 Session Log 没有删除协议；数据库或远程实现必须使用临时 schema、事务夹具或独立命名空间。
 * 本函数不依赖 Vitest/Jest，任何测试框架都可以直接调用。
 */
export async function assertSessionStoreContract(
  store: SessionStore,
  options: SessionStoreContractOptions = {},
): Promise<SessionStoreContractResult> {
  assertStoreShape(store)
  const prefix = normalizePrefix(options.sessionIdPrefix)
  const sessionIds = Object.freeze([
    `${prefix}:primary`,
    `${prefix}:secondary`,
    `${prefix}:invalid-batch`,
    `${prefix}:serialization`,
  ])
  const [primaryId, secondaryId, invalidBatchId, serializationId] = sessionIds

  const empty = await store.read(primaryId)
  assertEmptyPage(empty, primaryId)

  await assertStoreError(async () => {
    await store.append({
      sessionId: invalidBatchId,
      expectedVersion: 0,
      events: [{ type: 'session.created' }, { type: 'session.created' }],
    })
  }, 'SESSION_INVALID_EVENT_SEQUENCE')
  assertEmptyPage(await store.read(invalidBatchId), invalidBatchId)

  const circular: Record<string, unknown> = {}
  circular.self = circular
  await assertStoreError(async () => {
    await store.append({
      sessionId: serializationId,
      expectedVersion: 0,
      events: [{ type: 'session.created', metadata: circular as never }],
    })
  }, 'SESSION_SERIALIZATION_FAILED')
  assertEmptyPage(await store.read(serializationId), serializationId)

  const metadata = { source: 'before' }
  const created = await store.append({
    sessionId: primaryId,
    expectedVersion: 0,
    events: [
      { type: 'session.created', metadata },
      {
        type: 'message.appended',
        turnId: 'contract-turn',
        message: { role: 'user', content: 'contract message' },
      },
    ],
  })
  metadata.source = 'after'
  assert(created.sessionId === primaryId, 'append result.sessionId 不匹配')
  assert(created.previousVersion === 0, '首次 append.previousVersion 必须为 0')
  assert(created.version === 2, '首次批量追加后的 version 必须为 2')
  assert(created.events.length === 2, 'append 必须返回本批次的全部事件')

  const eventIds = new Set<string>()
  assertEventEnvelopes(created.events, primaryId, 1, eventIds)
  const persisted = await store.read(primaryId)
  assert(persisted.events[0]?.type === 'session.created', '首个持久事件必须是 session.created')
  if (persisted.events[0]?.type === 'session.created') {
    assert(
      persisted.events[0].metadata?.source === 'before',
      'Store 不得保留可被调用方改写的事件对象引用',
    )
  }

  await assertStoreError(async () => {
    await store.append({
      sessionId: primaryId,
      expectedVersion: 0,
      events: [{
        type: 'message.appended',
        message: { role: 'assistant', content: 'stale write' },
      }],
    })
  }, 'SESSION_VERSION_CONFLICT', { expectedVersion: 0, actualVersion: 2 })
  assert((await store.read(primaryId)).latestVersion === 2, '版本冲突不能产生部分写入')

  const firstPage = await store.read(primaryId, { afterSequence: 0, limit: 1 })
  assert(firstPage.snapshotVersion === 2, '第一页必须固定当前 snapshotVersion')
  assert(firstPage.hasMore, '固定快照还有事件时 hasMore 必须为 true')
  assert(firstPage.nextAfterSequence === 1, '分页游标必须推进到最后返回的 sequence')

  const appendedLater = await store.append({
    sessionId: primaryId,
    expectedVersion: 2,
    events: [{
      type: 'message.appended',
      turnId: 'contract-turn',
      message: { role: 'assistant', content: 'later message' },
    }],
  })
  assertEventEnvelopes(appendedLater.events, primaryId, 3, eventIds)

  const secondPage = await store.read(primaryId, {
    afterSequence: firstPage.nextAfterSequence,
    limit: 1,
    throughVersion: firstPage.snapshotVersion,
  })
  assert(secondPage.snapshotVersion === 2, '后续页必须保持第一页的 snapshotVersion')
  assert(secondPage.latestVersion === 3, 'latestVersion 必须反映读取时的最新版本')
  assert(secondPage.events.length === 1 && secondPage.events[0]?.sequence === 2, '固定快照不能混入读取期间追加的事件')
  assert(!secondPage.hasMore, '读完固定快照后 hasMore 必须为 false')

  const secondary = await store.append({
    sessionId: secondaryId,
    expectedVersion: 0,
    events: [{ type: 'session.created', metadata: { source: 'secondary' } }],
  })
  assertEventEnvelopes(secondary.events, secondaryId, 1, eventIds)

  const catalogChecked = await assertCatalogContract(
    store,
    primaryId,
    secondaryId,
    options.requireCatalog ?? false,
  )

  return Object.freeze({ sessionIds, catalogChecked })
}

/** 检查可选 list() 能力的稳定创建顺序、版本和游标语义。 */
async function assertCatalogContract(
  store: SessionStore,
  primaryId: string,
  secondaryId: string,
  required: boolean,
): Promise<boolean> {
  if (!isSessionCatalogStore(store)) {
    assert(!required, 'SessionStore 必须实现 list() 目录能力')
    return false
  }

  const first = await store.list({ limit: 1 })
  assert(first.sessions.length === 1, 'list(limit=1) 必须只返回一个 Session')
  assert(first.sessions[0]?.sessionId === primaryId, 'list() 必须按 Session 首次创建顺序返回')
  assert(first.sessions[0]?.version === 3, 'SessionSummary.version 必须反映最新事件版本')
  assert(first.hasMore, '目录仍有 Session 时 hasMore 必须为 true')
  assert(first.nextAfterSessionId === primaryId, '目录游标必须指向本页最后一个 Session')

  const second = await store.list({ limit: 1, afterSessionId: primaryId })
  assert(second.sessions.length === 1 && second.sessions[0]?.sessionId === secondaryId, '目录下一页必须从 afterSessionId 之后继续')
  assert(!second.hasMore, '读完目录后 hasMore 必须为 false')
  return true
}

/** 识别接受探针的 Store 是否额外实现了会话目录协议。 */
function isSessionCatalogStore(store: SessionStore): store is SessionCatalogStore {
  return 'list' in store && typeof store.list === 'function'
}

/** 验证不存在 Session 的统一零版本返回。 */
function assertEmptyPage(page: SessionEventPage, sessionId: string): void {
  assert(page.sessionId === sessionId, '空页 sessionId 不匹配')
  assert(page.snapshotVersion === 0, '不存在的 Session snapshotVersion 必须为 0')
  assert(page.latestVersion === 0, '不存在的 Session latestVersion 必须为 0')
  assert(page.events.length === 0, '不存在的 Session 不得返回事件')
  assert(!page.hasMore, '不存在的 Session hasMore 必须为 false')
  assert(page.nextAfterSequence === 0, '不存在的 Session 游标必须为 0')
}

/** 验证 Store 分配的身份、连续 sequence、时间和全局唯一事件 ID。 */
function assertEventEnvelopes(
  events: readonly SessionEvent[],
  sessionId: string,
  firstSequence: number,
  eventIds: Set<string>,
): void {
  for (const [index, event] of events.entries()) {
    assert(event.sessionId === sessionId, '持久事件 sessionId 不匹配')
    assert(event.sequence === firstSequence + index, '持久事件 sequence 必须连续且无空洞')
    assert(Boolean(event.eventId.trim()), 'eventId 必须是非空字符串')
    assert(!eventIds.has(event.eventId), `eventId 必须在 Store 中唯一：${event.eventId}`)
    eventIds.add(event.eventId)
    assert(!Number.isNaN(Date.parse(event.timestamp)), 'timestamp 必须是有效 ISO 8601 时间')
  }
}

/** 断言一次操作以指定的稳定 SessionStoreError 失败。 */
async function assertStoreError(
  operation: () => Promise<void>,
  code: SessionStoreError['code'],
  versions: { readonly expectedVersion?: number, readonly actualVersion?: number } = {},
): Promise<void> {
  try {
    await operation()
  }
  catch (error) {
    assert(error instanceof SessionStoreError, `Store 必须抛出 SessionStoreError，而不是 ${String(error)}`)
    assert(error.code === code, `Store 错误码应为 ${code}，实际为 ${error.code}`)
    if (versions.expectedVersion !== undefined)
      assert(error.expectedVersion === versions.expectedVersion, '版本冲突必须返回 expectedVersion')
    if (versions.actualVersion !== undefined)
      assert(error.actualVersion === versions.actualVersion, '版本冲突必须返回 actualVersion')
    return
  }
  throw new Error(`Store 操作应以 ${code} 失败，但实际成功`)
}

/** 验证契约探针只接受最小 SessionStore 行为。 */
function assertStoreShape(store: SessionStore): void {
  assert(typeof store === 'object' && store !== null, 'SessionStore 必须是对象')
  assert(typeof store.append === 'function', 'SessionStore 必须实现 append()')
  assert(typeof store.read === 'function', 'SessionStore 必须实现 read()')
}

/** 生成不会与并行契约探针冲突的 Session ID 前缀。 */
function normalizePrefix(value: string | undefined): string {
  const prefix = value?.trim() || `session-store-contract-${randomUUID()}`
  assert(Boolean(prefix), 'sessionIdPrefix 必须是非空字符串')
  return prefix
}

/** 不依赖测试框架的最小断言。 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition)
    throw new Error(`SessionStore 契约失败：${message}`)
}
