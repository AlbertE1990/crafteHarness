# craft-harness 安全与信任模型

> 文档类型：边界规范；状态：Accepted；安全增强保持低优先级。

## 1. 当前威胁模型

当前项目面向能够修改 Node.js 服务代码的可信第一方开发者。工具由开发者在启动时静态注册，不允许普通终端
用户上传或注入任意 JavaScript。现阶段优先完成 Agent 功能，不实现第三方插件来源验证、代码审计、独立进程
或 OS 沙箱。

这意味着：

- Zod 只验证输入输出形状。
- `metadata` 只保存应用自定义 JSON 标签。
- Tool Guard 只执行开发者编写的决策逻辑。
- TypeScript 只提供编译期约束。
- 同进程工具依然可以直接调用 Node.js 文件、网络和进程 API。

以上任何一项都不能证明一段恶意工具代码安全。

默认文件工具会检查 workspace 与可解析的符号链接，但这只是防误用边界。默认 terminal 只限制初始 workdir，
命令仍继承宿主进程的文件、环境变量、网络和子进程权限；默认 ask 也不等于隔离。不需要时应禁用 terminal，
需要强隔离时使用容器、低权限账户或专用执行服务。详见
[内置工作区工具规范](../protocols/builtin-workspace-tools.md)。

## 2. 为什么 security 改为 metadata

旧字段 `security.risk/capabilities/idempotent` 容易让人误认为 craft-harness 会验证或执行这些安全语义。实际上
风险分类、能力名称和授权规则都由同一个应用开发者定义，框架无法知道它们是否真实。

当前统一使用：

```ts
const metadata = {
  risk: 'write',
  capabilities: ['orders:update'],
  domain: 'orders',
}
```

craft-harness 只验证它是 JSON 对象并把它交给 Guard。应用可以采用完全不同的字段。没有任何字段会自动授予
或拒绝权限。

## 3. 为什么删除 idempotent

框架无法通过函数源码或一次运行证明真实幂等性。额外的 `idempotent: true` 只会和 `retry` 形成重复
声明，并可能制造虚假的安全感。

现在 `execution.retry` 本身表示：“工具作者明确允许 craft-harness 对同一个 callId 重复调用 execute()。”
工具作者仍必须在业务层建立真实保障：

- 使用 `callId` 或业务键作为幂等键；
- 使用数据库唯一约束或 compare-and-set；
- 使用上游服务提供的 idempotency key；
- 对超时后结果未知的场景编写集成测试。

craft-harness 只检查重试参数，不判断开发者的业务承诺是否正确。

## 4. 两层 Guard 的信任分工

工具级 Guard 处理工具固有规则：

- 参数决定 read/write/delete；
- 某些路径或资源永远禁止；
- 某种调用需要用户确认。

全局 Guard 处理宿主约束：

- 当前部署是否开放该工具；
- 当前租户是否购买该能力；
- 当前用户和角色是否有权限；
- production/staging/development 是否采用不同限制。

两层都执行，按 `deny > ask > allow` 合并。缺少某层等价于该层 allow；两层都不配置时直接执行。这是当前
可信第一方注册模型下的显式产品选择，不适用于允许陌生代码动态加载的系统。

## 5. 运行上下文的信任来源

Agent 请求的 `context` 可以携带租户、用户、权限和环境，但 craft-harness 不负责认证。Runtime 必须从已经
验证的服务端状态构造 context，不能把浏览器提交的角色或权限原样转入。

```text
不可信 HTTP 输入
  -> Runtime 验证 Token / Session
  -> 服务端身份与租户记录
  -> 构造 run context
  -> 全局 Guard
```

context 是 Run 级引用，不保存在 Agent 单例，不发送给模型，不写入 Session Log，也不默认进入前端事件。
多用户服务必须为每个请求创建独立 context，不能修改共享全局变量来切换当前用户。

TypeScript 会在 `new Agent<AppContext>()` 后要求 `invoke()/stream()` 请求提供 context；JavaScript 调用方仍可绕过类型，
因此依赖身份信息的全局 Guard 应对缺失或畸形字段返回 deny。

## 6. 用户审批不等于授权系统

ask 表示“当前工具调用需要一次交互确认”。approvalId 只能使用一次，超时、取消、重复或未知提交都不会
执行工具。但审批机制不负责：

- 判断当前 HTTP 用户是否有权提交该 approvalId；
- 跨进程保存 pending 审批；
- 在进程重启后恢复等待；
- 代替租户和角色权限检查。

Runtime 对审批提交接口仍应执行认证，并确保请求只能到达正确的 Agent 实例。当前 pending 状态在内存中，
重启后 fail-closed。

## 7. 公开错误与诊断日志

`ToolErrorInfo` 会进入模型、轨迹或网络，因此只保留安全 message/details，不包含 stack 和原始 cause。
这不会阻止后续 DiagnosticSink 在归一化前记录服务端诊断。异常日志能力已列入路线图，必须与公开错误脱敏
边界分离。

## 8. 如果未来加载不可信第三方工具

仅靠 metadata 和 Guard 不够。届时至少需要重新评估：

- 工具来源、版本、签名和 allowlist；
- 独立低权限进程、容器或 OS 沙箱；
- 文件挂载、网络出口、Secret Broker 和系统调用限制；
- CPU、内存、执行时间和输出配额；
- 审批与审计的持久化恢复；
- 重试许可和幂等性审查。

这些能力目前不实现，避免在主要 Agent 功能尚未完善时投入高复杂度、低收益的插件安全体系。
