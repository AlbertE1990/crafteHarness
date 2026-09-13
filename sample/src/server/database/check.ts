import { existsSync } from 'node:fs'
import process, { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import {
  createMySqlPool,
  inspectMySqlConnection,
  readMySqlRuntimeConfig,
} from './mysql'

const envFile = fileURLToPath(new URL('../../../.env.local', import.meta.url))
if (existsSync(envFile))
  loadEnvFile(envFile)

/** 从 Node.js 验证本地数据库和两张 Session Log 表。 */
async function main(): Promise<void> {
  const pool = createMySqlPool(readMySqlRuntimeConfig())
  try {
    const info = await inspectMySqlConnection(pool)
    if (!info.sessionsTableExists || !info.eventsTableExists)
      throw new Error('Session Log 表尚未创建，请启动 sample Server 或运行 pnpm db:migrate')
    process.stdout.write(`MySQL 连接正常：${JSON.stringify(info, null, 2)}\n`)
  }
  finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('MySQL 检查失败：', error)
  process.exitCode = 1
})
