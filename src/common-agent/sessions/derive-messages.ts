import type {
  ModelMessage,
  SessionEvent,
  SessionSnapshot,
  SessionStore,
} from '../contracts'
import { SessionStoreError } from './errors'

/** 读取完整 Session 快照时使用的分页参数。 */
export interface ReadSessionSnapshotOptions {
  /** 内部每页读取数量，默认 100，最大值由 Store 决定。 */
  readonly pageSize?: number
}

/**
 * 从 append-only 事实中确定性推导模型历史。
 *
 * 输入必须是同一 Session 从 sequence=1 开始的连续快照；函数不会重新排序或静默跳过坏序列。
 */
export function deriveModelMessages(events: readonly SessionEvent[]): readonly ModelMessage[] {
  if (events.length === 0)
    return Object.freeze([])

  const sessionId = events[0]!.sessionId
  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1
    if (event.sessionId !== sessionId || event.sequence !== expectedSequence) {
      throw new SessionStoreError({
        code: 'SESSION_INVALID_EVENT_SEQUENCE',
        message: `Session 快照必须来自同一 Session 且 sequence 连续；索引 ${index} 期望 ${expectedSequence}`,
        sessionId,
      })
    }
  }

  if (events[0]?.type !== 'session.created') {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_EVENT_SEQUENCE',
      message: `Session ${sessionId} 的快照必须以 session.created 开始`,
      sessionId,
    })
  }

  return Object.freeze(events
    .filter(event => event.type === 'message.appended')
    .map(event => event.message))
}

/** 跨分页读取一个固定版本，避免读取期间的新事件混入历史。 */
export async function readSessionSnapshot(
  sessionId: string,
  store: SessionStore,
  options: ReadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const pageSize = options.pageSize ?? 100
  let afterSequence = 0
  let snapshotVersion: number | undefined
  const events: SessionEvent[] = []

  do {
    const page = await store.read(sessionId, {
      afterSequence,
      limit: pageSize,
      ...(snapshotVersion === undefined ? {} : { throughVersion: snapshotVersion }),
    })
    snapshotVersion ??= page.snapshotVersion
    events.push(...page.events)
    if (page.hasMore && page.nextAfterSequence <= afterSequence) {
      throw new SessionStoreError({
        code: 'SESSION_INVALID_EVENT_SEQUENCE',
        message: `Session ${sessionId} 的 Store 分页游标没有前进`,
        sessionId,
      })
    }
    afterSequence = page.nextAfterSequence

    if (!page.hasMore)
      break
  } while (true)

  return Object.freeze({
    sessionId,
    version: snapshotVersion ?? 0,
    events: Object.freeze(events),
  })
}

/** 读取一致快照并直接生成下一次模型请求所需的历史消息。 */
export async function loadModelMessages(
  sessionId: string,
  store: SessionStore,
): Promise<readonly ModelMessage[]> {
  const snapshot = await readSessionSnapshot(sessionId, store)
  return deriveModelMessages(snapshot.events)
}
