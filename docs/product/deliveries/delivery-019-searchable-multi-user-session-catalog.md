# Delivery 019：阶段 4.13 可搜索、多用户 Session Catalog

> 完成日期：2026-09-11。

## 交付结果

- `scopeId + sessionId` 成为完整 Session 身份；`invoke/stream/getSession/listSessions` 和 Store 读写不提供隐式
  scope，单用户参考 Runtime 显式传入 `default`。
- `sessionName` 成为 `session.created`、快照、摘要和 PostgreSQL 目录列的一等字段；目录 `search` 提供忽略
  大小写的字面子串匹配。
- MemorySessionStore 按 scope 分区；PostgresSessionStore 的所有锁定、读取、更新和列表 SQL 同时约束 scope，
  并允许不同 scope 使用相同 sessionId。
- 新增 002/003 数据库迁移：旧数据迁入 `default` scope，从 `metadata_json.name` 一次性回填名称，主外键升级为
  复合身份，并增加 scope 目录索引和 sessionName trigram 索引。
- 迁移器按编号执行未应用文件，通过 `craft_agent_schema_migrations` 记录版本，并使用 advisory lock 避免并发迁移。
- 应用自定义 owner、status 或分类字段继续使用应用自有投影表/Repository，不写入 CraftAgent 管理表。

## 验证

- `pnpm test -- --run`：19 个测试文件、123 个测试通过。
- `pnpm typecheck` 与 `pnpm typecheck:public-api` 通过。
- `pnpm db:migrate` 已成功升级本地 `craft_agent_dev`。
- `pnpm db:check` 通过，数据库为 PostgreSQL 18.6。
- `pnpm db:test-store` 在隔离临时 schema 中通过完整契约、并发追加和重启恢复验证，测试结束后自动清理。

## 已知边界

- `scopeId` 是数据分区键，不是授权证明；Runtime 仍须使用当前认证身份与权限服务做访问控制。
- 当前 sessionName 是创建事实，尚未支持重命名；未来需使用新事件和原子目录投影，不能覆盖历史。
- 标准搜索只覆盖 sessionName；复杂业务条件属于应用投影或专用搜索服务。

设计依据见[ADR-0010](../decisions/adr-0010-searchable-multi-user-session-catalog.md)，当前协议见
[Agent 门面协议](../../standards/protocols/agent.md)和[Session Log 协议](../../standards/protocols/session-log.md)。
