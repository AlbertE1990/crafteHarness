# ADR-0013：默认提供受工作区约束的文件、搜索与终端工具

- 文档类型：架构决策
- 状态：Superseded
- 日期：2026-09-11
- 扩展：[ADR-0006](./adr-0006-agent-default-builtin-tools.md)
- 替代：[ADR-0015](./adr-0015-opt-in-workspace-tools.md)

只有时间与计算能力的 Agent 无法完成常见仓库任务，而让每个使用者重复实现文件和命令工具会产生不一致的
路径、审批与输出边界。因此默认新增 `read/write/edit/glob/grep/terminal`，复用现有禁用、覆盖、追加和
replace 机制，并公开 `createWorkspaceTools()` 供高级组合。

文件能力以 `tools.workspaceRoot` 为边界，已有文件采用读后改版本检查，写入使用临时文件发布。搜索使用随包
安装的 `@vscode/ripgrep` 与无 shell 参数数组；它是新的运行时 dependency，阶段 4.15 的“零运行期依赖”只
描述当时交付快照，不再是当前状态。写、编辑与终端默认 ask。

终端采用跨平台一次性 shell，不实现持久会话、后台任务和大输出文件引用。路径边界与 Guard 都不是 OS 沙箱；
开放给不可信场景前必须增加进程或容器隔离，也可以按部署禁用 terminal。
