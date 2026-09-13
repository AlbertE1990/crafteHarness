# 持久化 SessionStore：从内存调试到 PostgreSQL

> 文档类型：学习教程；示例数据库：PostgreSQL；适用范围：Node.js Runtime。

## 1. 学习目标

完成本教程后，你应该能够：

- 判断何时使用 `MemorySessionStore`，何时必须接入持久化 Store。
- 为 append-only Session Log 设计关系数据库表。
- 正确实现原子追加、乐观并发和固定版本分页。
- 将数据库异常转换为 craft-harness 的稳定错误。
- 使用契约探针验证自己的 Store。
- 在不修改 craft-harness 用户模型的前提下保存 `userId`、`tenantId` 等应用字段。

前置阅读：

- [Session Log 学习指南](./session-log.md)
- [Session Log 协议](../standards/protocols/session-log.md)
- [外部持久化 ADR](../product/decisions/adr-0007-session-store-persistence-port.md)

## 2. 先明确边界

craft-harness 只定义会话存储的行为，不负责数据库连接和用户系统：

```text
HTTP / CLI / Worker Runtime
  ├── 身份认证、权限判断、连接池生命周期
  ├── 构造应用自己的 SessionStore
  └── new Agent({ model, sessionStore: store })
                         │
                         ▼
                    AgentLoop
                         │
                         ▼
                  SessionStore Port
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
       PostgreSQL / ORM       业务 Service / API
```

Store 不是模型工具。模型不能选择数据库、拼接 SQL，也不能直接修改 Session 历史。

## 3. 是否应该删除 MemorySessionStore

不应该。`MemorySessionStore` 有三个明确用途：

- 让 `new Agent({ model })` 可以零数据库启动。
- 为单元测试和学习示例提供确定性实现。
- 作为第三方 Store 的协议行为参考。

它不是生产持久化方案：数据只存在于当前 Node.js 进程，重启后全部丢失，而且默认不会过期或驱逐 Session。
长期运行的服务应显式注入持久化 Store。craft-harness 不在内存实现中加入 LRU、TTL、落盘或分布式同步；这些属于
具体存储实现的选择。

无数据库调试可以直接使用默认值：

```ts
import Agent from 'craft-harness'

const agent = new Agent({ model })
```

需要直接观察事件时，可以显式创建 Store：

```ts
import Agent, { MemorySessionStore } from 'craft-harness'

const store = new MemorySessionStore()
const agent = new Agent({ model, sessionStore: store })

await agent.invoke({ scopeId: 'default', sessionId: 'learning-session', input: '你好' })
console.dir(await store.read({ scopeId: 'default', sessionId: 'learning-session' }), { depth: null })
```

## 4. 必须实现的协议

只执行 Agent，需要实现 `SessionStore`：

```ts
interface SessionStore {
  append: (request: AppendSessionEventsRequest) => Promise<AppendSessionEventsResult>
  read: (request: ReadSessionEventsRequest) => Promise<SessionEventPage>
}
```

还要支持 `agent.listSessions()`，则实现 `SessionCatalogStore`：

```ts
interface SessionCatalogStore extends SessionStore {
  list: (options: ListSessionsOptions) => Promise<SessionListPage>
}
```

这里的重点不是方法名称，而是以下不变量：

- 一个 Session 的 `sequence` 从 1 开始，严格递增且没有空洞。
- 一批 `append()` 要么全部成功，要么完全不写入。
- `expectedVersion` 必须与数据库当前版本相等。
- 首次批次必须以唯一的 `session.created` 开始。
- 返回事件必须是可序列化的 JSON 数据，不能保留调用方对象引用。
- 多页读取必须固定 `throughVersion`，不能混入翻页期间新增的事件。

## 5. PostgreSQL 表结构

craft-harness 的 ID 是字符串，教程使用 `text`，不强制调用方只能使用 UUID。`bigint` 可以承载长期增长的版本和
序号；Node.js 驱动通常把 PostgreSQL `bigint` 返回为字符串，转换为 `number` 时必须检查
`Number.isSafeInteger()`。

### 5.1 Session 目录表

```sql
CREATE TABLE craft_agent_sessions (
  scope_id      text NOT NULL,
  session_id    text NOT NULL,
  session_name  text,
  catalog_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  version       bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  metadata_json jsonb,
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (scope_id, session_id)
);

CREATE INDEX craft_agent_sessions_scope_catalog_idx
  ON craft_agent_sessions (scope_id, catalog_order);
```

字段说明：

| 字段            | 用途                                                                     |
| --------------- | ------------------------------------------------------------------------ |
| `scope_id`      | Runtime 显式提供的持久化分区键。                                         |
| `session_id`    | scope 内的 Session ID，与 scope 共同构成事件表外键。                     |
| `session_name`  | 标准可搜索名称；不再从 metadata JSON 路径查询。                          |
| `catalog_order` | 稳定的创建顺序，用于实现 `list()` 游标分页。事务回滚造成空洞不影响语义。 |
| `version`       | 当前最后一个事件的 sequence；新 Session 初始为 0。                       |
| `metadata_json` | `session.created.metadata` 的目录投影。                                  |
| `created_at`    | 首次创建时间。                                                           |
| `updated_at`    | 最近一次成功追加时间。                                                   |

### 5.2 Session 事件表

```sql
CREATE TABLE craft_agent_session_events (
  scope_id    text NOT NULL,
  session_id  text NOT NULL,
  sequence    bigint NOT NULL CHECK (sequence > 0),
  event_id    text NOT NULL UNIQUE,
  event_type  varchar(64) NOT NULL,
  run_id      text,
  turn_id     text,
  payload_json jsonb NOT NULL,
  created_at  timestamptz NOT NULL,
  PRIMARY KEY (scope_id, session_id, sequence),
  FOREIGN KEY (scope_id, session_id)
    REFERENCES craft_agent_sessions(scope_id, session_id)
);

CREATE INDEX craft_agent_session_events_run_idx
  ON craft_agent_session_events (run_id)
  WHERE run_id IS NOT NULL;
```

`payload_json` 保存事件特有字段：

- `session.created`：`sessionName` 和 `metadata`。
- `message.appended`：`message`。
- `turn.failed`：`error`。
- `turn.cancelled`：`reason`。

`eventId`、`scopeId`、`sessionId`、`sequence`、`timestamp` 和 `type` 已有稳定列，不必再次复制进 payload。读取时将列与
payload 合并成 `SessionEvent`。

不要建立可变的 `messages` 表作为第二份权威历史。模型消息应继续从 `message.appended` 事件确定性推导。

## 6. append() 的事务流程

一次追加必须位于同一个数据库事务：

```mermaid
flowchart TD
  Begin[BEGIN] --> Validate[校验请求和事件顺序]
  Validate --> Ensure[创建或锁定 Session 行]
  Ensure --> Compare{version = expectedVersion?}
  Compare -- 否 --> Conflict[回滚并抛出版本冲突]
  Compare -- 是 --> Allocate[分配连续 sequence、eventId、timestamp]
  Allocate --> Insert[批量插入事件]
  Insert --> Update[更新 Session version 与 updated_at]
  Update --> Commit[COMMIT]
```

关键 SQL 结构如下，具体占位符和批量插入方式由数据库驱动决定：

```sql
BEGIN;

-- 新 Session 可以先 INSERT ... ON CONFLICT DO NOTHING，随后统一加行锁。
SELECT version
FROM craft_agent_sessions
WHERE scope_id = $1 AND session_id = $2
FOR UPDATE;

-- 应用代码比较 version 和 expectedVersion。

INSERT INTO craft_agent_session_events (
  scope_id, session_id, sequence, event_id, event_type,
  run_id, turn_id, payload_json, created_at
)
VALUES (...), (...);

UPDATE craft_agent_sessions
SET version = $3,
    updated_at = $4
WHERE scope_id = $1 AND session_id = $2;

COMMIT;
```

不能先更新 `version` 再在另一个事务写事件，也不能用 Node.js 进程锁代替数据库行锁。多实例部署时只有数据库
事务或等价的 compare-and-swap 才能保护版本。

版本不一致时应抛出：

```ts
throw new SessionStoreError({
  code: 'SESSION_VERSION_CONFLICT',
  message: `Session ${sessionId} 版本冲突`,
  sessionId,
  expectedVersion: request.expectedVersion,
  actualVersion,
})
```

## 7. read() 的固定快照分页

第一次读取没有 `throughVersion` 时：

1. 查询 Session 当前 `version`，记为 `snapshotVersion`。
2. 只读取 `sequence <= snapshotVersion` 的事件。
3. 多取一条判断 `hasMore`。

```sql
SELECT sequence, event_id, event_type, run_id, turn_id,
       payload_json, created_at
FROM craft_agent_session_events
WHERE scope_id = $1
  AND session_id = $2
  AND sequence > $3
  AND sequence <= $4
ORDER BY sequence ASC
LIMIT $5;
```

后续页面必须继续使用第一页返回的 `snapshotVersion` 作为 `throughVersion`。`latestVersion` 可以反映数据库
此刻的新版本，但页面不能把新增事件混入旧快照。

不存在的 Session 应返回零版本空页，不应该把普通“未创建”映射为数据库异常：

```ts
const emptyPage = {
  scopeId,
  sessionId,
  snapshotVersion: 0,
  latestVersion: 0,
  events: [],
  hasMore: false,
  nextAfterSequence: 0,
}
```

## 8. list() 的稳定目录分页

当前协议使用上一页最后一个 `sessionId` 作为游标。数据库实现应在指定 scope 内先查询该 Session 的
`catalog_order`；游标不存在时抛出 `SESSION_INVALID_ARGUMENT`，未提供游标时使用 0。随后读取后续条目：

```sql
SELECT scope_id, session_id, session_name, version, metadata_json, created_at
FROM craft_agent_sessions
WHERE scope_id = $1
  AND catalog_order > $2
  AND ($3::text IS NULL OR session_name ILIKE '%' || $3 || '%')
ORDER BY catalog_order ASC
LIMIT $4;
```

和事件分页一样，可以多取一条计算 `hasMore`。返回给 craft-harness 的 `createdAt` 必须是 ISO 8601 字符串。

## 9. 实现骨架

数据库驱动、ORM 和事务 API 各不相同，因此 craft-harness 不提供绑定 `pg` 的基类。应用实现的结构通常如下：

```ts
import type {
  AppendSessionEventsRequest,
  AppendSessionEventsResult,
  ListSessionsOptions,
  ReadSessionEventsRequest,
  SessionCatalogStore,
  SessionEventPage,
  SessionListPage,
} from 'craft-harness'
import { SessionStoreError } from 'craft-harness'

/** 使用应用连接池实现的 PostgreSQL Session Store。 */
export class PostgresSessionStore implements SessionCatalogStore {
  constructor(private readonly database: AppDatabase) {}

  /** 在单个事务内执行版本比较、批量插入和版本推进。 */
  async append(
    request: AppendSessionEventsRequest,
  ): Promise<AppendSessionEventsResult> {
    try {
      return await this.database.transaction(async (transaction) => {
        // 1. 校验输入与初始化事件。
        // 2. 创建或 SELECT ... FOR UPDATE 锁定 Session。
        // 3. 比较 expectedVersion。
        // 4. 批量插入连续事件。
        // 5. 更新 version 并返回数据库实际保存的事件。
        return await appendSessionEvents(transaction, request)
      })
    }
    catch (error) {
      if (error instanceof SessionStoreError)
        throw error
      throw new SessionStoreError({
        code: 'SESSION_OPERATION_FAILED',
        message: 'Session 事件写入失败',
        sessionId: request.sessionId,
        operation: 'append',
        cause: error,
      })
    }
  }

  /** 从数据库直接读取固定版本事件页，不复制到 MemorySessionStore。 */
  async read(request: ReadSessionEventsRequest): Promise<SessionEventPage> {
    try {
      return await readSessionEventPage(this.database, request)
    }
    catch (error) {
      if (error instanceof SessionStoreError)
        throw error
      throw new SessionStoreError({
        code: 'SESSION_OPERATION_FAILED',
        message: 'Session 事件读取失败',
        sessionId: request.sessionId,
        operation: 'read',
        cause: error,
      })
    }
  }

  /** 按稳定创建顺序读取 Session 目录。 */
  async list(options: ListSessionsOptions): Promise<SessionListPage> {
    try {
      return await listSessionPage(this.database, options)
    }
    catch (error) {
      if (error instanceof SessionStoreError)
        throw error
      throw new SessionStoreError({
        code: 'SESSION_OPERATION_FAILED',
        message: 'Session 目录读取失败',
        operation: 'list',
        cause: error,
      })
    }
  }
}
```

示例中的 `AppDatabase`、`appendSessionEvents()`、`readSessionEventPage()` 和 `listSessionPage()` 由应用根据
`pg`、Prisma、Drizzle、TypeORM 或已有数据库 Service 实现。不要让这些类型进入 craft-harness Core。

## 10. sessionMetadata、context 与多用户数据

craft-harness 当前不定义 `User`、`Role`、`Tenant` 或权限协议。`sessionMetadata` 是新 Session 的持久化 JSON
创建信息；`context` 是每次调用的临时执行依赖。一个多用户 Runtime 通常会同时使用二者：

```ts
await agent.invoke({
  scopeId: authenticatedUser.tenantId,
  input: '你好',
  sessionName: '第一次对话',
  sessionMetadata: {
    // 仅作为 JSON 安全的创建事实；标准目录不会按这些字段查询。
    ownerUserId: authenticatedUser.id,
    tenantId: authenticatedUser.tenantId,
    source: 'web',
  },
  context: {
    // 当前请求重新读取的可信身份和权限，不从 metadata 恢复。
    user: authenticatedUser,
    permissions: await permissionService.listFor(authenticatedUser.id),
    userService,
  },
})
```

当前消费者如下：

| 数据              | 是否持久化 | 当前消费者                                                |
| ----------------- | ---------- | --------------------------------------------------------- |
| `sessionMetadata` | 是         | `session.created`、Store、Session 摘要/详情、Runtime 投影 |
| `context`         | 否         | 工具级 Guard、`tools.guard`、工具 `execute()`             |

继续已有 Session 时，新的 `sessionMetadata` 不会更新创建事件。需要记录可变资料时，应在业务表维护，或先定义新的
Session 事件和投影规则；不能覆盖 append-only 日志。用户名通常会变化，也可能包含个人信息，所以目录归属应使用
稳定用户 ID，展示时查询最新用户名。只有确实需要“创建时用户名快照”时才放入 metadata。

Store 把 metadata 原样保存在 craft-harness 管理的 `metadata_json`。业务需要更多可查询字段时，不应继续修改
`craft_agent_sessions`，而应建立应用自己拥有的投影表，并以完整 Session 身份关联：

```sql
CREATE TABLE app_session_catalog (
  scope_id text NOT NULL,
  session_id text NOT NULL,
  owner_user_id text NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (scope_id, session_id),
  FOREIGN KEY (scope_id, session_id)
    REFERENCES craft_agent_sessions(scope_id, session_id)
);

CREATE INDEX craft_agent_sessions_app_user_idx
  ON app_session_catalog (owner_user_id, status);
```

这张表的迁移、写入时机和查询方法都由应用负责，craft-harness 无需为每个业务需求增加标准列。具体 Repository
或 Store 扩展还可以公开 Agent 不使用的业务方法：

```ts
/** 应用 Store 可以在标准协议之外提供用户会话查询。 */
class AppSessionStore implements SessionCatalogStore {
  // append/read/list 供 craft-harness 使用。

  async listByUser(scopeId: string, userId: string) {
    // 供 Fastify、管理后台或业务 Service 使用。
  }

  async assertUserAccess(scopeId: string, userId: string, sessionId: string) {
    // 权限规则由应用决定，不由 Agent 或模型决定。
  }
}
```

不要直接相信请求体中的 `userId`。Runtime 应先完成身份认证，再把可信身份写入 metadata 或交给业务 Store。
Session 所有者变更、成员管理和权限判断也不应该通过 Agent 对话修改。

### 10.1 为什么 sessionName 已成为标准字段

`sessionName` 已从 metadata 提升为 `session.created`、`SessionSummary` 和目录表的标准字段。
`ListSessionsOptions.search` 在同一 scope 内按名称执行忽略大小写的字面子串匹配；PostgreSQL 参考实现使用
`session_name` 和 trigram 索引，Memory Store 提供相同可观察语义。旧 `metadata_json.name` 只在 002 迁移中
一次性回填，之后不再是名称权威源。

当前尚未支持重命名。需要时应增加 `session.renamed` 事实并在同一 Store 原子操作中更新目录投影，不能覆盖
`session.created`，也不能同时把 metadata 和独立列作为两个权威源。

### 10.2 多用户目录的当前协议

通用库不应理解应用的完整 User 对象，但目录需要一个由可信 Runtime 生成的稳定作用域，例如 `scopeId`。它可
表示个人、租户、团队或项目空间。所有 `invoke/stream/get/list` 都必须由调用方在请求中携带作用域，
不在 AgentConfig 中增加默认值或模式配置。单用户 Runtime 统一传固定值（例如 `default`），多用户 Runtime
根据可信认证结果组装。数据库中至少建立
`(scope_id, catalog_order)` 索引；名称搜索使用独立 `session_name` 列及适合目标数据库和语言的索引。

`scopeId` 只负责数据分区，不代替授权。Runtime 仍应根据当前 context 验证用户是否能访问该作用域；数据库
查询必须同时约束 scope 和 sessionId，避免先全局读取再在内存过滤。设计决策见
[ADR-0010](../product/decisions/adr-0010-searchable-multi-user-session-catalog.md)。

## 11. 运行契约测试

实现完成后，必须对隔离数据库运行 craft-harness 的契约探针：

```ts
import { assertSessionStoreContract } from '../../test/support/session-store-contract'

await assertSessionStoreContract(store, {
  sessionIdPrefix: `postgres-test-${Date.now()}`,
  requireCatalog: true,
})
```

探针会真实写入多个 Session，而且协议没有删除方法。测试应使用临时数据库、临时 schema、事务夹具或测试容器，
不能连接生产库。

`test/support` 是本仓库的测试支持目录，不是 craft-harness 公共子路径。项目外开发者应将协议中的行为清单写成
自己测试框架下的契约测试，而不是让生产代码依赖 craft-harness 的内部测试夹具。

通用探针之外，SQL Store 还应测试：

- 两个连接并发追加同一版本时，只允许一个成功。
- 任一事件插入失败时，Session version 和整批事件都回滚。
- `bigint` 超出 JavaScript 安全整数时明确失败。
- 驱动断连、超时和唯一约束异常映射为正确错误码。
- metadata 与事件 payload 的 JSON 序列化边界。
- 多页读取期间发生新追加时，固定快照不漂移。
- 不同 scope 使用相同 sessionId 时，读取、写入与目录搜索仍完全隔离。

## 12. 持久化不等于上下文压缩

数据库 Store 解决进程内常驻数据增长和重启丢失，但不会自动降低模型上下文：当前 Agent 仍会从 Session 事件
推导完整模型历史。长期会话还需要未来的 ContextBuilder 或摘要投影，根据 token 预算组合“历史摘要 + 最近完整
Turn”，同时继续保留数据库中的完整事件事实。

在该能力实现前，应用应设置合理的 Session 生命周期和 Agent token 预算，不要通过删除中间 Tool Call、只保留
最后几条消息等方式破坏历史结构。

## 13. 本项目的 PostgreSQL 参考实现

本地已经创建 PostgreSQL 数据库 `craft_agent_dev`，其中包含：

- `craft_agent_sessions`
- `craft_agent_session_events`

参考实现全部位于官方案例 `sample/`（库只定义协议，不绑定数据库驱动）：

```text
sample/database/migrations/001-create-session-log.sql
sample/database/migrations/002-add-session-scope-and-name.sql
sample/database/migrations/003-use-composite-session-identity.sql
sample/src/server/database/postgres.ts
sample/src/server/database/migrations.ts
sample/src/server/database/migrate.ts
sample/src/server/database/check.ts
sample/src/server/stores/postgres-session-store.ts
sample/test/postgres-session-store.contract.ts
```

先将 `sample/.env.example` 中的数据库配置复制到被 Git 忽略的 `sample/.env.local`，并填写本地真实密码。
首次启动 sample Server 会自动执行迁移；也可以在部署或调试时显式运行：

```bash
pnpm --dir sample db:migrate
pnpm --dir sample db:check
pnpm --dir sample db:test-store
```

迁移器按文件名执行尚未记录的迁移，并写入 `craft_agent_schema_migrations`；连接检查只输出数据库名、PostgreSQL
版本和表是否存在，不输出连接字符串或密码。完整字段、索引、外键和迁移规则见
[sample 数据库文档](../../sample/database/README.md)。
契约命令会创建独立临时 schema，验证完成后自动删除，不会把测试 Session 写进开发目录。

### 13.1 当前实现的阅读顺序

[postgres-session-store.ts](../../sample/src/server/stores/postgres-session-store.ts) 是可运行的 `pg` 参考实现。建议按数据流
而不是按文件行号阅读：

1. 从 `read()` 观察“数据库行 → SessionEvent → 固定快照页”。
2. 阅读 `list()`，比较摘要目录为何不查询事件表。
3. 阅读 `append()` 的 `BEGIN → INSERT/锁行 → 比较版本 → 插入事件 → 更新版本 → COMMIT`。
4. 阅读 `createEventPayload()` 与 `restoreEvent()`，理解列和 JSON payload 如何组合为判别联合。
5. 阅读契约测试中的并发探针，观察两个相同 `expectedVersion` 为什么只能成功一个。

你最值得亲手完成的验证是：在页面连续进行 10 轮对话，停止并重启 Node 服务，再进行第 11 轮；随后直接查询
两张表，对照 `version`、`sequence`、`turn_id` 和 `payload_json`。原始学习草稿保存在
`docs/learning/drafts/postgres-session-store-attempt.ts.txt`，可以与正式实现逐段比较。

实现过程中优先使用以下现有代码作为行为参考：

- [memory-session-store.ts](../../src/sessions/memory-session-store.ts)：事件校验、分页结果和错误语义。
- [session-store-contract.ts](../../test/support/session-store-contract.ts)：本仓库 Store 必须通过的内部行为断言。
- [Session Log 协议](../standards/protocols/session-log.md)：持久化不变量。

## 14. 完成检查表

- [x] Runtime 管理数据库连接池，craft-harness 只接收 Store 对象。
- [x] `append()` 在一个事务中完成全部写入和版本推进。
- [x] 数据库约束保证 `(scope_id, session_id, sequence)` 与 `event_id` 唯一。
- [x] `read()` 支持固定 `throughVersion` 分页。
- [x] `list()` 使用稳定创建顺序，而不是易变化的更新时间。
- [x] `scopeId` 在读写和目录查询中必填，并允许不同 scope 使用相同 sessionId。
- [x] `sessionName` 使用独立列和索引，支持标准大小写不敏感子串搜索。
- [x] 驱动异常被包装为 `SessionStoreError`，公开消息不泄露 SQL 和连接信息。
- [x] 用户字段属于应用扩展，不进入 craft-harness 用户或权限模型。
- [x] Store 已通过契约探针和数据库专项并发测试。
- [x] Server Agent 显式注入持久化 Store，不依赖默认内存数据。
