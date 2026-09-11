# ADR-0015：工作区工具按显式能力边界启用

> 状态：Accepted；日期：2026-09-11；取代：[ADR-0013](./adr-0013-default-workspace-tools.md)。

## 背景

文件、搜索和终端工具必须有真实工作区边界。普通网页对话没有工作区；若省略配置时自动采用
`process.cwd()`，既把部署目录误当成用户工作区，也会让无工作区应用默认暴露不需要的高风险能力。

## 决策

- Agent 始终自动装载不依赖工作区的 `get_current_time` 与 `calculator`。
- 只有提供 `tools.workspaceRoot` 时，才自动加入 `read/write/edit/glob/grep/terminal`。
- 工作区工具继续支持禁用、同名覆盖、Guard 覆盖、追加与整体 replace。
- 直接使用高级工厂 `createWorkspaceTools()` 时仍可默认采用当前目录；这是调用方主动选择工具，不是 Agent 猜测。
- 内置工具实现归入 `src/tools/builtins`，使定义、执行与内置集合位于同一所有权目录。

## 后果

普通聊天配置更短且默认权限更小；仓库 Agent 必须显式声明工作区。已有依赖隐式 cwd 的调用方需要增加
`tools.workspaceRoot`，这一处显式配置也是部署安全审查所需的信息。
