import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process, { loadEnvFile } from 'node:process'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './postgres'

if (existsSync('.env.local'))
  loadEnvFile('.env.local')

const migrationUrl = new URL('../../../database/migrations/001-create-session-log.sql', import.meta.url)

/** 使用 Node PostgreSQL 驱动执行可重复的 Session Log 建表迁移。 */
async function main(): Promise<void> {
  const sql = await readFile(migrationUrl, 'utf8')
  const pool = createPostgresPool(readPostgresRuntimeConfig())
  try {
    await pool.query(sql)
    const info = await inspectPostgresConnection(pool)
    process.stdout.write(`PostgreSQL 迁移完成：${JSON.stringify(info, null, 2)}\n`)
  }
  finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('PostgreSQL 迁移失败：', error)
  process.exitCode = 1
})
