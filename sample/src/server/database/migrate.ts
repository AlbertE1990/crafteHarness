import { existsSync } from 'node:fs'
import process, { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import { runMySqlMigrations } from './migrations'
import {
  createMySqlPool,
  inspectMySqlConnection,
  readMySqlRuntimeConfig,
} from './mysql'

const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url))
if (existsSync(envFile))
  loadEnvFile(envFile)

/** 按文件名顺序执行尚未应用的数据库迁移，并记录版本。 */
async function main(): Promise<void> {
  const pool = createMySqlPool(readMySqlRuntimeConfig())
  try {
    const migration = await runMySqlMigrations(pool)
    const info = await inspectMySqlConnection(pool)
    process.stdout.write(`MySQL 迁移完成：${JSON.stringify({ migration, database: info }, null, 2)}\n`)
  }
  finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('MySQL 迁移失败：', error)
  process.exitCode = 1
})
