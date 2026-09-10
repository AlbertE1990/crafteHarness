# 阶段 4.10：分层 Tool Guard 与运行上下文

- 文档类型：交付记录
- 状态：代码、测试和文档已完成
- 日期：2026-09-10

## 本阶段目标

让工具只描述真实业务信息，把固定的 Guard 编排和审批机制收进 CraftAgent；同时让全局 Guard 能读取当前
租户、用户和部署环境，而不把多用户状态放进 Agent 单例。

## 实际完成

- `security` 改为框架不解释的 JSON 安全 `metadata`，删除固定 risk/capabilities 类型。
- 删除 `idempotent`；`execution.retry` 本身成为开发者允许重复调用的明确配置。
- `timeoutMs/retry` 收进工具 `execution` 配置组。
- `defineTool().toolGuard` 与 Agent 全局 `toolGuard.evaluate()` 都执行，并按 `deny > ask > allow` 合并。
- 任一 Guard 未配置时该层直接 allow；两层都未配置时工具直接进入执行阶段。
- Agent 支持泛型运行上下文，数据沿 `Agent.run → AgentLoop → Guard/execute` 传递。
- 运行上下文不发送给模型、不写 Session Log、不发标准应用事件，也不保存在 Agent 单例。
- `tools.guardOverrides` 可替换或移除内置工具局部 Guard，不影响全局 Guard。
- 审批事件用 `toolMetadata` 暴露工具标签，不再要求固定 risk 枚举。
- Tool Harness 轨迹统一为 `tool.guard.decided`，Guard 异常使用 `TOOL_GUARD_FAILED`。
- 删除底层 `ToolPolicy` 别名和对象包装，AgentLoop 直接接收同一 `ToolGuardEvaluator` 函数。

## 固定语义

```text
inputSchema 校验
  -> 工具级 Guard（缺省 allow）
  -> 全局 Guard（缺省 allow）
  -> deny > ask > allow
  -> 审批或 execute
```

deny、用户拒绝和审批超时只拒绝当前工具调用，AgentLoop 会把失败结果交给下一 Model Step。

## 验证范围

- 两层 Guard 的顺序和优先级。
- Agent Run context 同时到达全局 Guard 与 execute。
- 无 Guard 默认允许。
- 内置 Guard 覆盖。
- retry、超时、审批、重复提交和前端确认卡片回归。
- 单元测试、公共 API 严格类型检查、项目类型检查、Lint 与生产构建。
