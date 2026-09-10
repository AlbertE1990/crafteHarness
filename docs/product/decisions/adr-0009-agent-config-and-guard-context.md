# ADR-0009：Agent 配置按使用意图减负并统一 Guard 协议

> 状态：Accepted；日期：2026-09-10。

## 背景

原 `AgentConfigInput` 暴露 `session.createSessionId`、`execution.createId`、根 `toolGuard`，并使用
`session: { store }` 注入唯一的持久化端口。工具自己的风险函数又叫 `toolGuard`，全局入口则需要
`toolGuard.evaluate`，同一概念形成了两套名称和包装。调用方还必须理解哪些 ID 属于内部运行细节。

运行请求已经携带任意 `context`，但若两层 Guard 采用不同协议，租户、身份、服务等请求级依赖仍需由应用
重复适配。这违背“把方便留给使用者，把不方便留给库实现者”的公共 API 原则。

## 决策

- `AgentConfigInput` 不再公开 `createId/createSessionId`。Agent 内部使用语义前缀加 UUID 生成 Session、Run、
  Turn、Event 和 Approval ID；低层组件仍可保留确定性测试注入点。
- 唯一持久化依赖直接配置为根 `sessionStore`，不创建单字段 `session` 对象。
- 全局 Guard 是工具调用策略，配置为直接函数 `tools.guard`；通用审批时限配置为
  `tools.approvalTimeoutMs`。
- 工具定义的局部入口命名为 `guard`。局部和全局 Guard 共用 `ToolGuardRequest` 与
  `ToolGuardDecision`，不使用额外 evaluate 包装。
- `AgentRequest.context` 保持任意应用类型。Harness 在输入校验后只构造一个 Guard 请求对象，依次原样传给
  局部和全局 Guard，再把相同 context 传给工具执行。
- 局部 Guard 的 input 保留 Zod 推导类型；全局 Guard 面对异构工具，input 默认为 `unknown`。
- 项目尚未发布，不保留旧字段兼容别名。

## 后果

最小配置更短，工具风险策略集中在 `tools`，使用者只需学习一套 Guard 输入输出协议。context 可以组合认证
信息、请求级 Service、ORM 或 API Client，而 CraftAgent 不需要知道具体集成方式。相应复杂度由库内部承担：
工具归一化、类型擦除、同一请求对象的传递、ID 生成和审批默认值都必须由契约测试覆盖。

`agent.config.tools` 的归一化结果包含 `registered/guard/approvalTimeoutMs`；注入的 Adapter、Store、context
和策略函数不会被深度冻结。历史 Delivery 013、014 和 016 中的旧配置仅表示当时状态，当前协议以本 ADR
及 Agent、Tool 规范为准。
