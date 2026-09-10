# Delivery 018：阶段 4.12 配置减负与统一 Guard 协议

> 交付日期：2026-09-10；状态：Completed。

## 完成范围

- 从 `AgentConfigInput` 删除 `createId/createSessionId`，内部 ID 统一为语义前缀加 UUID。
- 将 `session: { store }` 简化为根 `sessionStore`，默认仍使用 `MemorySessionStore`。
- 将全局 Guard 和审批默认时限归入 `tools.guard/tools.approvalTimeoutMs`。
- 将工具定义的 `toolGuard` 重命名为 `guard`，并同步内置工具覆盖、Core 注册表与 Tool Harness。
- 局部和全局 Guard 复用 `ToolGuardRequest/ToolGuardDecision`，且运行时收到同一个请求对象。
- `AgentRequest.context` 原样到达两层 Guard 和工具执行，保持调用方自由组合请求级依赖。
- Server Runtime、公共导出、学习文档和权威规范迁移到新配置。

## 关键规则

- 缺少任一 Guard 等价于该层 allow；两层按工具级、全局级顺序执行并按 `deny > ask > allow` 合并。
- 工具级 input 保留 Zod 类型，全局 input 为 `unknown`；二者的 context 类型相同。
- `tools.guard` 是直接函数，不要求 `{ evaluate() }` 包装。
- 旧字段不提供兼容别名；无效字段在配置归一化阶段直接报错。

## 验证

- Agent 配置、门面、Tool Harness、AgentLoop、Server Runtime 和公共 API 测试。
- 契约测试断言局部与全局 Guard 获得同一请求对象和同一 context 引用。
- TypeScript、lint、全量测试与生产构建。

## 已知边界

`context` 是同进程请求级引用，不会被序列化、持久化或自动发送给模型。需要跨进程恢复的身份和业务状态，
仍应由 Runtime 或应用自己的持久化协议负责。
