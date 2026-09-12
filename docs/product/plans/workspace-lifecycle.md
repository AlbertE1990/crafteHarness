# Workspace 生命周期与运行时绑定计划

> 文档类型：产品计划；状态：Next；目标阶段：4.18。

## 1. 要解决的问题

当前 `tools.workspaceRoot` 是 Agent 创建期配置，适合目录在 Agent 整个生命周期内固定的 CLI、仓库 Agent 或
单工作区服务。它不能正确表达网页产品里的关系：用户先选择工作区，再创建 Session，同一个服务端 Agent 还要
并发处理其他工作区和完全没有工作区的普通对话。

最短示例和官方网页案例因此默认不配置 `workspaceRoot`。在完整 Workspace 阶段完成前，不用
`process.cwd()` 代替产品工作区，也不先增加一个只有路径、没有身份和权限约束的请求字段。

## 2. 目标边界

- 无工作区是一级合法模式：时间、计算器和应用工具可用，文件、搜索、终端不装载。
- 浏览器只表达工作区 ID；绝对路径、当前权限和可用状态全部由可信 Runtime 查询和组装。
- Workspace 与 Session 建立稳定关系；创建后不能通过下一次请求静默切换。
- 同一个 Agent 可以并发处理不同工作区，每个 Run 的工具实例、根目录和文件观察状态相互隔离。
- craft-harness 不创建业务数据库、不拥有用户表，也不规定具体 ORM、HTTP 路由或 Workspace CRUD。

工作区是本次 Run 可访问的资源边界，不是模型预算或时钟，因此不放入 `execution`。

## 3. 所有权划分

| 所有者        | 负责                                                                       | 不负责                                        |
| ------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| craft-harness | 可选 Workspace Binding、按 Run 装载工具、Session 绑定一致性、无工作区行为  | 建表、路径分配、身份认证、成员管理、业务 CRUD |
| 应用 Runtime  | 按当前用户授权、从 ID 解析可信路径和权限、把 Binding 与 context 传给 Agent | 重新实现 Agent Loop 或信任浏览器路径          |
| 官方 sample   | PostgreSQL 参考迁移、Repository、Fastify API 和最小选择流程                | 成为所有产品都必须采用的 Workspace 后端       |

权限继续通过请求 `context` 进入两层 ToolGuard；持久化的 `workspaceId` 只用于关联和一致性检查，不能作为
授权证明。

## 4. 候选调用协议

以下形态用于指导实现评审，当前尚不是 Accepted API：

```ts
await agent.stream({
  scopeId: authenticatedTenant.id,
  sessionId,
  input,
  workspace: {
    id: authorizedWorkspace.id,
    root: authorizedWorkspace.absolutePath,
  },
  context: {
    userId: authenticatedUser.id,
    workspacePermissions: authorizedWorkspace.permissions,
  },
})
```

`workspace` 必须由 Server 在当前请求中重新授权后组装。浏览器的新会话请求最多携带 `workspaceId`；继续已有
Session 时，Runtime 以 Session 中已绑定的 ID 为准，客户端若同时提交不同 ID 应直接拒绝。

## 5. 数据模型与迁移

官方 sample 计划新增 `004` 迁移：

- `craft_agent_workspaces`：至少包含 `scope_id`、`workspace_id`、展示名称、规范化绝对路径、状态和时间戳；
  `(scope_id, workspace_id)` 唯一，路径不返回浏览器。
- `craft_agent_workspace_members`：按主体保存角色或权限集合。权限不塞进 Workspace 单行，避免多用户关系和
  工作区生命周期耦合。
- `craft_agent_sessions.workspace_id`：可空；旧数据和普通对话迁移后保持 `NULL`。
- Session 的 `(scope_id, workspace_id)` 使用复合外键指向同 scope 的 Workspace，数据库层阻止跨 scope 绑定。

应用若需要仓库 URL、分支、配额或业务标签，应扩展自己的 Workspace 表或关联投影，不扩大 craft-harness 的
`SessionStore` 通用字段。库的持久化契约只增加运行 Session 所必需的 `workspaceId`。

## 6. Session 不变量

- 新 Session 未提供 Workspace Binding：持久化 `workspaceId = null`，本次及后续 Run 不具有工作区工具。
- 新 Session 提供 Binding：把 ID 写入 Session；只持久化 ID，不持久化本机绝对路径和权限快照。
- 已有 Session：本次授权后的 Binding ID 必须与已存 ID 一致；不一致时报稳定错误，不自动改绑。
- Workspace 被禁用、删除或用户权限被撤销：允许应用按产品策略展示历史，但新 Run 必须明确失败，不能静默
  降级成无工作区对话。
- 改绑属于独立产品操作，若未来支持，必须定义显式 API、审计和并发规则，不复用聊天请求。

## 7. 实施顺序

1. 评审并记录 ADR：确定 Workspace Binding、Session 不变量和静态 `tools.workspaceRoot` 的迁移策略。
2. 扩展 Agent/SessionStore 协议与 Memory Store，先完成无数据库契约测试。
3. 将工作区内置工具改为按 Run 创建，避免在 Agent 单例中共享根目录与已读文件版本。
4. 添加 sample 的 `004` 数据库迁移、PostgreSQL Store 和 Workspace Repository。
5. 添加 Runtime 授权解析和 HTTP 契约；网页端只使用 `workspaceId`，兼容不选择工作区的新会话。
6. 同步规范、学习文档和 Delivery；评估删除或弃用创建期 `tools.workspaceRoot`。

## 8. 验收条件

- 省略 workspace 的现有 `invoke/stream`、旧 Session 和官方网页聊天行为不变。
- 同一 Agent 并发运行两个不同根目录时，文件结果、终端 cwd 和读后改版本状态完全隔离。
- 浏览器提交绝对路径、跨 scope Workspace ID、无权限 Workspace、Session/Workspace 不匹配均被拒绝。
- Session 只持久化 Workspace ID；API、事件和日志不泄漏服务端绝对路径。
- Memory 与 PostgreSQL SessionStore 对新增字段通过同一契约测试；旧数据库可无损迁移。
- Workspace 删除、禁用、权限撤销及运行中取消均有稳定、可测试的失败语义。

## 9. 本阶段不做

- 自动创建本地目录、克隆 Git 仓库、容器编排或远程文件系统挂载。
- 把终端包装成 OS 沙箱；进程账户、挂载、网络和 Secret 隔离仍由部署负责。
- 在 craft-harness 内提供通用 Workspace 管理后台、用户体系或 SQL/ORM 实现。
