# ADR-0010：建立可搜索、可隔离的多用户 Session Catalog

> 状态：Accepted；日期：2026-09-10；实现：2026-09-11。

## 背景

阶段 4.13 之前，Runtime 把会话标题保存在 `session.created.metadata.name`，PostgreSQL 将 metadata 投影到
`craft_agent_sessions.metadata_json`。这足以展示标题，但标准 `SessionCatalogStore.list()` 只能按创建顺序
分页，不能搜索、按用户隔离或重命名。

数据库虽然可以搜索 JSONB，却无法让 Memory、SQL、ORM 和远程 API Store 获得一致的字段校验、索引、排序、
分页和更新语义。名称是可变的当前目录状态，而 `session.created.metadata` 是不可变创建事实。多用户服务继续
使用全局 `list/get` 还可能造成跨租户枚举或 IDOR 风险。

## 决策

- 将 `sessionName` 提升为标准 Session 字段，进入创建事件、`SessionSummary` 和持久化目录的独立
  `session_name` 列；`sessionMetadata` 继续作为不透明 JSON 扩展。
- 当前名称是 `session.created` 的不可变创建事实。重命名尚未实现；需要时必须新增 `session.renamed` 事件，并在
  同一 Store 原子追加中更新目录投影。
- 为目录增加不解释业务身份的稳定 `scopeId`。Runtime 可将其映射到个人、租户、团队或项目空间，Core 不保存
  User、Role 或权限对象。
- 不为 `AgentConfigInput` 增加 scope 配置。`invoke/stream/get/list` 的调用方必须在当前请求中组装
  `scopeId`；数据库查询同时约束 scope 与 sessionId，禁止读取全局结果后在进程内过滤。
- 单用户 Runtime 也显式传递固定值（例如 `default`），多用户 Runtime 从可信认证和业务路由中确定作用域。
  CraftAgent 不设置隐式回退值，避免漏传被误认为默认空间。
- 当前认证身份、权限和 Service 继续放在每次请求的 `context`。`scopeId` 是持久化分区键，不是授权证明；
  Runtime 必须先验证当前主体可以访问该 scope。
- 所有者使用应用稳定 ID，不使用可变用户名作为关联键。复杂共享、成员和角色关系保留在应用权限表中。

## 查询协议

已采用的查询协议如下：

```ts
interface AgentRequest<TContext> {
  scopeId: string
  sessionId?: string
  sessionName?: string
  sessionMetadata?: JsonObject
  input: string
  context: TContext
}

interface ListSessionsOptions {
  scopeId: string
  search?: string
  afterSessionId?: string
  limit?: number
}

interface SessionSummary {
  sessionId: string
  sessionName?: string
  scopeId: string
  createdAt: string
  version: number
  metadata?: JsonObject
}
```

`search` 是忽略大小写的字面子串匹配，排序继续使用稳定创建顺序，游标是当前 scope 内上一页最后一个
`sessionId`。PostgreSQL 使用 trigram 索引，Memory Store 提供相同可观察语义；供应商 SQL 细节不进入 Core 类型。

单用户应用可以在自己的 Runtime 边界集中组装，避免页面或业务代码重复硬编码：

```ts
const SINGLE_USER_SCOPE_ID = 'default'

await agent.invoke({
  ...request,
  scopeId: SINGLE_USER_SCOPE_ID,
})
```

## 数据库实现

目录表增加 `scope_id` 和 `session_name`，至少建立 `(scope_id, catalog_order)` 索引。名称搜索必须使用适合目标
数据库、语言和匹配方式的独立索引；若 PostgreSQL 使用 `ILIKE '%keyword%'`，可评估 `pg_trgm`，不能假设普通
B-tree 会加速任意子串搜索。

应用以后需要 owner、status、业务分类等额外查询字段时，应建立应用自己管理的投影表或 Repository，并用
`scopeId + sessionId` 关联，不继续给 CraftAgent 管理的目录表增加业务列。

## 后果

常用目录字段可获得稳定类型、查询契约和索引，metadata 不再承担搜索与授权职责。代价是需要数据库迁移、Store
契约升级、Memory/PostgreSQL 两套实现和多租户负向测试。002 迁移把现有数据放入 `default` scope，并从
`metadata_json->>'name'` 回填已有名称；原本没有名称的数据继续保持可选名称。

## 备选方案

继续只使用 JSON metadata 的实现成本最低，但会把搜索、更新和跨 Store 一致性留给每个使用者；只增加
`ownerUserId/tenantId` 固定字段又无法自然支持团队、项目和共享空间。因此建议采用一等名称加不透明稳定作用域，
把完整权限模型继续留在应用层。

本 ADR 已由阶段 4.13 实现。名称重命名、完整身份模型与应用自定义查询仍是独立后续能力。
