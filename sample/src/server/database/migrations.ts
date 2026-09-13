import type { MySqlPool } from './mysql'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const MIGRATION_FILENAME_PATTERN = /^\d+-[a-z0-9-]+\.sql$/i
const MIGRATION_LOCK_NAME = 'craft_agent_schema_migrations'
const defaultMigrationsUrl = new URL('../../../database/migrations/', import.meta.url)

export interface MySqlMigrationResult {
  readonly availableMigrations: readonly string[]
  readonly appliedMigrations: readonly string[]
}

/**
 * 按文件名执行尚未应用的 MySQL 迁移。
 *
 * GET_LOCK 避免多个 Server 同时修改结构。每个迁移文件只包含一条幂等 DDL，兼容 MySQL
 * 对 DDL 的隐式提交语义；DDL 成功后再记录版本，异常重试不会重复破坏结构。
 */
export async function runMySqlMigrations(pool: MySqlPool): Promise<MySqlMigrationResult> {
  const migrationsUrl = resolveMigrationsUrl()
  const client = await pool.connect()
  let lockAcquired = false

  try {
    const lock = await client.query<{ acquired: number | string }>(
      'SELECT GET_LOCK(?, 30) AS acquired',
      [MIGRATION_LOCK_NAME],
    )
    if (Number(lock.rows[0]?.acquired) !== 1)
      throw new Error('等待 MySQL 数据库迁移锁超时')
    lockAcquired = true

    await client.query(`
      CREATE TABLE IF NOT EXISTS craft_agent_schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
    `)

    const availableMigrations = (await readdir(migrationsUrl))
      .filter(filename => MIGRATION_FILENAME_PATTERN.test(filename))
      .sort((left, right) => left.localeCompare(right))
    const appliedMigrations: string[] = []

    for (const filename of availableMigrations) {
      const applied = await client.query<{ filename: string }>(`
        SELECT filename
        FROM craft_agent_schema_migrations
        WHERE filename = ?
        LIMIT 1
      `, [filename])
      if (applied.rows[0])
        continue

      const sql = (await readFile(new URL(filename, migrationsUrl), 'utf8')).trim()
      await client.query(sql)
      await client.query(`
        INSERT INTO craft_agent_schema_migrations (filename)
        VALUES (?)
      `, [filename])
      appliedMigrations.push(filename)
    }

    return Object.freeze({
      availableMigrations: Object.freeze(availableMigrations),
      appliedMigrations: Object.freeze(appliedMigrations),
    })
  }
  finally {
    if (lockAcquired) {
      await client.query('SELECT RELEASE_LOCK(?) AS released', [MIGRATION_LOCK_NAME])
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
