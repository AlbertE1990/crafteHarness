# sample MySQL 数据库

本目录是 sample 数据库结构的唯一事实源。数据库属于 `sample/` 后端应用，不属于
`craft-harness` npm 包；库只定义 `SessionStore` 契约，不限定数据库与表名。

## 初始化

先创建 MySQL 8.0 或兼容数据库和普通应用账号，并授予该账号目标库的建表、索引、外键和数据读写权限：

```sql
CREATE DATABASE craft_agent_dev
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

CREATE USER 'craft_agent'@'127.0.0.1' IDENTIFIED BY 'replace-with-a-strong-password';
GRANT ALL PRIVILEGES ON craft_agent_dev.* TO 'craft_agent'@'127.0.0.1';
```

实际 host 必须与应用连接来源一致。1Panel 创建数据库时可直接填写数据库名、用户名和密码，不要勾选超级用户。
随后配置 `sample/.env.local`：

```dotenv
CRAFT_AGENT_DATABASE_URL=mysql://craft_agent:URL_ENCODED_PASSWORD@127.0.0.1:3306/craft_agent_dev
```

密码中的 `@`、`:`、`/`、`#`、`%` 等字符必须进行 URL 编码。Server 会在监听 HTTP 端口前执行迁移；也可以手动运行：

```bash
pnpm --dir sample db:migrate
pnpm --dir sample db:check
```

迁移使用 MySQL `GET_LOCK` 串行化多个 Server 的启动。每个迁移文件只包含一条幂等 DDL，以适配 MySQL 的 DDL
隐式提交语义。迁移只创建或升级表，不会创建数据库或数据库用户。

## 表关系

```mermaid
erDiagram
  craft_agent_sessions ||--o{ craft_agent_session_events : contains
  craft_agent_sessions ||--o{ craft_agent_trace_events : traces
```

- `craft_agent_schema_migrations`：记录已应用的 SQL 文件。
- `craft_agent_sessions`：以 `(scope_id, session_id)` 为主键保存目录、名称、版本和元数据。
- `craft_agent_session_events`：保存 append-only Session Event；复合外键指向会话目录。
- `craft_agent_trace_events`：保存完整 Agent 轨迹；删除会话时由外键级联清理。

所有文本使用 `utf8mb4_unicode_ci`，名称搜索默认大小写不敏感。`catalog_order` 和 `trace_sequence` 使用
`AUTO_INCREMENT` 提供稳定游标；JavaScript 边界把 `BIGINT` 作为字符串接收并检查安全整数范围。

## 迁移历史

| 文件                            | 作用                          |
| ------------------------------- | ----------------------------- |
| `001-create-sessions.sql`       | 创建会话目录与目录索引        |
| `002-create-session-events.sql` | 创建 Session Event 与关联索引 |
| `003-create-trace-events.sql`   | 创建 Agent 轨迹表与关联索引   |

新增结构时追加下一个三位编号的 kebab-case SQL 文件，不要改写已经在共享数据库执行过的迁移。每个文件保持
单条、可重复执行的 DDL，并同步更新 Store、本文和数据库契约测试。
