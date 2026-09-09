# 阶段 4.6：会话读模型与 PostgreSQL Store

- 文档类型：交付记录
- 状态：代码、数据库契约和文档已完成
- 日期：2026-09-09

## 本阶段目标

将会话目录和详情拆成不同读模型，避免对话数量增长后列表查询加载全部历史；同时完成 PostgreSQL
SessionStore，让 Server 重启后仍能从持久层恢复下一轮模型上下文。

## 实际完成

- `Agent.listSessions()` 直接返回 Store 摘要页，不再为每个会话调用 `read()`。
- `Agent.getSession()` 的消息详情保留 `eventId`、`sequence`、`timestamp`、`runId` 和 `turnId`。
- Server 列表接口只返回目录字段，详情接口按 `sessionId` 加载消息。
- 新会话标题写入 Session metadata，目录查询不需要扫描第一条用户消息。
- PostgreSQL `append()` 使用事务、行锁和乐观版本检查实现整批原子追加。
- PostgreSQL `read()` 实现固定版本分页，`list()` 使用 `catalog_order` 稳定分页。
- Runtime 持有连接池生命周期并把 Store 注入 Agent；Store 模块不在 import 时创建全局连接。
- 数据库契约测试使用临时 schema，结束后自动清理，不污染开发会话。
- 学习者原始实现草稿保存在 `docs/learning/drafts`，可用于对照学习。

## 验证范围

- 离线测试证明目录查询不会触发 `SessionStore.read()`。
- Server 与页面测试覆盖“摘要列表 → 按需详情 → 继续对话”。
- PostgreSQL 18.6 上迁移、连通性检查和完整 SessionStore 契约通过。
- 全量类型检查、Lint、单元测试和构建通过。

## 已知限制

- 数据库存储完整事实，但模型上下文仍会加载完整消息历史；长期会话压缩属于后续 ContextBuilder。
- 用户、租户与权限仍由应用 Runtime 和自定义 Store 扩展负责。
- 原始异常通过 `cause` 保留；统一 DiagnosticSink 和安全日志输出仍在异常诊断阶段实现。
