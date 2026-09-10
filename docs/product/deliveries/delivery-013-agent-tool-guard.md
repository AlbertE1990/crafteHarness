# 阶段 4.7：ToolGuard 与内置审批管理

- 文档类型：交付记录
- 状态：代码、测试和文档已完成
- 日期：2026-09-10

## 本阶段目标

让应用开发者只实现会改变业务决定的风险评估方法，把审批 ID、等待、超时、取消和重复提交等固定机制
收进 Agent，消除 `toolPolicy + requestToolApproval + ApprovalBroker` 的多处组装。

## 实际完成

- 新增供应商和传输无关的 `ToolGuardRequest/ToolGuardDecision/ToolGuardConfig`。
- `evaluate()` 可根据工具名称、描述、输入 Schema、安全声明和已校验参数返回 `allow/deny/ask`。
- `ask.approvalTimeoutMs` 覆盖通用超时；Agent 事件同时提供 `requestedAt/expiresAt`。
- Agent 内置 ApprovalManager，统一处理 pending Promise、Run 取消、超时和首个终态。
- `Agent.resolveToolApproval()` 接收公开的 `allow/deny`，重复、未知和已结束 ID 不会再次生效。
- Agent 输出新增审批请求、审批终态和自动拒绝事件。
- `deny`、用户拒绝和超时只阻止当前工具，失败结果写入 Session 后 AgentLoop 继续下一 Model Step。
- 删除未发布的双配置入口和外部 Broker，底层 AgentLoop/Harness 协议仍作为高级入口保留。

## 验证范围

- 配置校验、默认超时和单次超时覆盖。
- 用户允许后执行工具并继续模型，用户拒绝和自动拒绝后不执行工具但继续模型。
- 审批超时、Run 取消、重复提交和无交互出口均 fail-closed。
- Agent 应用事件、前后端传输投影和倒计时字段保持一致。
- 类型检查、Lint、全量单元测试和生产构建通过。

## 已知限制

- pending 审批只存在于当前 Agent 进程，进程重启后不会恢复。
- ToolGuard 是可信第一方工具的决策边界，不是 Node.js 沙箱，也不验证工具风险声明的真实性。
- 原始异常栈与安全诊断日志仍在阶段 6 实现。
