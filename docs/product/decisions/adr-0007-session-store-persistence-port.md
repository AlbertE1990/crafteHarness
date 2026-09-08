# ADR-0007：外部持久化只通过 SessionStore Port 接入

- 文档类型：架构决策
- 状态：Accepted
- 日期：2026-09-08

## 背景

MemorySessionStore 已验证 append-only Session Log，但生产应用可能使用原生 SQL、ORM、远程 API 或已有业务
Service。若为每种方式向 Agent 增加初始化、保存、更新或连接方法，Core 会与基础设施生命周期耦合；若把 SQL
做成内置 Agent Tool，又会错误地把内部会话存储暴露给模型。

不同实现还必须对原子追加、乐观并发、一致分页和错误映射保持相同行为，否则替换 Store 会改变 Agent Loop
语义，仅靠 TypeScript 接口无法验证这些运行时约束。

## 决定

- `SessionStore.append/read/list` 是外部持久化的唯一运行时端口。
- 外部 Store 直接读写权威数据源，不先同步到 MemorySessionStore，也不提供覆盖式更新。
- 数据库连接、迁移、关闭、备份和历史导入属于 Runtime 或独立管理端口。
- SQL、ORM 和 API 类型及异常不能进入 Core；基础设施错误包装为带 operation 的
  `SESSION_OPERATION_FAILED`。
- `SessionCatalogStore` 表示明确提供 `list()` 的实现，同时保留 `SessionStore.list?` 兼容现有执行型 Store。
- 提供独立的 `sessions/testing` 入口和无测试框架契约探针，所有持久化实现必须运行。
- CraftAgent Core 不内置数据库 Store，也不提供可由模型调用的通用 SQL 工具。

## 备选方案

### 为 SQL、ORM 和 API 分别扩展 AgentConfig

配置直观，但会把连接参数、客户端类型和迁移策略带入统一 Agent 配置，并迫使 Core 持续理解新的基础设施。

### 从外部加载后继续使用 MemorySessionStore

实现简单，但形成两个事实源，跨进程写入、并发版本和新增事件同步都会漂移。

### 提供通用 SQL Agent Tool

可以让模型直接查询数据库，但与 Session 持久化无关，并引入权限、租户隔离、注入、数据泄露和写操作风险。
业务确有需要时应定义最小权限的领域工具。

### 只发布接口，不提供契约测试

编译可以通过，却无法证明事务原子性、固定快照分页、JSON 边界和错误码一致，第三方实现容易在运行中才暴露
协议差异。

## 后果

正面影响：

- Agent Loop 不关心数据来自数据库、ORM、Service 还是 API。
- Store 可以独立选择连接、迁移、事务和部署方式。
- 契约探针为不同实现建立相同的可执行验收标准。
- Session 数据库不会因为持久化需求而暴露给模型。

代价与限制：

- 实现方必须负责完整事务、序列化约束和供应商错误归一化。
- 契约探针会写入数据，需要隔离且可销毁的测试环境。
- 当前尚未随 Core 交付具体数据库实现；第一种实现确定后还需增加驱动专项测试。
