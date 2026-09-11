import { existsSync } from 'node:fs'
import process, { loadEnvFile } from 'node:process'
import {
  createPostgresPool,
  inspectPostgresConnection,
  readPostgresRuntimeConfig,
} from './postgres'

if (existsSync('.env.local'))
  loadEnvFile('.env.local')

/** 从 Node.js 验证本地数据库和两张 Session Log 表。 */
async function main(): Promise<void> {
  const pool = createPostgresPool(readPostgresRuntimeConfig())
  try {
    const info = await inspectPostgresConnection(pool)
    if (!info.sessionsTableExists || !info.eventsTableExists)
      throw new Error('Session Log 表尚未创建，请先运行 pnpm db:migrate')
    process.stdout.write(`PostgreSQL 连接正常：${JSON.stringify(info, null, 2)}\n`)
  }
  finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('PostgreSQL 检查失败：', error)
  process.exitCode = 1
})
