// @vitest-environment node

import type { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { runPostgresMigrations } from '../src/server/database/migrations'
import { readPostgresRuntimeConfig } from '../src/server/database/postgres'

describe('postgres runtime config', () => {
  it('normalizes the connection string and safe defaults', () => {
    expect(readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: '  postgresql://example  ',
    })).toEqual({
      connectionString: 'postgresql://example',
      maxConnections: 10,
      ssl: false,
    })
  })

  it('accepts explicit pool and TLS settings', () => {
    expect(readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://example',
      CRAFT_AGENT_DATABASE_POOL_MAX: '4',
      CRAFT_AGENT_DATABASE_SSL: 'true',
    })).toEqual({
      connectionString: 'postgresql://example',
      maxConnections: 4,
      ssl: true,
    })
  })

  it('rejects missing or ambiguous database settings', () => {
    expect(() => readPostgresRuntimeConfig({})).toThrow(
      '缺少环境变量 CRAFT_AGENT_DATABASE_URL',
    )
    expect(() => readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://example',
      CRAFT_AGENT_DATABASE_POOL_MAX: '0',
    })).toThrow('CRAFT_AGENT_DATABASE_POOL_MAX 必须是正整数')
    expect(() => readPostgresRuntimeConfig({
      CRAFT_AGENT_DATABASE_URL: 'postgresql://example',
      CRAFT_AGENT_DATABASE_SSL: 'yes',
    })).toThrow('CRAFT_AGENT_DATABASE_SSL 必须是 true 或 false')
  })
})

describe('postgres migrations', () => {
  it('applies pending files in order while holding the migration lock', async () => {
    const database = createMigrationDatabase()

    await expect(runPostgresMigrations(database.pool)).resolves.toEqual({
      availableMigrations: [
        '001-create-session-log.sql',
        '002-add-session-scope-and-name.sql',
        '003-use-composite-session-identity.sql',
        '004-create-agent-trace.sql',
      ],
      appliedMigrations: [
        '001-create-session-log.sql',
        '002-add-session-scope-and-name.sql',
        '003-use-composite-session-identity.sql',
        '004-create-agent-trace.sql',
      ],
    })

    const lockIndex = database.statements.findIndex(statement => statement.sql.includes('pg_advisory_lock'))
    const registryIndex = database.statements.findIndex(statement => statement.sql.includes('CREATE TABLE IF NOT EXISTS craft_agent_schema_migrations'))
    expect(lockIndex).toBeGreaterThanOrEqual(0)
    expect(registryIndex).toBeGreaterThan(lockIndex)
    expect(database.statements.filter(statement => statement.sql === 'BEGIN')).toHaveLength(4)
    expect(database.statements.filter(statement => statement.sql === 'COMMIT')).toHaveLength(4)
    expect(database.statements.at(-1)?.sql).toContain('pg_advisory_unlock')
    expect(database.release).toHaveBeenCalledOnce()
  })

  it('skips migrations already recorded in the registry', async () => {
    const database = createMigrationDatabase({ allApplied: true })

    const result = await runPostgresMigrations(database.pool)

    expect(result.appliedMigrations).toEqual([])
    expect(database.statements).not.toContainEqual(expect.objectContaining({ sql: 'BEGIN' }))
    expect(database.release).toHaveBeenCalledOnce()
  })

  it('rolls back a failed file and still releases the lock and connection', async () => {
    const database = createMigrationDatabase({ failOn: 'CREATE EXTENSION IF NOT EXISTS pg_trgm' })

    await expect(runPostgresMigrations(database.pool)).rejects.toThrow('migration failed')

    expect(database.statements.some(statement => statement.sql === 'ROLLBACK')).toBe(true)
    expect(database.statements.at(-1)?.sql).toContain('pg_advisory_unlock')
    expect(database.release).toHaveBeenCalledOnce()
  })
})

function createMigrationDatabase(
  options: { readonly allApplied?: boolean, readonly failOn?: string } = {},
): {
  readonly pool: Pool
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
    if (normalized.includes('SELECT EXISTS'))
      return { rows: [{ exists: options.allApplied === true }] }
    return { rows: [] }
  })
  const pool = {
    connect: vi.fn(async () => ({ query, release })),
  } as unknown as Pool
  return { pool, statements, release }
}
