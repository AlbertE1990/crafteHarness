# 阶段 4.8：配置分组与公共 API 收口

- 文档类型：交付记录
- 状态：代码、测试和文档已完成
- 日期：2026-09-10

## 本阶段目标

在 CraftAgent 发布前整理持续增长的构造配置，建立可审查的公共导出边界，并把只服务仓库测试的代码移出
生产源码。此次调整直接替换旧输入，不维护无真实使用者的兼容分支。

## 实际完成

- `AgentConfigInput` 新增 `session`、`execution`、`observability` 三个职责组。
- `DefinedAgentConfig` 使用相同结构，`Agent` 内部不再消费另一套扁平字段。
- `model`、`systemPrompt`、`tools` 和 `toolGuard` 保留在根部，避免高频配置产生无意义嵌套。
- 将配置可接受的任意 `defineTool()` 结果公开命名为 `AgentToolInput`，内部归一化函数仍不导出。
- 根入口由通配导出改为显式白名单；官方生产 Adapter 继续从 `craft-agent/adapters` 高级入口提供。
- `ScriptedModelAdapter`、模型和 Session 契约探针迁入 `test/support`。
- PostgreSQL 契约运行脚本迁入 `test/`，学习型 Session 可执行示例迁入 `test/learning`。
- 删除 `adapters/testing` 与 `sessions/testing` 两个未发布的生产子入口。

## 配置规范

- 共享职责和生命周期的两个以上字段才组成配置组。
- 单字段能力不为视觉整齐额外包装。
- 分组名称不能暗示 CraftAgent 未提供的认证、权限或沙箱保证。
- 公共输入和公开的归一化配置保持相同路径。
- 项目测试工具不进入生产源码；外部实现要求写入规范与学习文档。

## 验证范围

- Agent 默认值、自定义 Store、循环预算、全局轨迹和确定性 ID 均通过新分组生效。
- Server Runtime、审批流程、模型边界和 PostgreSQL 契约调用方完成迁移。
- 根入口覆盖普通 Agent、Tool、Model、Session 和高级 AgentLoop 所需类型。
- 普通类型检查、公共 API 独立编译检查、全量测试、Lint 与构建通过。
