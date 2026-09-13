import type { AgentEvent } from 'craft-harness'
import type { Pool } from 'pg'
import type {
  ReadTrajectoryRequest,
  TrajectoryEventPage,
  TrajectoryEventRecord,
  TrajectoryStore,
} from '../trajectory-store'

interface BufferedRun {
  readonly sessionId: string
  readonly events: AgentEvent[]
  readonly firstChunkSteps: Set<number>
  terminal: boolean
}

interface TraceEventRow {
  readonly trace_sequence: string | number
  readonly payload_json: unknown
}

const TERMINAL_EVENT_TYPES = new Set<AgentEvent['type']>([
  'agent.run.completed',
  'agent.run.stopped',
  'agent.run.failed',
])

/**
 * 将 Agent 的旁路事件按 Run 缓冲，并在终态一次性写入 PostgreSQL。
 *
 * Run 开始事件早于 SessionStore 创建目录行，所以不能逐条直接插入带外键的表。批量终态写入既
 * 避开这个时序，也避免 token 流造成大量小事务。模型 chunk 只保存每个 Step 的第一条，用于
 * 首 token 计时；完整模型结果由轨迹接口关联 Session Log 中的 assistant 消息提供。
 */
export class PostgresTrajectoryStore implements TrajectoryStore {
  private readonly scopeBySession = new Map<string, string>()
  private readonly runs = new Map<string, BufferedRun>()

  constructor(readonly pool: Pool) {}

  readonly record = async (event: AgentEvent): Promise<void> => {
    let run = this.runs.get(event.runId)
    if (!run) {
      run = {
        sessionId: event.sessionId,
        events: [],
        firstChunkSteps: new Set<number>(),
        terminal: false,
      }
      this.runs.set(event.runId, run)
    }

    if (event.type === 'agent.model.chunk') {
      if (run.firstChunkSteps.has(event.step))
        return
      run.firstChunkSteps.add(event.step)
    }

    run.events.push(cloneEvent(event))
    run.terminal = TERMINAL_EVENT_TYPES.has(event.type)
    if (run.terminal)
      await this.flushRun(event.runId, run)
  }

  readonly bindSession = async (scopeId: string, sessionId: string): Promise<void> => {
    this.scopeBySession.set(sessionId, scopeId)
    const terminalRuns = [...this.runs.entries()]
      .filter(([, run]) => run.sessionId === sessionId && run.terminal)
    for (const [runId, run] of terminalRuns)
      await this.flushRun(runId, run)
  }

  readonly read = async (request: ReadTrajectoryRequest): Promise<TrajectoryEventPage> => {
    const values: unknown[] = [request.scopeId, request.sessionId, request.limit + 1]
    const beforeClause = request.beforeSequence === undefined
      ? ''
      : 'AND trace_sequence < $4'
    if (request.beforeSequence !== undefined)
      values.push(request.beforeSequence)

    const result = await this.pool.query<TraceEventRow>(`
      SELECT trace_sequence, payload_json
      FROM craft_agent_trace_events
      WHERE scope_id = $1
        AND session_id = $2
        ${beforeClause}
      ORDER BY trace_sequence DESC
      LIMIT $3
    `, values)

    const hasEarlier = result.rows.length > request.limit
    const selected = hasEarlier ? result.rows.slice(0, request.limit) : result.rows
    const events = selected
      .map(restoreRecord)
      .reverse()
    return Object.freeze({
      events: Object.freeze(events),
      hasEarlier,
      ...(hasEarlier && events[0]
        ? { nextBeforeSequence: events[0].sequence }
        : {}),
    })
  }

  private async flushRun(runId: string, run: BufferedRun): Promise<void> {
    const scopeId = this.scopeBySession.get(run.sessionId)
    if (!scopeId || !run.terminal)
      return

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const event of run.events) {
        await client.query(`
          INSERT INTO craft_agent_trace_events (
            scope_id,
            session_id,
            run_id,
            turn_id,
            event_type,
            payload_json,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz)
        `, [
          scopeId,
          event.sessionId,
          event.runId,
          event.turnId,
          event.type,
          JSON.stringify(event),
          event.timestamp,
        ])
      }
      await client.query('COMMIT')
      this.runs.delete(runId)
      const sessionStillActive = [...this.runs.values()]
        .some(buffered => buffered.sessionId === run.sessionId)
      if (!sessionStillActive)
        this.scopeBySession.delete(run.sessionId)
    }
    catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
    finally {
      client.release()
    }
  }
}

function cloneEvent(event: AgentEvent): AgentEvent {
  return JSON.parse(JSON.stringify(event)) as AgentEvent
}

function restoreRecord(row: TraceEventRow): TrajectoryEventRecord {
  const sequence = typeof row.trace_sequence === 'number'
    ? row.trace_sequence
    : Number.parseInt(row.trace_sequence, 10)
  if (!Number.isSafeInteger(sequence) || sequence <= 0)
    throw new Error('轨迹事件序号损坏')
  if (!isAgentEvent(row.payload_json))
    throw new Error(`轨迹事件 ${sequence} 的 payload 损坏`)
  return Object.freeze({ sequence, event: cloneEvent(row.payload_json) })
}

/** 数据库是应用边界；恢复时至少验证页面分组和排序所依赖的公共信封。 */
function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null)
    return false
  const event = value as Record<string, unknown>
  return typeof event.type === 'string'
    && typeof event.runId === 'string'
    && typeof event.turnId === 'string'
    && typeof event.sessionId === 'string'
    && typeof event.timestamp === 'string'
}
