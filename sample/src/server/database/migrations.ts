import type { Pool } from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const MIGRATION_FILENAME_PATTERN = /^\d+-[a-z0-9-]+\.sql$/i
const MIGRATION_LOCK_NAME = 'craft_agent_schema_migrations'
const defaultMigrationsUrl = new URL('../../../database/migrations/', import.meta.url)

/** 一次迁移检查的结果；available 包含目录中的全部合法迁移。 */
export interface PostgresMigrationResult {
  readonly availableMigrations: readonly string[]
  readonly appliedMigrations: readonly string[]
}

/**
 * 按文件名执行尚未应用的 sample 数据库迁移。
 *
 * advisory lock 让多个 Server 同时启动时只有一个实例修改结构；每个文件使用独立事务，
 * 已完成的版本记录在 craft_agent_schema_migrations 中。
 */
export async function runPostgresMigrations(pool: Pool): Promise<PostgresMigrationResult> {
  const migrationsUrl = resolveMigrationsUrl()
  const client = await pool.connect()
  let lockAcquired = false

  try {
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [MIGRATION_LOCK_NAME])
    lockAcquired = true
    await client.query(`
      CREATE TABLE IF NOT EXISTS craft_agent_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const availableMigrations = (await readdir(migrationsUrl))
      .filter(filename => MIGRATION_FILENAME_PATTERN.test(filename))
      .sort((left, right) => left.localeCompare(right))
    const appliedMigrations: string[] = []

    for (const filename of availableMigrations) {
      const applied = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM craft_agent_schema_migrations
          WHERE filename = $1
        ) AS exists
      `, [filename])
      if (applied.rows[0]?.exists)
        continue

      const sql = await readFile(new URL(filename, migrationsUrl), 'utf8')
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query(`
          INSERT INTO craft_agent_schema_migrations (filename)
          VALUES ($1)
        `, [filename])
        await client.query('COMMIT')
        appliedMigrations.push(filename)
      }
      catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        throw error
      }
    }

    return Object.freeze({
      availableMigrations: Object.freeze(availableMigrations),
      appliedMigrations: Object.freeze(appliedMigrations),
    })
  }
  finally {
    if (lockAcquired) {
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [MIGRATION_LOCK_NAME])
        .catch(() => undefined)
    }
    client.release()
  }
}

function resolveMigrationsUrl(): URL {
  const configured = process.env.CRAFT_AGENT_MIGRATIONS_DIR?.trim()
  if (!configured)
    return defaultMigrationsUrl
  const directory = `${path.resolve(configured)}${path.sep}`
  return pathToFileURL(directory)
}
