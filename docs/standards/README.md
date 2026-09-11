# 开发规范

本目录定义 craft-harness 当前必须遵守的架构、协议、安全和工程约束，是判断现有行为是否正确的首要依据。

## 阅读入口

- [总体架构](./architecture.md)：仓库布局与发布边界、模块职责、依赖方向和长期结构。
- [开发与代码规范](./development-conventions.md)：公共 API、参数、命名、注释和错误措辞。
- [工具协议](./protocols/tool.md)：工具定义、校验、权限、重试、超时和事件。
- [模型 Adapter 协议](./protocols/model-adapter.md)：消息、兼容 chunk、官方 Adapter 分层、测试规范和供应商边界。
- [Session Log 协议](./protocols/session-log.md)：append-only 事实、乐观并发、一致性分页和消息推导。
- [Agent Loop 协议](./protocols/agent-loop.md)：Run/Turn/Step、模型流组装、工具调度、预算、终态和实时事件。
- [Agent 门面协议](./protocols/agent.md)：统一配置、工具组装、精简输出、完整轨迹和会话查询。
- [安全与信任模型](./security/trust-model.md)：当前威胁模型和长期隔离边界。
- [Server Runtime 接入规范](./integrations/server-runtime.md)：官方案例 `sample/` 的 Fastify Runtime 组装边界与部署配置。

## 维护规则

- 规范只描述当前有效行为，不记录开发过程。
- 新增公共协议时同步更新规范、测试和必要的 ADR。
- 行为改变时直接更新当前规范；被取代的设计原因通过 ADR 的 Superseded 状态保留。
- 规范与交付记录冲突时，以当前 Accepted 规范为准。
