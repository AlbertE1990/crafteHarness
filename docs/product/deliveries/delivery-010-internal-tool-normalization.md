# 阶段 4.4：Agent API 归一化与预发布收口

- 文档类型：交付记录
- 状态：代码、测试和文档已完成
- 日期：2026-09-09

## 本阶段目标

降低 CraftAgent 使用者的心智负担：把可确定的转换收进配置边界，并删除尚无外部使用者的重复输入形态，
让工具、模型和 Session Store 各自只保留职责明确的协议。

## 实际完成

- `additional`、`overrides` 和 `replace.tools` 直接接受不同 Schema 的原始 DefinedTool。
- `createTools()` 在所有分支中先归一化工具，再检查名称冲突并冻结最终集合。
- Agent 工具配置只保留 DefinedTool 这一种输入，不接受内部 AgentTool 执行结构。
- 删除额外的工具组装公共入口和双形态兼容分支。
- Server 工具注册表改为普通只读 DefinedTool 数组。
- 自定义模型只接受直接传入的 `ModelAdapter`，删除 `{ provider: 'custom', adapter }` 包装配置。
- `SessionStore` 只声明 AgentLoop 必需的 `append/read`；目录查询由 `SessionCatalogStore.list` 明确扩展。
- 删除未被实现或使用的 `AgentOutputProjector` 公共类型草案。
- 开发规范新增“能在内部确定完成的工作，不增加外部调用步骤”的心智负担原则。

## 验证范围

- 原始 DefinedTool 可以直接追加、覆盖内置工具和整体替换工具集合。
- 归一化后仍通过 Tool Harness 执行。
- 重复名称与错误覆盖仍在 Agent 创建阶段失败。
- Server 最终工具集合与模型 Schema 保持不变。
- 直接注入的自定义 ModelAdapter 继续正常工作。
- 执行型 SessionStore 与带目录能力的 SessionCatalogStore 均通过对应契约测试。
