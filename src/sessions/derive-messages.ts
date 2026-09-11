import type {
  ModelMessage,
  SessionEvent,
  SessionIdentity,
  SessionSnapshot,
  SessionStore,
} from '../contracts'
import type { HarnessLocale } from '../locale'
import { DEFAULT_LOCALE, diagnostic, resolveLocale } from '../locale'
import { SessionStoreError } from './errors'

/** 读取完整 Session 快照时使用的分页参数。 */
export interface ReadSessionSnapshotOptions {
  /** 快照校验诊断文本的语言；默认 zh-CN。 */
  readonly locale?: HarnessLocale
  /** 内部每页读取数量，默认 100，最大值由 Store 决定。 */
  readonly pageSize?: number
}

/**
 * 从 append-only 事实中确定性推导模型历史。
 *
 * 输入必须是同一 Session 从 sequence=1 开始的连续快照；函数不会重新排序或静默跳过坏序列。
 */
export function deriveModelMessages(
  events: readonly SessionEvent[],
  locale: HarnessLocale = DEFAULT_LOCALE,
): readonly ModelMessage[] {
  if (events.length === 0)
    return Object.freeze([])

  const scopeId = events[0]!.scopeId
  const sessionId = events[0]!.sessionId
  for (const [index, event] of events.entries()) {
    const expectedSequence = index + 1
    if (event.scopeId !== scopeId
      || event.sessionId !== sessionId
      || event.sequence !== expectedSequence) {
      throw new SessionStoreError({
        code: 'SESSION_INVALID_EVENT_SEQUENCE',
        message: diagnostic(locale, `Session 快照必须来自同一 Session 且 sequence 连续；索引 ${index} 期望 ${expectedSequence}`, `Session snapshot must come from one Session with contiguous sequence values; index ${index} expected ${expectedSequence}`),
        sessionId,
      })
    }
  }

  if (events[0]?.type !== 'session.created') {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_EVENT_SEQUENCE',
      message: diagnostic(locale, `Session ${sessionId} 的快照必须以 session.created 开始`, `Session ${sessionId} snapshot must start with session.created`),
      sessionId,
    })
  }

  return Object.freeze(events
    .filter(event => event.type === 'message.appended')
    .map(event => event.message))
}

/** 跨分页读取一个固定版本，避免读取期间的新事件混入历史。 */
export async function readSessionSnapshot(
  identity: SessionIdentity,
  store: SessionStore,
  options: ReadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const locale = resolveLocale(options.locale)
  const pageSize = options.pageSize ?? 100
  let afterSequence = 0
  let snapshotVersion: number | undefined
  let sessionName: string | undefined
  const events: SessionEvent[] = []

  do {
    const page = await store.read({
      ...identity,
      afterSequence,
      limit: pageSize,
      ...(snapshotVersion === undefined ? {} : { throughVersion: snapshotVersion }),
    })
    if (page.scopeId !== identity.scopeId || page.sessionId !== identity.sessionId) {
      throw new SessionStoreError({
        code: 'SESSION_INVALID_EVENT_SEQUENCE',
        message: diagnostic(locale, `Session ${identity.sessionId} 的 Store 返回了其他作用域或 Session`, `Store for Session ${identity.sessionId} returned a different scope or Session`),
        sessionId: identity.sessionId,
      })
    }
    snapshotVersion ??= page.snapshotVersion
    sessionName ??= page.sessionName
    if (sessionName !== undefined
      && page.sessionName !== undefined
      && page.sessionName !== sessionName) {
      throw new SessionStoreError({
        code: 'SESSION_INVALID_EVENT_SEQUENCE',
        message: diagnostic(locale, `Session ${identity.sessionId} 的 Store 分页名称不一致`, `Store pages for Session ${identity.sessionId} returned inconsistent session names`),
        sessionId: identity.sessionId,
      })
    }
    events.push(...page.events)
    if (page.hasMore && page.nextAfterSequence <= afterSequence) {
      throw new SessionStoreError({
        code: 'SESSION_INVALID_EVENT_SEQUENCE',
        message: diagnostic(locale, `Session ${identity.sessionId} 的 Store 分页游标没有前进`, `Store pagination cursor for Session ${identity.sessionId} did not advance`),
        sessionId: identity.sessionId,
      })
    }
    afterSequence = page.nextAfterSequence

    if (!page.hasMore)
      break
  } while (true)

  return Object.freeze({
    ...identity,
    ...(sessionName ? { sessionName } : {}),
    version: snapshotVersion ?? 0,
    events: Object.freeze(events),
  })
}

/** 读取一致快照并直接生成下一次模型请求所需的历史消息。 */
export async function loadModelMessages(
  identity: SessionIdentity,
  store: SessionStore,
  options: ReadSessionSnapshotOptions = {},
): Promise<readonly ModelMessage[]> {
  const snapshot = await readSessionSnapshot(identity, store, options)
  return deriveModelMessages(snapshot.events, resolveLocale(options.locale))
}
