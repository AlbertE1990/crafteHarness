# 阶段 4.3：SessionStore 持久化契约

- 文档类型：交付记录
- 状态：代码、测试和文档已完成
- 日期：2026-09-08

## 本阶段目标

在不绑定数据库、ORM 或 API 的前提下，把 SessionStore 完善为可执行验证的外部持久化端口，为后续具体
Store 实现提供事务、错误和测试基线。

## 实际完成

- 新增 `SessionCatalogStore`，为实现 `list()` 的 Store 提供明确能力类型。
- 新增 `SESSION_OPERATION_FAILED` 和 `SessionStoreOperation`，统一外部基础设施错误。
- Agent 错误投影保留失败操作名称，Store 故障稳定归类为 `session_error`。
- 新增独立 `sessions/testing` 入口和 `assertSessionStoreContract()`。
- 契约探针覆盖空会话、初始化、序列化、原子写入、版本冲突、事件信封、固定快照和目录分页。
- Session Log 规范新增外部 Adapter、SQL 事务、远程 API 幂等、生命周期边界和专项测试要求。
- 学习文档新增 PostgreSQL 表结构、事务、分页、用户 metadata、契约测试及无数据库调试教程，并明确不使用
  通用 SQL Agent Tool。

## 验证范围

- MemorySessionStore 通过完整目录契约。
- 不带 `list()` 的执行型 Store 通过基础契约，并在要求目录能力时失败。
- 外部操作错误在模型调用前被归类为 Session 错误并携带 operation。
- 全量测试、类型检查、Lint、构建和文档链接检查。

## 后续范围

- 根据实际部署选型实现第一个 SQL、ORM 或 API SessionStore。
- 为具体驱动补充事务回滚、并发、断连、超时和幂等专项测试。
- 轨迹持久化继续使用独立 TraceStore 或 TraceSink，不写入 Session 模型事实。
