// @vitest-environment node

import type { MySqlConnection, MySqlPool, MySqlQueryResult } from '../src/server/database/mysql'
import { describe, expect, it, vi } from 'vitest'
import { MySqlSessionStore } from '../src/server/stores/mysql-session-store'

function result<Row>(rows: Row[] = [], rowCount = rows.length): MySqlQueryResult<Row> {
  return { rows, rowCount }
}

describe('mysql session store', () => {
  it('appends an event batch with MySQL placeholders and UTC Date values', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('SELECT version'))
        return result([{ version: '0' }])
      return result()
    })
    const connection = { query, release: vi.fn() } as unknown as MySqlConnection
    const pool = {
      connect: vi.fn(async () => connection),
    } as unknown as MySqlPool
    const store = new MySqlSessionStore(pool)

    const appended = await store.append({
      scopeId: 'scope-mysql',
      sessionId: 'session-mysql',
      expectedVersion: 0,
      events: [{
        type: 'session.created',
        eventId: 'event-mysql',
        timestamp: '2026-09-13T04:00:00.000Z',
        metadata: { source: 'test' },
      }],
    })

    expect(appended.version).toBe(1)
    expect(query.mock.calls.map(([sql]) => sql.trim())).toEqual([
      'BEGIN',
      expect.stringContaining('ON DUPLICATE KEY UPDATE'),
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('INSERT INTO craft_agent_session_events'),
      expect.stringContaining('UPDATE craft_agent_sessions'),
      'COMMIT',
    ])
    const allSql = query.mock.calls.map(([sql]) => sql).join('\n')
    expect(allSql).not.toMatch(/\$\d|::jsonb|::timestamptz/)
    const sessionInsert = query.mock.calls[1]?.[1] as unknown as unknown[]
    const eventInsert = query.mock.calls[3]?.[1] as unknown as unknown[]
    expect(sessionInsert.at(-1)).toBeInstanceOf(Date)
    expect(eventInsert.at(-1)).toBeInstanceOf(Date)
    expect(connection.release).toHaveBeenCalledOnce()
  })

  it('restores JSON text returned by mysql2', async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce(result([{ version: '1', session_name: 'MySQL 会话' }]))
        .mockResolvedValueOnce(result([{
          scope_id: 'scope-mysql',
          session_id: 'session-mysql',
          sequence: '1',
          event_id: 'event-mysql',
          event_type: 'session.created',
          run_id: null,
          turn_id: null,
          payload_json: '{"sessionName":"MySQL 会话"}',
          created_at: '2026-09-13T04:00:00.000Z',
        }])),
    } as unknown as MySqlPool
    const store = new MySqlSessionStore(pool)

    const page = await store.read({ scopeId: 'scope-mysql', sessionId: 'session-mysql' })

    expect(page).toMatchObject({
      sessionName: 'MySQL 会话',
      latestVersion: 1,
      events: [{ type: 'session.created', sessionName: 'MySQL 会话' }],
    })
  })

  it('escapes literal wildcard characters in name searches', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => result([]))
    const store = new MySqlSessionStore({ query } as unknown as MySqlPool)

    await store.list({ scopeId: 'scope-mysql', search: '%_!', limit: 10 })

    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toContain('LIKE ? ESCAPE \'!\'')
    expect(query.mock.calls[0]?.[1]).toEqual([
      'scope-mysql',
      0,
      '!%!_!!',
      '%!%!_!!%',
      11,
    ])
  })
})
