# 内置工作区工具规范

> 文档类型：协议规范；状态：Accepted。

## 默认能力

Agent 默认装载 `read`、`write`、`edit`、`glob`、`grep`、`terminal`，并继续支持
`disabledBuiltins`、`overrides`、`guardOverrides`、`additional` 和 `mode: 'replace'`。普通使用者无需导入；
高级组合可使用 `createWorkspaceTools(options)`。

`tools.workspaceRoot` 是文件路径与终端初始工作目录的边界，默认在创建 Agent 时取 `process.cwd()`。Server
应显式传稳定绝对目录。replace 模式不创建内置工具，因此不接受 workspaceRoot。

## 文件与搜索

- `read(file_path, offset?, limit?)` 读取 UTF-8 文本并返回行号；默认上限 2,000 行、50 KiB。
- `write(file_path, content)` 创建或完整覆盖文件，不自动创建父目录。
- `edit(file_path, old_string, new_string, replace_all?)` 精确替换；默认要求原文只出现一次。
- `glob(pattern, path?)` 最多返回 100 个路径。
- `grep(pattern, path?, include?)` 最多返回 250 条正则匹配。

所有路径同时检查词法 `..` 与可解析的符号链接逃逸。已有文件在 write/edit 前必须由同一工具套件 read；文件
版本变化返回 `FS_STALE_VERSION`，未读返回 `FS_NOT_OBSERVED`。写入先落同目录临时文件再发布。

搜索使用安装依赖 `@vscode/ripgrep`，通过参数数组和 `shell: false` 启动，包含隐藏/ignored 文件但排除 `.git`。
默认超时 30 秒；数量或捕获字节达到上限时返回 `truncated: true`。

## 终端与审批

`terminal(command, description, workdir?, timeout_ms?)` 每次启动新 shell；Windows 使用 PowerShell，其他平台使用
`/bin/sh`。调用间不保留 cwd、环境变量或后台任务；默认超时 120 秒，stdout/stderr 分别保留 64 KiB 尾部。

`write/edit/terminal` 的局部 Guard 默认 ask，`read/glob/grep` 默认 allow；全局 Guard 仍按
`deny > ask > allow` 合并。终端的 workspace 只限制初始 workdir，命令仍继承宿主文件、网络、环境变量和
子进程权限。它不是 OS 沙箱；不需要时应禁用，需要强隔离时应使用容器、低权限账户或专用执行服务。

## 设计来源

命名、主要参数、读后改和搜索上限参考 DeepSeek Harness 的
[filesystem 工具](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/fs/tool-fs/README.md)、
[工具目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/tool-catalog.md)与
[filesystem subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/filesystem.md)。
craft-harness 保留自己的 Zod、Guard 与结果协议，并将 bash 能力改为跨平台 terminal；本阶段不提供持久终端、
后台任务和大输出落盘引用。
