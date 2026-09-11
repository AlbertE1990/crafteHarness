import type {
  AppendSessionEventsRequest,
  AppendSessionEventsResult,
  ListSessionsOptions,
  ReadSessionEventsRequest,
  SessionCatalogStore,
  SessionEvent,
  SessionEventDraft,
  SessionEventPage,
  SessionListPage,
} from '../contracts'
import type { HarnessLocale } from '../locale'
import { randomUUID } from 'node:crypto'
import { diagnostic, resolveLocale } from '../locale'
import { SessionStoreError } from './errors'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 1_000

/** MemorySessionStore 的确定性测试注入点。 */
export interface MemorySessionStoreOptions {
  /** Store 自身诊断文本的语言；默认 zh-CN。 */
  readonly locale?: HarnessLocale
  readonly now?: () => Date
  readonly createEventId?: () => string
}

/**
 * 进程内 append-only Session Store。
 *
 * 该实现用于开发、测试和协议验证；进程退出后数据会丢失。每次 append 在同步临界区内完成，
 * 并通过 expectedVersion 阻止两个调用方基于同一旧版本同时提交。
 */
export class MemorySessionStore implements SessionCatalogStore {
  private readonly logsByScope = new Map<string, Map<string, SessionEvent[]>>()
  private readonly eventIds = new Set<string>()
  private readonly now: () => Date
  private readonly createEventId: () => string
  private readonly locale: HarnessLocale

  constructor(options: MemorySessionStoreOptions = {}) {
    this.locale = resolveLocale(options.locale)
    this.now = options.now ?? (() => new Date())
    this.createEventId = options.createEventId ?? (() => `event-${randomUUID()}`)
  }

  /** 原子追加一批事实；任一事件无效时整批都不会写入。 */
  async append(request: AppendSessionEventsRequest): Promise<AppendSessionEventsResult> {
    validateIdentifier(request.scopeId, 'scopeId', this.locale)
    validateIdentifier(request.sessionId, 'sessionId', this.locale)
    validateNonNegativeInteger(request.expectedVersion, 'expectedVersion', request.sessionId, this.locale)
    if (!Array.isArray(request.events) || request.events.length === 0) {
      throw invalidArgument(
        request.sessionId,
        diagnostic(this.locale, 'events 至少包含一个 Session Event', 'events must contain at least one Session Event'),
      )
    }
    const scopeLogs = this.logsByScope.get(request.scopeId)
    const currentEvents = scopeLogs?.get(request.sessionId) ?? []
    const currentVersion = currentEvents.length
    if (request.expectedVersion !== currentVersion) {
      throw new SessionStoreError({
        code: 'SESSION_VERSION_CONFLICT',
        message: diagnostic(this.locale, `Session ${request.sessionId} 版本冲突：期望 ${request.expectedVersion}，实际 ${currentVersion}`, `Session ${request.sessionId} version conflict: expected ${request.expectedVersion}, actual ${currentVersion}`),
        sessionId: request.sessionId,
        expectedVersion: request.expectedVersion,
        actualVersion: currentVersion,
      })
    }

    const drafts = request.events.map(event => cloneSerializable(event, request.sessionId, this.locale))
    drafts.forEach(event => validateDraft(event, request.sessionId, this.locale))
    validateInitialization(drafts, currentVersion, request.sessionId, this.locale)

    const batchIds = new Set<string>()
    const appended = drafts.map((draft, index): SessionEvent => {
      const eventId = resolveProducerEventId(draft, this.createEventId, request.sessionId, this.locale)
      if (this.eventIds.has(eventId) || batchIds.has(eventId)) {
        throw new SessionStoreError({
          code: 'SESSION_EVENT_ID_CONFLICT',
          message: diagnostic(this.locale, `Session Event ID 重复：${eventId}`, `Duplicate Session Event ID: ${eventId}`),
          sessionId: request.sessionId,
        })
      }
      batchIds.add(eventId)

      const acceptedAt = this.now()
      if (!Number.isFinite(acceptedAt.getTime())) {
        throw invalidArgument(request.sessionId, diagnostic(this.locale, 'now() 返回了无效日期', 'now() returned an invalid date'))
      }
      const timestamp = draft.timestamp === undefined
        ? acceptedAt.toISOString()
        : resolveProducerTimestamp(draft.timestamp, request.sessionId, this.locale)

      return deepFreeze({
        ...draft,
        eventId,
        scopeId: request.scopeId,
        sessionId: request.sessionId,
        sequence: currentVersion + index + 1,
        timestamp,
      })
    })

    // 只有整批事件都构造成功后才修改内部状态，避免部分写入。
    const nextEvents = [...currentEvents, ...appended]
    const nextScopeLogs = scopeLogs ?? new Map<string, SessionEvent[]>()
    nextScopeLogs.set(request.sessionId, nextEvents)
    if (!scopeLogs)
      this.logsByScope.set(request.scopeId, nextScopeLogs)
    batchIds.forEach(eventId => this.eventIds.add(eventId))

    return deepFreeze({
      scopeId: request.scopeId,
      sessionId: request.sessionId,
      previousVersion: currentVersion,
      version: nextEvents.length,
      events: [...appended],
    })
  }

  /** 按 sequence 分页读取一个固定版本的 Session 快照。 */
  async read(request: ReadSessionEventsRequest): Promise<SessionEventPage> {
    const { scopeId, sessionId } = request
    validateIdentifier(scopeId, 'scopeId', this.locale)
    validateIdentifier(sessionId, 'sessionId', this.locale)
    const afterSequence = request.afterSequence ?? 0
    const limit = request.limit ?? DEFAULT_PAGE_SIZE
    validateNonNegativeInteger(afterSequence, 'afterSequence', sessionId, this.locale)
    validatePositiveInteger(limit, 'limit', sessionId, this.locale)
    if (limit > MAX_PAGE_SIZE)
      throw invalidArgument(sessionId, diagnostic(this.locale, `limit 不能超过 ${MAX_PAGE_SIZE}`, `limit cannot exceed ${MAX_PAGE_SIZE}`))

    const allEvents = this.logsByScope.get(scopeId)?.get(sessionId) ?? []
    const latestVersion = allEvents.length
    const snapshotVersion = request.throughVersion ?? latestVersion
    validateNonNegativeInteger(snapshotVersion, 'throughVersion', sessionId, this.locale)
    if (snapshotVersion > latestVersion) {
      throw invalidArgument(
        sessionId,
        diagnostic(this.locale, `throughVersion ${snapshotVersion} 超过最新版本 ${latestVersion}`, `throughVersion ${snapshotVersion} exceeds latest version ${latestVersion}`),
      )
    }

    const events = allEvents
      .filter(event => event.sequence > afterSequence && event.sequence <= snapshotVersion)
      .slice(0, limit)
    const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence

    return deepFreeze({
      scopeId,
      sessionId,
      ...(allEvents[0]?.type === 'session.created' && allEvents[0].sessionName
        ? { sessionName: allEvents[0].sessionName }
        : {}),
      snapshotVersion,
      latestVersion,
      events: [...events],
      hasMore: nextAfterSequence < snapshotVersion,
      nextAfterSequence,
    })
  }

  /** 按首次写入顺序分页列出已有 Session，不复制完整事件历史。 */
  async list(options: ListSessionsOptions): Promise<SessionListPage> {
    validateIdentifier(options.scopeId, 'scopeId', this.locale)
    const limit = options.limit ?? DEFAULT_PAGE_SIZE
    validatePositiveInteger(limit, 'limit', '', this.locale)
    if (limit > MAX_PAGE_SIZE)
      throw invalidArgument('', diagnostic(this.locale, `limit 不能超过 ${MAX_PAGE_SIZE}`, `limit cannot exceed ${MAX_PAGE_SIZE}`))

    const entries = [...(this.logsByScope.get(options.scopeId)?.entries() ?? [])]
    let startIndex = 0
    if (options.afterSessionId !== undefined) {
      validateIdentifier(options.afterSessionId, 'afterSessionId', this.locale)
      const cursorIndex = entries.findIndex(([sessionId]) => (
        sessionId === options.afterSessionId
      ))
      if (cursorIndex < 0)
        throw invalidArgument('', diagnostic(this.locale, `afterSessionId ${options.afterSessionId} 不存在`, `afterSessionId ${options.afterSessionId} does not exist`))
      startIndex = cursorIndex + 1
    }

    const search = normalizeSearch(options.search, this.locale)
    const matching = entries.slice(startIndex).filter(([, events]) => {
      if (!search)
        return true
      const created = events[0]
      return created?.type === 'session.created'
        && created.sessionName?.toLowerCase().includes(search)
    })
    const selected = matching.slice(0, limit)
    const sessions = selected.map(([sessionId, events]) => {
      const created = events[0]
      if (!created || created.type !== 'session.created')
        throw invalidArgument(sessionId, diagnostic(this.locale, 'Session 日志缺少 session.created', 'Session log is missing session.created'))
      return deepFreeze({
        scopeId: options.scopeId,
        sessionId,
        ...(created.sessionName ? { sessionName: created.sessionName } : {}),
        createdAt: created.timestamp,
        version: events.length,
        ...(created.metadata ? { metadata: created.metadata } : {}),
      })
    })
    const nextAfterSessionId = sessions.at(-1)?.sessionId

    return deepFreeze({
      sessions,
      hasMore: selected.length < matching.length,
      ...(nextAfterSessionId ? { nextAfterSessionId } : {}),
    })
  }
}

/** 新 Session 必须以 session.created 开始，已有 Session 不能再次创建。 */
function validateInitialization(
  events: readonly SessionEventDraft[],
  currentVersion: number,
  sessionId: string,
  locale: HarnessLocale,
): void {
  if (currentVersion === 0 && events[0]?.type !== 'session.created') {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_EVENT_SEQUENCE',
      message: diagnostic(locale, `Session ${sessionId} 的第一个事件必须是 session.created`, `The first event for Session ${sessionId} must be session.created`),
      sessionId,
    })
  }

  const createdCount = events.filter(event => event.type === 'session.created').length
  const expectedCreatedCount = currentVersion === 0 ? 1 : 0
  if (createdCount !== expectedCreatedCount) {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_EVENT_SEQUENCE',
      message: diagnostic(locale, `Session ${sessionId} 只能在 sequence=1 写入一次 session.created`, `Session ${sessionId} must contain exactly one session.created event at sequence=1`),
      sessionId,
    })
  }
}

/** 验证判别字段和可选关联 ID，避免普通 JavaScript 绕过 TypeScript 后写入坏事件。 */
function validateDraft(event: SessionEventDraft, sessionId: string, locale: HarnessLocale): void {
  if (typeof event !== 'object' || event === null || Array.isArray(event))
    throw invalidArgument(sessionId, diagnostic(locale, 'Session Event 必须是对象', 'Session Event must be an object'))

  if ('runId' in event && event.runId !== undefined)
    validateIdentifier(event.runId, 'runId', locale)
  if ('turnId' in event && event.turnId !== undefined)
    validateIdentifier(event.turnId, 'turnId', locale)
  if (event.type === 'session.created' && event.sessionName !== undefined)
    validateIdentifier(event.sessionName, 'sessionName', locale)

  if (!['session.created', 'message.appended', 'turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type))
    throw invalidArgument(sessionId, diagnostic(locale, '不支持的 Session Event type', 'Unsupported Session Event type'))
}

/** 将可选名称搜索归一化为大小写不敏感的非空子串。 */
function normalizeSearch(value: string | undefined, locale: HarnessLocale): string | undefined {
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || !value.trim())
    throw invalidArgument('', diagnostic(locale, 'search 必须是非空字符串', 'search must be a non-empty string'))
  return value.trim().toLowerCase()
}

/** 通过 JSON 往返复制并拒绝循环引用、BigInt、函数及非有限数字。 */
function cloneSerializable<T>(value: T, sessionId: string, locale: HarnessLocale): T {
  try {
    const json = JSON.stringify(value, (_key, child) => {
      if (typeof child === 'number' && !Number.isFinite(child))
        throw new TypeError(diagnostic(locale, 'Session Event 不能包含非有限数字', 'Session Event cannot contain non-finite numbers'))
      if (typeof child === 'bigint' || typeof child === 'function' || typeof child === 'symbol')
        throw new TypeError(diagnostic(locale, `Session Event 不能包含 ${typeof child}`, `Session Event cannot contain ${typeof child}`))
      return child
    })
    if (json === undefined)
      throw new TypeError(diagnostic(locale, 'Session Event 无法序列化为 JSON', 'Session Event cannot be serialized as JSON'))
    return JSON.parse(json) as T
  }
  catch (error) {
    throw new SessionStoreError({
      code: 'SESSION_SERIALIZATION_FAILED',
      message: diagnostic(locale, `Session ${sessionId} 的事件无法安全序列化`, `Events for Session ${sessionId} cannot be safely serialized`),
      sessionId,
      cause: error,
    })
  }
}

/** 事件身份与发生时刻由产生方写入；缺省时由 Store 兜底生成。 */
function resolveProducerEventId(
  draft: SessionEventDraft,
  fallback: () => string,
  sessionId: string,
  locale: HarnessLocale,
): string {
  if (draft.eventId === undefined)
    return fallback().trim()
  if (typeof draft.eventId !== 'string' || !draft.eventId.trim())
    throw invalidArgument(sessionId, diagnostic(locale, '事件 eventId 必须是非空字符串', 'Event eventId must be a non-empty string'))
  return draft.eventId.trim()
}

function resolveProducerTimestamp(value: string, sessionId: string, locale: HarnessLocale): string {
  if (typeof value !== 'string' || !value)
    throw invalidArgument(sessionId, diagnostic(locale, '事件 timestamp 必须是非空字符串', 'Event timestamp must be a non-empty string'))
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()))
    throw invalidArgument(sessionId, diagnostic(locale, '事件 timestamp 必须是可解析的时间', 'Event timestamp must be a parseable date-time'))
  return date.toISOString()
}

/** 深度冻结内存 Store 的输入副本和返回快照，阻止调用方篡改已追加事实。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value

  for (const child of Object.values(value))
    deepFreeze(child)
  return Object.freeze(value)
}

/** 验证协议中的非空字符串身份字段。 */
function validateIdentifier(value: string, field: string, locale: HarnessLocale): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_ARGUMENT',
      message: diagnostic(locale, `${field} 必须是非空字符串`, `${field} must be a non-empty string`),
    })
  }
}

/** 验证 sequence/version 一类从零开始的整数。 */
function validateNonNegativeInteger(
  value: number,
  field: string,
  sessionId: string,
  locale: HarnessLocale,
): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw invalidArgument(sessionId, diagnostic(locale, `${field} 必须是非负安全整数`, `${field} must be a non-negative safe integer`))
}

/** 验证分页大小等正整数。 */
function validatePositiveInteger(value: number, field: string, sessionId: string, locale: HarnessLocale): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw invalidArgument(sessionId, diagnostic(locale, `${field} 必须是正安全整数`, `${field} must be a positive safe integer`))
}

/** 构造包含 Session 关联信息的参数错误。 */
function invalidArgument(sessionId: string, message: string): SessionStoreError {
  return new SessionStoreError({
    code: 'SESSION_INVALID_ARGUMENT',
    message,
    sessionId,
  })
}
