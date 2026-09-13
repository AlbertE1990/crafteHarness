import type {
  Pool as NativePool,
  PoolConnection as NativePoolConnection,
  PoolOptions,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import process from 'node:process'
import mysql from 'mysql2/promise'

const DEFAULT_POOL_MAX = 10

/** MySQL Runtime 配置；连接凭据只存在于 sample Server。 */
export interface MySqlRuntimeConfig {
  readonly connectionString: string
  readonly maxConnections: number
  readonly ssl: boolean
}

/** 数据库连通性检查返回的非敏感信息。 */
export interface MySqlConnectionInfo {
  readonly database: string
  readonly serverVersion: string
  readonly sessionsTableExists: boolean
  readonly eventsTableExists: boolean
}

export interface MySqlQueryResult<Row> {
  readonly rows: Row[]
  readonly rowCount: number
}

/** 对 mysql2 做一层结果归一化，让 Store 只依赖本案例自己的数据库端口。 */
export interface MySqlQueryable {
  query: <Row>(sql: string, values?: readonly unknown[]) => Promise<MySqlQueryResult<Row>>
}

export interface MySqlConnection extends MySqlQueryable {
  release: () => void
}

export interface MySqlPool extends MySqlQueryable {
  connect: () => Promise<MySqlConnection>
  end: () => Promise<void>
}

export function readMySqlRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MySqlRuntimeConfig {
  const connectionString = environment.CRAFT_AGENT_DATABASE_URL?.trim()
  if (!connectionString)
    throw new Error('缺少环境变量 CRAFT_AGENT_DATABASE_URL')

  const url = new URL(connectionString)
  if (url.protocol !== 'mysql:' && url.protocol !== 'mysql2:')
    throw new Error('CRAFT_AGENT_DATABASE_URL 必须使用 mysql:// 协议')
  if (!url.hostname || !url.pathname.slice(1))
    throw new Error('CRAFT_AGENT_DATABASE_URL 必须包含主机名和数据库名')

  const maxConnections = parsePoolMax(environment.CRAFT_AGENT_DATABASE_POOL_MAX)
  const ssl = parseBoolean(environment.CRAFT_AGENT_DATABASE_SSL, false)
  return Object.freeze({ connectionString, maxConnections, ssl })
}

export function createMySqlPool(config: MySqlRuntimeConfig): MySqlPool {
  const url = new URL(config.connectionString)
  const poolOptions: PoolOptions = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    connectionLimit: config.maxConnections,
    timezone: 'Z',
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    ...(config.ssl ? { ssl: {} } : {}),
  }
  return wrapPool(mysql.createPool(poolOptions))
}

/** 执行只读探针，确认连接和 Session Log 表均可用。 */
export async function inspectMySqlConnection(
  database: MySqlQueryable,
): Promise<MySqlConnectionInfo> {
  const result = await database.query<{
    database: string
    server_version: string
    sessions_table: number | string
    events_table: number | string
  }>(`
    SELECT
      DATABASE() AS database,
      VERSION() AS server_version,
      EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'craft_agent_sessions'
      ) AS sessions_table,
      EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'craft_agent_session_events'
      ) AS events_table
  `)
  const row = result.rows[0]
  if (!row)
    throw new Error('MySQL 连通性检查没有返回结果')

  return Object.freeze({
    database: row.database,
    serverVersion: row.server_version,
    sessionsTableExists: Number(row.sessions_table) === 1,
    eventsTableExists: Number(row.events_table) === 1,
  })
}

function wrapPool(pool: NativePool): MySqlPool {
  return {
    query: createQuery(pool),
    async connect() {
      return wrapConnection(await pool.getConnection())
    },
    async end() {
      await pool.end()
    },
  }
}

function wrapConnection(connection: NativePoolConnection): MySqlConnection {
  return {
    query: createQuery(connection),
    release() {
      connection.release()
    },
  }
}

function createQuery(database: NativePool | NativePoolConnection): MySqlQueryable['query'] {
  return async <Row>(sql: string, values: readonly unknown[] = []) => {
    const [result] = await database.query<RowDataPacket[] | ResultSetHeader>(sql, [...values])
    if (Array.isArray(result)) {
      return {
        rows: result as Row[],
        rowCount: result.length,
      }
    }
    return {
      rows: [],
      rowCount: result.affectedRows,
    }
  }
}

function parsePoolMax(value: string | undefined): number {
  if (value === undefined || value.trim() === '')
    return DEFAULT_POOL_MAX
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error('CRAFT_AGENT_DATABASE_POOL_MAX 必须是正整数')
  return parsed
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === '')
    return defaultValue
  if (value === 'true')
    return true
  if (value === 'false')
    return false
  throw new Error('CRAFT_AGENT_DATABASE_SSL 必须是 true 或 false')
}
