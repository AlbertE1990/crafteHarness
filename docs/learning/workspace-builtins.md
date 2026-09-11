# 内置工作区工具：开箱使用与安全定制

Agent 默认具备文件、搜索和一次性终端能力。服务端建议明确 workspace：

```ts
const agent = new Agent({
  model,
  tools: {
    workspaceRoot: '/srv/project',
    disabledBuiltins: ['terminal'],
    additional: [queryIssueTracker],
  },
})
```

省略 tools 时同样自动装载，workspace 是创建 Agent 时的 cwd。已有文件必须先 read 再 write/edit：读取会记录
版本，IDE 或其他进程随后改动文件时，写操作会停止并要求重新读取。这是乐观防误写，不是跨进程事务。

write、edit 和 terminal 会默认请求一次审批，因此交互应用应使用 `stream()`；`invoke()` 没有中途事件出口，
会 fail-closed。全局 `tools.guard` 可以结合请求 context 做当前用户、租户与环境授权。

严格白名单使用 `mode: 'replace'`；单项禁用用 `disabledBuiltins`；保持模型调用名称但更换实现用 `overrides`；
只增加业务工具用 `additional`。终端并非沙箱，生产部署还应限制进程账户、挂载、Secret 与网络出口。

完整边界见[内置工作区工具规范](../standards/protocols/builtin-workspace-tools.md)。
