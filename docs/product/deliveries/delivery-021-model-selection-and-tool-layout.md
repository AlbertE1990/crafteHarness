# Delivery 021：阶段 4.17 模型选择与内置工具边界收口

> 文档类型：交付记录；完成日期：2026-09-11。

## 已完成范围

- `AgentConfigInput` 改为显式 `adapter` 加 `{ id, reasoningEffort? }` 模型选择，删除声明式 Adapter 联合类型。
- `AgentRequest.model` 可整体覆盖默认模型；Adapter 不再绑定模型，`ModelRequest.model` 随每次调用传入。
- `execution` 只保留预算与可注入时钟；官方 Adapter 类名收敛为短名称。
- 案例 Runtime 复用一个 Agent/Adapter，并把前端目录选择组装成请求级模型对象。
- 内置工具移入 `src/tools/builtins`；时间与计算器默认启用，工作区工具改为由 `workspaceRoot` 显式启用。
- 更新公共 API、Adapter、AgentLoop、案例 Runtime 和工作区能力测试。

## 验证

- `pnpm typecheck`
- `pnpm typecheck:public-api`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm build:sample`
- `pnpm smoke:pack`

决策依据见 [ADR-0014](../decisions/adr-0014-explicit-adapter-and-model-selection.md) 与
[ADR-0015](../decisions/adr-0015-opt-in-workspace-tools.md)。
