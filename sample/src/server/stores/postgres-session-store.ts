import type { Pool, PoolClient } from 'pg'
import type {
  AppendSessionEventsRequest,
  AppendSessionEventsResult,
  JsonObject,
  JsonValue,
  ListSessionsOptions,
  ModelMessage,
  ReadSessionEventsRequest,
  SessionCatalogStore,
  SessionEvent,
  SessionEventDraft,
  SessionEventPage,
  SessionFailureInfo,
  SessionIdentity,
  SessionListPage,
  SessionStoreOperation,
  SessionSummary,
} from '../../../../src'
import { randomUUID } from 'node:crypto'
import { SessionStoreError } from '../../../../src'

const DEFAULT_PAGE_SIZE = 100
const MAX_PAGE_SIZE = 1_000

/**
 * 会话目录上的可变操作；库的 `SessionStore` 契约刻意不包含它们。
 *
 * 名称是**可变的展示属性**：`session.created` 事件保留创建时的原始名称作为不可变事实，
 * 而目录表的 `session_name` 是它的当前投影，因此 read/list 都以目录为准。
 * 删除则会真正移除事实（事件行 + 目录行），属于案例产品需求，不是 append-only 协议的
 * 一部分——库不支持删除正是为了让这个取舍停留在应用层。
 */
export interface SessionCatalogMutations {
  /** 重命名会话；成功返回更新后的摘要，会话不存在时返回 undefined。 */
  rename: (identity: SessionIdentity, name: string) => Promise<SessionSummary | undefined>
  /** 删除会话及其全部事件；返回 false 表示会话不存在。 */
  remove: (identity: SessionIdentity) => Promise<boolean>
}

/** PostgreSQL bigint 默认以字符串返回；本类型明确记录数据库边界。 */
interface SessionVersionRow {
  readonly version: string | number
  readonly session_name?: string | null
}

/** 从事件表读取的原始行；payload 会在应用边界恢复为判别联合。 */
interface SessionEventRow {
  readonly scope_id: string
  readonly session_id: string
  readonly sequence: string | number
  readonly event_id: string
  readonly event_type: string
  readonly run_id: string | null
  readonly turn_id: string | null
  readonly payload_json: unknown
  readonly created_at: Date | string
}

/** 从会话目录表读取的最小行，不包含事件历史。 */
interface SessionSummaryRow extends SessionVersionRow {
  readonly scope_id: string
  readonly session_id: string
  readonly metadata_json: unknown | null
  readonly created_at: Date | string
}

/** node-postgres 暴露的可识别数据库错误字段。 */
interface PostgresErrorLike {
  readonly code?: unknown
  readonly constraint?: unknown
}

/**
 * 使用 PostgreSQL 实现的生产级 append-only Session Store。
 *
 * 本实现不维护进程内会话副本：append/read/list 都直接访问数据库。事务和行锁只负责
 * 单次写入期间的并发一致性，连接释放后不会在应用内缓存对话历史。
 */
export class PostgresSessionStore implements SessionCatalogStore, SessionCatalogMutations {
  constructor(readonly pool: Pool) {}

  /**
   * 原子追加一批 Session Event。
   *
   * `SELECT ... FOR UPDATE` 会串行化同一 Session 的写入；版本不一致或任一 INSERT 失败时，
   * ROLLBACK 保证整批事件和 Session 版本都不发生变化。
   */
  async append(
    request: AppendSessionEventsRequest,
  ): Promise<AppendSessionEventsResult> {
    validateIdentifier(request.scopeId, 'scopeId')
    validateIdentifier(request.sessionId, 'sessionId')
    validateNonNegativeInteger(request.expectedVersion, 'expectedVersion', request.sessionId)
    if (!Array.isArray(request.events) || request.events.length === 0)
      throw invalidArgument(request.sessionId, 'events 至少包含一个 Session Event')

    const drafts = request.events.map(event => cloneSerializable(event, request.sessionId))
    drafts.forEach(event => validateDraft(event, request.sessionId))
    const eventIds = drafts.map(draft => resolveProducerEventId(draft, randomUUID, request.sessionId))
    const timestamps = drafts.map(draft => resolveEventTimestamp(draft, request.sessionId))
    const sessionCreated = drafts.find(event => event.type === 'session.created')
    const metadata = sessionCreated?.type === 'session.created'
      ? (sessionCreated.metadata ?? null)
      : null
    const sessionName = sessionCreated?.type === 'session.created'
      ? (sessionCreated.sessionName ?? null)
      : null
    const client = await connectForAppend(this.pool, request.sessionId)

    try {
      await client.query('BEGIN')

      // 先尝试建立零版本目录行；若会话已存在，ON CONFLICT 不会覆盖原数据。
      await client.query(`
        INSERT INTO craft_agent_sessions (
          scope_id,
          session_id,
          session_name,
          version,
          metadata_json,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 0, $4::jsonb, $5::timestamptz, $5::timestamptz)
        ON CONFLICT (scope_id, session_id) DO NOTHING
      `, [request.scopeId, request.sessionId, sessionName, serializeJson(metadata), timestamps[0]])

      const versionResult = await client.query<SessionVersionRow>(`
        SELECT version
        FROM craft_agent_sessions
        WHERE scope_id = $1 AND session_id = $2
        FOR UPDATE
      `, [request.scopeId, request.sessionId])
      const versionRow = versionResult.rows[0]
      if (!versionRow)
        throw operationFailed('append', request.sessionId, '创建或锁定 Session 失败')

      const currentVersion = parseDatabaseInteger(
        versionRow.version,
        'version',
        request.sessionId,
        'append',
      )
      if (request.expectedVersion !== currentVersion) {
        throw new SessionStoreError({
          code: 'SESSION_VERSION_CONFLICT',
          message: `Session ${request.sessionId} 版本冲突：期望 ${request.expectedVersion}，实际 ${currentVersion}`,
          sessionId: request.sessionId,
          expectedVersion: request.expectedVersion,
          actualVersion: currentVersion,
          operation: 'append',
        })
      }
      validateInitialization(drafts, currentVersion, request.sessionId)

      const appended: SessionEvent[] = []
      for (const [index, draft] of drafts.entries()) {
        const sequence = currentVersion + index + 1
        const event = createPersistedEvent(
          draft,
          request.scopeId,
          request.sessionId,
          eventIds[index]!,
          sequence,
          timestamps[index]!,
        )
        await insertEvent(client, event)
        appended.push(event)
      }

      const nextVersion = currentVersion + appended.length
      await client.query(`
        UPDATE craft_agent_sessions
        SET version = $3, updated_at = $4::timestamptz
        WHERE scope_id = $1 AND session_id = $2
      `, [request.scopeId, request.sessionId, nextVersion, timestamps.at(-1)])
      await client.query('COMMIT')

      return deepFreeze({
        scopeId: request.scopeId,
        sessionId: request.sessionId,
        previousVersion: currentVersion,
        version: nextVersion,
        events: appended,
      })
    }
    catch (error) {
      await safelyRollback(client)
      if (error instanceof SessionStoreError)
        throw error
      if (isUniqueViolation(error)) {
        throw new SessionStoreError({
          code: 'SESSION_EVENT_ID_CONFLICT',
          message: `Session ${request.sessionId} 写入了重复的事件 ID`,
          sessionId: request.sessionId,
          operation: 'append',
          cause: error,
        })
      }
      throw operationFailed('append', request.sessionId, 'PostgreSQL 追加 Session Event 失败', error)
    }
    finally {
      client.release()
    }
  }

  /** 按 sequence 读取固定版本的事件页；每次调用都以数据库为事实源。 */
  async read(request: ReadSessionEventsRequest): Promise<SessionEventPage> {
    const { scopeId, sessionId } = request
    validateIdentifier(scopeId, 'scopeId')
    validateIdentifier(sessionId, 'sessionId')
    const afterSequence = request.afterSequence ?? 0
    const limit = request.limit ?? DEFAULT_PAGE_SIZE
    validateNonNegativeInteger(afterSequence, 'afterSequence', sessionId)
    validatePageSize(limit, sessionId)

    try {
      const versionResult = await this.pool.query<SessionVersionRow>(`
        SELECT version, session_name
        FROM craft_agent_sessions
        WHERE scope_id = $1 AND session_id = $2
      `, [scopeId, sessionId])
      const sessionRow = versionResult.rows[0]
      const latestVersion = sessionRow
        ? parseDatabaseInteger(sessionRow.version, 'version', sessionId)
        : 0
      const snapshotVersion = request.throughVersion ?? latestVersion
      validateNonNegativeInteger(snapshotVersion, 'throughVersion', sessionId)
      if (snapshotVersion > latestVersion) {
        throw invalidArgument(
          sessionId,
          `throughVersion ${snapshotVersion} 超过最新版本 ${latestVersion}`,
        )
      }

      const eventResult = await this.pool.query<SessionEventRow>(`
        SELECT
          scope_id,
          session_id,
          sequence,
          event_id,
          event_type,
          run_id,
          turn_id,
          payload_json,
          created_at
        FROM craft_agent_session_events
        WHERE scope_id = $1
          AND session_id = $2
          AND sequence > $3
          AND sequence <= $4
        ORDER BY sequence ASC
        LIMIT $5
      `, [scopeId, sessionId, afterSequence, snapshotVersion, limit])
      const events = eventResult.rows.map(row => restoreEvent(row, scopeId, sessionId))
      const nextAfterSequence = events.at(-1)?.sequence ?? afterSequence

      return deepFreeze({
        scopeId,
        sessionId,
        ...(sessionRow?.session_name ? { sessionName: sessionRow.session_name } : {}),
        snapshotVersion,
        latestVersion,
        events,
        hasMore: nextAfterSequence < snapshotVersion,
        nextAfterSequence,
      })
    }
    catch (error) {
      if (error instanceof SessionStoreError)
        throw error
      throw operationFailed('read', sessionId, 'PostgreSQL 读取 Session Event 失败', error)
    }
  }

  /** 使用不可变的 catalog_order 游标分页列出摘要，不读取事件表。 */
  async list(options: ListSessionsOptions): Promise<SessionListPage> {
    validateIdentifier(options.scopeId, 'scopeId')
    const limit = options.limit ?? DEFAULT_PAGE_SIZE
    validatePageSize(limit, '')
    const search = normalizeSearch(options.search)

    try {
      let afterCatalogOrder = 0
      if (options.afterSessionId !== undefined) {
        validateIdentifier(options.afterSessionId, 'afterSessionId')
        const cursorResult = await this.pool.query<{ catalog_order: string | number }>(`
          SELECT catalog_order
          FROM craft_agent_sessions
          WHERE scope_id = $1 AND session_id = $2
        `, [options.scopeId, options.afterSessionId])
        const cursor = cursorResult.rows[0]
        if (!cursor)
          throw invalidArgument('', `afterSessionId ${options.afterSessionId} 不存在`)
        afterCatalogOrder = parseDatabaseInteger(
          cursor.catalog_order,
          'catalog_order',
          options.afterSessionId,
          'list',
        )
      }

      // 多取一行只用于判断 hasMore，不把额外行暴露给调用方。
      const result = await this.pool.query<SessionSummaryRow>(`
        SELECT scope_id, session_id, session_name, version, metadata_json, created_at
        FROM craft_agent_sessions
        WHERE scope_id = $1
          AND catalog_order > $2
          AND ($3::text IS NULL OR session_name ILIKE '%' || $3 || '%' ESCAPE '\\')
        ORDER BY catalog_order ASC
        LIMIT $4
      `, [options.scopeId, afterCatalogOrder, search ?? null, limit + 1])
      const hasMore = result.rows.length > limit
      const sessions = result.rows.slice(0, limit).map(row => createSessionSummary(row))
      const nextAfterSessionId = sessions.at(-1)?.sessionId

      return deepFreeze({
        sessions,
        hasMore,
        ...(nextAfterSessionId ? { nextAfterSessionId } : {}),
      })
    }
    catch (error) {
      if (error instanceof SessionStoreError)
        throw error
      throw operationFailed('list', '', 'PostgreSQL 读取 Session 目录失败', error)
    }
  }

  /**
   * 更新会话的展示名称，成功返回更新后的摘要，会话不存在返回 undefined。
   *
   * 只改目录投影，不改写 `session.created` 事件：历史事实保持原样，当前名称以目录为准，
   * 因此 read()/list() 会立刻看到新名称。返回值直接来自 UPDATE ... RETURNING，
   * 避免"改名成功但随后读不到"的竞态。
   */
  async rename(identity: SessionIdentity, name: string): Promise<SessionSummary | undefined> {
    validateIdentifier(identity.scopeId, 'scopeId')
    validateIdentifier(identity.sessionId, 'sessionId')
    validateSessionName(name)

    try {
      const result = await this.pool.query<SessionSummaryRow>(`
        UPDATE craft_agent_sessions
        SET session_name = $3, updated_at = now()
        WHERE scope_id = $1 AND session_id = $2
        RETURNING scope_id, session_id, session_name, version, metadata_json, created_at
      `, [identity.scopeId, identity.sessionId, name.trim()])
      const row = result.rows[0]
      return row ? createSessionSummary(row) : undefined
    }
    catch (error) {
      if (error instanceof SessionStoreError)
        throw error
      throw operationFailed('append', identity.sessionId, 'PostgreSQL 更新会话名称失败', error)
    }
  }

  /**
   * 删除会话及其全部事件。
   *
   * 事件表对目录表有外键且没有级联删除，因此必须在同一事务里先删事件再删目录行，
   * 避免失败时留下半删除状态。这是唯一会移除已记录事实的操作，见本文件顶部说明。
   */
  async remove(identity: SessionIdentity): Promise<boolean> {
    validateIdentifier(identity.scopeId, 'scopeId')
    validateIdentifier(identity.sessionId, 'sessionId')
    const client = await connectForAppend(this.pool, identity.sessionId)

    try {
      await client.query('BEGIN')
      await client.query(`
        DELETE FROM craft_agent_session_events
        WHERE scope_id = $1 AND session_id = $2
      `, [identity.scopeId, identity.sessionId])
      const result = await client.query(`
        DELETE FROM craft_agent_sessions
        WHERE scope_id = $1 AND session_id = $2
      `, [identity.scopeId, identity.sessionId])
      await client.query('COMMIT')
      return (result.rowCount ?? 0) > 0
    }
    catch (error) {
      await safelyRollback(client)
      if (error instanceof SessionStoreError)
        throw error
      throw operationFailed('append', identity.sessionId, 'PostgreSQL 删除会话失败', error)
    }
    finally {
      client.release()
    }
  }
}

/** 会话名称必须是非空字符串，与数据库 CHECK 约束保持一致；长度上限由 HTTP 边界负责。 */
function validateSessionName(value: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw invalidArgument('', 'sessionName 必须是非空字符串')
}

/**
 * 把目录行投影为协议摘要。
 *
 * `list` 与 `rename` 共用同一份映射，保证两处返回的形状与校验行为完全一致。
 * operation 只用于诊断，不改变结果。
 */
function createSessionSummary(
  row: SessionSummaryRow,
  operation: SessionStoreOperation = 'list',
): SessionSummary {
  return deepFreeze({
    scopeId: row.scope_id,
    sessionId: row.session_id,
    ...(row.session_name ? { sessionName: row.session_name } : {}),
    createdAt: toIsoTimestamp(row.created_at, row.session_id, operation),
    version: parseDatabaseInteger(row.version, 'version', row.session_id, operation),
    ...(row.metadata_json === null
      ? {}
      : {
          metadata: restoreJsonObject(
            row.metadata_json,
            'metadata_json',
            row.session_id,
            operation,
          ),
        }),
  })
}

/** 连接池获取连接失败时也遵守 SessionStore 的稳定错误协议。 */
async function connectForAppend(pool: Pool, sessionId: string): Promise<PoolClient> {
  try {
    return await pool.connect()
  }
  catch (error) {
    throw operationFailed('append', sessionId, 'PostgreSQL 获取写入连接失败', error)
  }
}

/** 在当前事务中插入一条事件；调用方负责版本锁和提交。 */
async function insertEvent(client: PoolClient, event: SessionEvent): Promise<void> {
  const runId = 'runId' in event ? (event.runId ?? null) : null
  const turnId = 'turnId' in event ? (event.turnId ?? null) : null
  await client.query(`
    INSERT INTO craft_agent_session_events (
      scope_id,
      session_id,
      sequence,
      event_id,
      event_type,
      run_id,
      turn_id,
      payload_json,
      created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
  `, [
    event.scopeId,
    event.sessionId,
    event.sequence,
    event.eventId,
    event.type,
    runId,
    turnId,
    serializeJson(createEventPayload(event)),
    event.timestamp,
  ])
}

/** 数据库只保存事件专属数据；公共信封和关联 ID 使用独立列。 */
function createEventPayload(event: SessionEvent): JsonObject {
  switch (event.type) {
    case 'session.created':
      return {
        ...(event.sessionName ? { sessionName: event.sessionName } : {}),
        ...(event.metadata ? { metadata: event.metadata } : {}),
      }
    case 'message.appended':
      return { message: event.message as unknown as JsonValue }
    case 'turn.failed':
      return { error: event.error as unknown as JsonValue }
    case 'turn.cancelled':
      return event.reason === undefined ? {} : { reason: event.reason }
    case 'turn.started':
    case 'turn.completed':
      return {}
  }
}

/** 把数据库行恢复为 SessionEvent 判别联合，并拒绝损坏或未知的持久化数据。 */
function restoreEvent(
  row: SessionEventRow,
  requestedScopeId: string,
  requestedSessionId: string,
): SessionEvent {
  if (row.scope_id !== requestedScopeId || row.session_id !== requestedSessionId)
    throw operationFailed('read', requestedSessionId, '数据库返回了其他 Session 的事件')
  validateIdentifier(row.event_id, 'event_id')
  const sequence = parseDatabaseInteger(row.sequence, 'sequence', requestedSessionId)
  const timestamp = toIsoTimestamp(row.created_at, requestedSessionId)
  const payload = restoreJsonObject(row.payload_json, 'payload_json', requestedSessionId)
  const envelope = {
    eventId: row.event_id,
    scopeId: row.scope_id,
    sessionId: row.session_id,
    sequence,
    timestamp,
  }
  const correlation = {
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  }

  switch (row.event_type) {
    case 'session.created': {
      if (payload.sessionName !== undefined && typeof payload.sessionName !== 'string')
        throw operationFailed('read', requestedSessionId, 'session.created.sessionName 必须是字符串')
      const metadata = payload.metadata === undefined
        ? undefined
        : restoreJsonObject(payload.metadata, 'metadata', requestedSessionId)
      return deepFreeze({
        ...envelope,
        type: 'session.created',
        ...(typeof payload.sessionName === 'string' ? { sessionName: payload.sessionName } : {}),
        ...(metadata ? { metadata } : {}),
      })
    }
    case 'message.appended':
      if (typeof payload.message !== 'object' || payload.message === null)
        throw operationFailed('read', requestedSessionId, 'message.appended 缺少 message')
      return deepFreeze({
        ...envelope,
        ...correlation,
        type: 'message.appended',
        message: payload.message as ModelMessage,
      })
    case 'turn.started':
    case 'turn.completed':
      if (!row.turn_id)
        throw operationFailed('read', requestedSessionId, `${row.event_type} 缺少 turn_id`)
      return deepFreeze({
        ...envelope,
        ...correlation,
        type: row.event_type,
        turnId: row.turn_id,
      })
    case 'turn.failed':
      if (!row.turn_id || typeof payload.error !== 'object' || payload.error === null)
        throw operationFailed('read', requestedSessionId, 'turn.failed 缺少 turn_id 或 error')
      return deepFreeze({
        ...envelope,
        ...correlation,
        type: 'turn.failed',
        turnId: row.turn_id,
        error: payload.error as unknown as SessionFailureInfo,
      })
    case 'turn.cancelled':
      if (!row.turn_id)
        throw operationFailed('read', requestedSessionId, 'turn.cancelled 缺少 turn_id')
      if (payload.reason !== undefined && typeof payload.reason !== 'string')
        throw operationFailed('read', requestedSessionId, 'turn.cancelled.reason 必须是字符串')
      return deepFreeze({
        ...envelope,
        ...correlation,
        type: 'turn.cancelled',
        turnId: row.turn_id,
        ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
      })
    default:
      throw operationFailed('read', requestedSessionId, `数据库包含未知事件类型 ${row.event_type}`)
  }
}

/** 为事件草稿附加 Store 负责生成的身份、顺序和时间信封。 */
function createPersistedEvent(
  draft: SessionEventDraft,
  scopeId: string,
  sessionId: string,
  eventId: string,
  sequence: number,
  timestamp: string,
): SessionEvent {
  return deepFreeze({
    ...draft,
    eventId,
    scopeId,
    sessionId,
    sequence,
    timestamp,
  }) as SessionEvent
}

/** 新 Session 必须创建一次；已有 Session 不允许再次出现 session.created。 */
function validateInitialization(
  events: readonly SessionEventDraft[],
  currentVersion: number,
  sessionId: string,
): void {
  if (currentVersion === 0 && events[0]?.type !== 'session.created') {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_EVENT_SEQUENCE',
      message: `Session ${sessionId} 的第一个事件必须是 session.created`,
      sessionId,
      operation: 'append',
    })
  }

  const createdCount = events.filter(event => event.type === 'session.created').length
  const expectedCreatedCount = currentVersion === 0 ? 1 : 0
  if (createdCount !== expectedCreatedCount) {
    throw new SessionStoreError({
      code: 'SESSION_INVALID_EVENT_SEQUENCE',
      message: `Session ${sessionId} 只能在 sequence=1 写入一次 session.created`,
      sessionId,
      operation: 'append',
    })
  }
}

/** 验证 JavaScript 调用方可能绕过 TypeScript 传入的事件判别字段和关联 ID。 */
function validateDraft(event: SessionEventDraft, sessionId: string): void {
  if (typeof event !== 'object' || event === null || Array.isArray(event))
    throw invalidArgument(sessionId, 'Session Event 必须是对象')
  if ('runId' in event && event.runId !== undefined)
    validateIdentifier(event.runId, 'runId')
  if ('turnId' in event && event.turnId !== undefined)
    validateIdentifier(event.turnId, 'turnId')
  if (event.type === 'session.created' && event.sessionName !== undefined)
    validateIdentifier(event.sessionName, 'sessionName')
  if (![
    'session.created',
    'message.appended',
    'turn.started',
    'turn.completed',
    'turn.failed',
    'turn.cancelled',
  ].includes(event.type)) {
    throw invalidArgument(sessionId, '不支持的 Session Event type')
  }
}

/** JSON 往返既创建不可共享的副本，也拒绝函数、BigInt、循环引用和非有限数字。 */
function cloneSerializable<T>(value: T, sessionId: string): T {
  try {
    const json = JSON.stringify(value, (_key, child) => {
      if (typeof child === 'number' && !Number.isFinite(child))
        throw new TypeError('Session Event 不能包含非有限数字')
      if (typeof child === 'bigint' || typeof child === 'function' || typeof child === 'symbol')
        throw new TypeError(`Session Event 不能包含 ${typeof child}`)
      return child
    })
    if (json === undefined)
      throw new TypeError('Session Event 无法序列化为 JSON')
    return JSON.parse(json) as T
  }
  catch (error) {
    throw new SessionStoreError({
      code: 'SESSION_SERIALIZATION_FAILED',
      message: `Session ${sessionId} 的事件无法安全序列化`,
      sessionId,
      operation: 'append',
      cause: error,
    })
  }
}

/** JSON 参数统一序列化；JavaScript null 必须保留为 SQL NULL 以满足 metadata 约束。 */
function serializeJson(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value)
}

/** 将名称搜索归一化为大小写不敏感的字面子串，避免 `%` 和 `_` 被解释为通配符。 */
function normalizeSearch(value: string | undefined): string | undefined {
  if (value === undefined)
    return undefined
  if (typeof value !== 'string' || !value.trim())
    throw invalidArgument('', 'search 必须是非空字符串')
  return value.trim().replace(/[\\%_]/g, '\\$&')
}

/** 将 jsonb 值收窄为普通对象，数组和 null 都视为持久化数据损坏。 */
function restoreJsonObject(
  value: unknown,
  field: string,
  sessionId: string,
  operation: SessionStoreOperation = 'read',
): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw operationFailed(operation, sessionId, `${field} 必须是 JSON 对象`)
  return value as JsonObject
}

/** 将 PostgreSQL bigint 安全转换为 JavaScript number，拒绝超出安全整数范围。 */
function parseDatabaseInteger(
  value: string | number,
  field: string,
  sessionId: string,
  operation: SessionStoreOperation = 'read',
): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw operationFailed(operation, sessionId, `${field} 不是非负安全整数`)
  return parsed
}

/** 把驱动返回的 Date 或文本时间统一转成 ISO 8601 字符串。 */
function toIsoTimestamp(
  value: Date | string,
  sessionId: string,
  operation: SessionStoreOperation = 'read',
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime()))
    throw operationFailed(operation, sessionId, '数据库包含无效时间戳')
  return date.toISOString()
}

/** 事件身份与发生时刻由产生方写入；缺省时由 Store 兜底生成。 */
function resolveProducerEventId(
  draft: SessionEventDraft,
  fallback: () => string,
  sessionId: string,
): string {
  if (draft.eventId === undefined)
    return fallback()
  if (typeof draft.eventId !== 'string' || !draft.eventId.trim())
    throw invalidArgument(sessionId, '事件 eventId 必须是非空字符串')
  return draft.eventId.trim()
}

function resolveEventTimestamp(draft: SessionEventDraft, sessionId: string): string {
  if (draft.timestamp === undefined)
    return new Date().toISOString()
  if (typeof draft.timestamp !== 'string' || !draft.timestamp)
    throw invalidArgument(sessionId, '事件 timestamp 必须是非空字符串')
  const date = new Date(draft.timestamp)
  if (!Number.isFinite(date.getTime()))
    throw invalidArgument(sessionId, '事件 timestamp 必须是可解析的时间')
  return date.toISOString()
}

/** 验证协议中的非空字符串身份字段。 */
function validateIdentifier(value: string, field: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw invalidArgument('', `${field} 必须是非空字符串`)
}

/** 验证 sequence/version 一类从零开始的整数。 */
function validateNonNegativeInteger(value: number, field: string, sessionId: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw invalidArgument(sessionId, `${field} 必须是非负安全整数`)
}

/** 验证分页大小并保持 Memory/PostgreSQL Store 相同的上限。 */
function validatePageSize(value: number, sessionId: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw invalidArgument(sessionId, 'limit 必须是正安全整数')
  if (value > MAX_PAGE_SIZE)
    throw invalidArgument(sessionId, `limit 不能超过 ${MAX_PAGE_SIZE}`)
}

/** 构造协议参数错误。 */
function invalidArgument(sessionId: string, message: string): SessionStoreError {
  return new SessionStoreError({
    code: 'SESSION_INVALID_ARGUMENT',
    message,
    ...(sessionId ? { sessionId } : {}),
  })
}

/** 保留底层异常为 cause，后续 DiagnosticSink 可记录完整 stack 和 PostgreSQL 详情。 */
function operationFailed(
  operation: SessionStoreOperation,
  sessionId: string,
  message: string,
  cause?: unknown,
): SessionStoreError {
  return new SessionStoreError({
    code: 'SESSION_OPERATION_FAILED',
    message,
    ...(sessionId ? { sessionId } : {}),
    operation,
    ...(cause === undefined ? {} : { cause }),
  })
}

/** 回滚失败不能覆盖最初的数据库错误。 */
async function safelyRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  }
  catch {
    // 原始异常会作为最终错误或 cause 抛出。
  }
}

/** 识别 PostgreSQL 唯一约束冲突（SQLSTATE 23505）。 */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null)
    return false
  const postgresError = error as PostgresErrorLike
  return postgresError.code === '23505'
    && (postgresError.constraint === 'craft_agent_session_events_event_id_key'
      || postgresError.constraint === undefined)
}

/** 深度冻结从数据库恢复的对象，避免调用方在进程内篡改本次读取结果。 */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value))
    return value
  for (const child of Object.values(value))
    deepFreeze(child)
  return Object.freeze(value)
}
