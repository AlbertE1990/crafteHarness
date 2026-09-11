import type { PoolClient, PoolConfig } from 'pg'
import process from 'node:process'
import { Pool } from 'pg'

const DEFAULT_POOL_MAX = 10

/** 创建 PostgreSQL 连接池时使用的 Runtime 配置。 */
export interface PostgresRuntimeConfig {
  readonly connectionString: string
  readonly maxConnections: number
  readonly ssl: boolean
}

/** 数据库连通性检查返回的非敏感信息。 */
export interface PostgresConnectionInfo {
  readonly database: string
  readonly serverVersion: string
  readonly sessionsTableExists: boolean
  readonly eventsTableExists: boolean
}

/**
 * 从 Runtime 环境变量读取 PostgreSQL 配置。
 *
 * CraftAgent Core 不调用本函数；数据库地址和密码只存在于 Server Runtime。
 */
export function readPostgresRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PostgresRuntimeConfig {
  const connectionString = environment.CRAFT_AGENT_DATABASE_URL?.trim()
  if (!connectionString)
    throw new Error('缺少环境变量 CRAFT_AGENT_DATABASE_URL')

  const maxConnections = parsePoolMax(environment.CRAFT_AGENT_DATABASE_POOL_MAX)
  const ssl = parseBoolean(environment.CRAFT_AGENT_DATABASE_SSL, false)
  return Object.freeze({ connectionString, maxConnections, ssl })
}

/** 创建由 Runtime 持有并负责关闭的 PostgreSQL 连接池。 */
export function createPostgresPool(config: PostgresRuntimeConfig): Pool {
  const poolConfig: PoolConfig = {
    connectionString: config.connectionString,
    max: config.maxConnections,
    application_name: 'craft-harness-sample-server',
    ...(config.ssl ? { ssl: { rejectUnauthorized: true } } : {}),
  }
  return new Pool(poolConfig)
}

/** 执行只读探针，确认连接和 Session Log 表均可用。 */
export async function inspectPostgresConnection(
  database: Pool | PoolClient,
): Promise<PostgresConnectionInfo> {
  const result = await database.query<{
    database: string
    server_version: string
    sessions_table: string | null
    events_table: string | null
  }>(`
    SELECT
      current_database() AS database,
      current_setting('server_version') AS server_version,
      to_regclass('public.craft_agent_sessions')::text AS sessions_table,
      to_regclass('public.craft_agent_session_events')::text AS events_table
  `)
  const row = result.rows[0]
  if (!row)
    throw new Error('PostgreSQL 连通性检查没有返回结果')

  return Object.freeze({
    database: row.database,
    serverVersion: row.server_version,
    sessionsTableExists: row.sessions_table !== null,
    eventsTableExists: row.events_table !== null,
  })
}

/** 将可选连接池上限转换为安全正整数。 */
function parsePoolMax(value: string | undefined): number {
  if (value === undefined || value.trim() === '')
    return DEFAULT_POOL_MAX
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('CRAFT_AGENT_DATABASE_POOL_MAX 必须是正整数')
  return parsed
}

/** 解析只允许 true/false 的 Runtime 布尔配置。 */
function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '')
    return defaultValue
  if (value === 'true')
    return true
  if (value === 'false')
    return false
  throw new Error('CRAFT_AGENT_DATABASE_SSL 必须是 true 或 false')
}
