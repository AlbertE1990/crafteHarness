// @vitest-environment node

import type { MySqlPool, MySqlQueryable } from '../src/server/database/mysql'
import { describe, expect, it, vi } from 'vitest'
import { runMySqlMigrations } from '../src/server/database/migrations'
import { inspectMySqlConnection, readMySqlRuntimeConfig } from '../src/server/database/mysql'

describe('mysql runtime config', () => {
  it('normalizes the connection string and safe defaults', () => {
    expect(readMySqlRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: '  mysql://user:secret@127.0.0.1:3306/craft_agent_dev  ',
    })).toEqual({
      connectionString: 'mysql://user:secret@127.0.0.1:3306/craft_agent_dev',
      maxConnections: 10,
      ssl: false,
    })
  })

  it('accepts explicit pool and TLS settings', () => {
    expect(readMySqlRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'mysql://user:secret@db:3306/craft_agent_dev',
      CRAFT_AGENT_DATABASE_POOL_MAX: '4',
      CRAFT_AGENT_DATABASE_SSL: 'true',
    })).toEqual({
      connectionString: 'mysql://user:secret@db:3306/craft_agent_dev',
      maxConnections: 4,
      ssl: true,
    })
  })

  it('rejects missing, non-MySQL or incomplete database settings', () => {
    expect(() => readMySqlRuntimeConfig({})).toThrow(
      '缺少环境变量 CRAFT_AGENT_DATABASE_URL',
    )
    expect(() => readMySqlRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://user:secret@db/craft_agent_dev',
    })).toThrow('必须使用 mysql:// 协议')
    expect(() => readMySqlRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'mysql://user:secret@db',
    })).toThrow('必须包含主机名和数据库名')
    expect(() => readMySqlRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'mysql://user:secret@db/craft_agent_dev',
      CRAFT_AGENT_DATABASE_POOL_MAX: '0',
    })).toThrow('CRAFT_AGENT_DATABASE_POOL_MAX 必须是正整数')
    expect(() => readMySqlRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'mysql://user:secret@db/craft_agent_dev',
      CRAFT_AGENT_DATABASE_SSL: 'yes',
    })).toThrow('CRAFT_AGENT_DATABASE_SSL 必须是 true 或 false')
  })
})

describe('mysql connection inspection', () => {
  it('uses a non-reserved alias and maps the connection details', async () => {
    const statements: string[] = []
    const database: MySqlQueryable = {
      async query<Row>(sql: string) {
        statements.push(sql)
        return {
          rows: [{
            database_name: 'craft_agent_dev',
            server_version: '8.4.0',
            sessions_table: 1,
            events_table: '1',
          }] as Row[],
          rowCount: 1,
        }
      },
    }

    await expect(inspectMySqlConnection(database)).resolves.toEqual({
      database: 'craft_agent_dev',
      serverVersion: '8.4.0',
      sessionsTableExists: true,
      eventsTableExists: true,
    })
    expect(statements[0]).toContain('DATABASE() AS database_name')
    expect(statements[0]).not.toContain('DATABASE() AS database,')
  })
})

describe('mysql migrations', () => {
  it('applies pending files in order while holding the migration lock', async () => {
    const database = createMigrationDatabase()

    await expect(runMySqlMigrations(database.pool)).resolves.toEqual({
      availableMigrations: [
        '001-create-sessions.sql',
        '002-create-session-events.sql',
        '003-create-trace-events.sql',
      ],
      appliedMigrations: [
        '001-create-sessions.sql',
        '002-create-session-events.sql',
        '003-create-trace-events.sql',
      ],
    })

    const lockIndex = database.statements.findIndex(statement => statement.sql.includes('GET_LOCK'))
    const registryIndex = database.statements.findIndex(statement => statement.sql.includes('CREATE TABLE IF NOT EXISTS craft_agent_schema_migrations'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(registryIndex).toBeGreaterThan(lockIndex)
    expect(database.statements.at(-1)?.sql).toContain('RELEASE_LOCK')
    expect(database.release).toHaveBeenCalledOnce()
  })

  it('skips migrations already recorded in the registry', async () => {
    const database = createMigrationDatabase({ allApplied: true })

    const result = await runMySqlMigrations(database.pool)

    expect(result.appliedMigrations).toEqual([])
    expect(database.release).toHaveBeenCalledOnce()
  })

  it('releases the lock and connection when a migration fails', async () => {
    const database = createMigrationDatabase({ failOn: 'CREATE TABLE IF NOT EXISTS craft_agent_session_events' })

    await expect(runMySqlMigrations(database.pool)).rejects.toThrow('migration failed')

    expect(database.statements.at(-1)?.sql).toContain('RELEASE_LOCK')
    expect(database.release).toHaveBeenCalledOnce()
  })
})

function createMigrationDatabase(
  options: { readonly allApplied?: boolean, readonly failOn?: string } = {},
): {
  readonly pool: MySqlPool
  readonly statements: Array<{ readonly sql: string, readonly values?: readonly unknown[] }>
  readonly release: ReturnType<typeof vi.fn>
} {
  const statements: Array<{ readonly sql: string, readonly values?: readonly unknown[] }> = []
  const release = vi.fn()
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    const normalized = sql.trim()
    statements.push({ sql: normalized, ...(values ? { values } : {}) })
    if (options.failOn && normalized.includes(options.failOn))
      throw new Error('migration failed')
    if (normalized.includes('GET_LOCK'))
      return { rows: [{ acquired: 1 }], rowCount: 1 }
    if (normalized.includes('FROM craft_agent_schema_migrations')) {
      return options.allApplied
        ? { rows: [{ filename: String(values?.[0]) }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  })
  const pool = {
    query,
    connect: vi.fn(async () => ({ query, release })),
    end: vi.fn(),
  } as unknown as MySqlPool
  return { pool, statements, release }
}
