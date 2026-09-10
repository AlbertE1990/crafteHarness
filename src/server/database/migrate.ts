import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import process, { loadEnvFile } from 'node:process'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './postgres'

if (existsSync('.env.local'))
  loadEnvFile('.env.local')

const migrationsUrl = new URL('../../../database/migrations/', import.meta.url)

/** 按文件名顺序执行尚未应用的数据库迁移，并记录版本。 */
async function main(): Promise<void> {
  const pool = createPostgresPool(readPostgresRuntimeConfig())
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS craft_agent_schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await client.query(`SELECT pg_advisory_lock(hashtext('craft_agent_schema_migrations'))`)

    const filenames = (await readdir(migrationsUrl))
      .filter(filename => /^\d+-[a-z0-9-]+\.sql$/i.test(filename))
      .sort((left, right) => left.localeCompare(right))

    for (const filename of filenames) {
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
      }
      catch (error) {
        await client.query('ROLLBACK')
        throw error
      }
    }

    // 复用持有 advisory lock 的连接，避免连接池上限为 1 时再次借连接而等待。
    const info = await inspectPostgresConnection(client)
    process.stdout.write(`PostgreSQL 迁移完成：${JSON.stringify(info, null, 2)}\n`)
  }
  finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('craft_agent_schema_migrations'))`)
      .catch(() => undefined)
    client.release()
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('PostgreSQL 迁移失败：', error)
  process.exitCode = 1
})
