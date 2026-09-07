# CommonAgent 文档

本目录记录 CommonAgent 的架构约束、公共协议、实现状态和重要设计决定。代码与文档必须在同一次变更中保持同步。

## 当前状态

第一阶段仅实现了独立工具子系统：

- 使用 Zod 4 的 `defineTool()`。
- 输入与成功输出运行时校验。
- 协作式超时、幂等重试和标准错误。
- allow/deny/ask 权限决策与 fail-closed 审批。
- 可供后续轨迹系统消费的工具执行事件。
- `get_current_time` 和 `calculator` 两个显式注册的安全内置工具。

现有 `src/server/agent.ts` 尚未迁移到新工具协议。ModelAdapter、append-only Session Log 和完整 Agent Loop 会在后续阶段逐步实现。

## 文档索引

- [第一阶段学习指南：从定义工具到执行结果](./learning-guide.md)
- [总体架构](./architecture.md)
- [工具定义与执行规范](./tool-specification.md)
- [分阶段开发路线图](./roadmap.md)
- [ADR-001：采用 Zod 作为工具 Schema 单一来源](./decisions/001-zod-tool-contract.md)

如果你的目标是掌握本次代码修改，建议先阅读“第一阶段学习指南”，再对照测试逐段调试；
“总体架构”和“开发路线图”分别回答最终要做成什么，以及以后按什么顺序实现。

## 文档维护规则

- 所有导出的类型、类、函数和公共方法必须带有 JSDoc。
- 关键状态转换、取消语义、安全边界和不变量必须解释“为什么”。
- 新增公共协议时必须同步更新对应文档。
- 设计决定发生变化时新增或更新 ADR，不能只修改代码。
- 文档中的示例必须能够对应当前代码；未实现功能必须明确标记为“规划中”。
