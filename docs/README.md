# CraftAgent 文档

本文档库按用途分为开发规范、学习路径和产品记录。代码与当前规范必须在同一次变更中保持同步；
学习文档和历史交付记录不能覆盖当前规范。

## 按角色阅读

### 开发或评审当前实现

从[开发规范](./standards/README.md)开始：

- [总体架构](./standards/architecture.md)
- [工具协议](./standards/protocols/tool.md)
- [模型 Adapter 协议](./standards/protocols/model-adapter.md)
- [Session Log 协议](./standards/protocols/session-log.md)
- [Agent Loop 协议](./standards/protocols/agent-loop.md)
- [Agent 门面协议](./standards/protocols/agent.md)
- [Server Runtime 接入规范](./standards/integrations/server-runtime.md)
- [安全与信任模型](./standards/security/trust-model.md)

### 学习和扩展 Agent

从[学习路径](./learning/README.md)开始：

- [Tool Harness：从定义工具到执行结果](./learning/tool-harness.md)
- [自定义工具开发实践](./learning/custom-tool-development.md)
- [ModelAdapter：从供应商 chunk 到 Agent](./learning/model-adapter.md)
- [自定义模型 Adapter 开发实践](./learning/custom-model-adapter.md)
- [Session Log：从可变消息数组到事实日志](./learning/session-log.md)
- [持久化 SessionStore：从内存调试到 PostgreSQL](./learning/persistent-session-store.md)
- [Agent Loop：从用户输入到确定终态](./learning/agent-loop.md)
- [CraftAgent 统一入口：从配置到会话查询](./learning/craft-agent-facade.md)
- [工具审批全链路：从风险评估到继续 AgentLoop](./learning/tool-approval-flow.md)

### 查看方向、决策和进度

从[产品与项目记录](./product/README.md)开始：

- [分阶段开发路线图](./product/roadmap.md)
- [架构决策记录](./product/decisions/README.md)
- [阶段交付记录](./product/deliveries/README.md)

## 当前状态

当前已完成 Tool Harness、ModelAdapter、官方 Adapter、Session Log、Agent Loop 和统一 Agent 门面：

- 工具具有 Zod 输入输出边界、权限、审批、超时、幂等重试和执行事件。
- 模型具有供应商无关消息、OpenAI 兼容标准 chunk、非流式结果、用量和错误协议。
- OpenAI SDK 仅存在于官方 Adapter；Core 不依赖 SDK，DeepSeek 只维护供应商差异。
- `new Agent(config)` 可直接组装内置模型、自定义 Adapter、Store、预算和事件观察器，并自动装载安全内置工具。
- 工具配置支持禁用或覆盖指定内置工具、整体替换内置集合，以及只追加应用工具。
- `defineAgentConfig()` 可显式提前校验配置；`defineTool()` 结果可直接传入 Agent，由内部统一归一化。
- Scripted Adapter 与契约探针为应用和 Adapter 开发提供无网络测试入口。
- Session 使用 append-only 事件、乐观并发和一致性分页，并可确定性推导模型历史。
- 外部 SessionStore 通过统一持久化语义和独立契约探针接入 SQL、ORM、Service 或 API。
- MemorySessionStore 只用于零数据库开发和测试；长期运行服务应显式注入持久化 Store。
- Agent Loop 以 Run/Turn/Step 串联模型、工具和 Session，并提供预算、取消、稳定终态和实时事件。
- Agent 门面自动处理 Session ID，分离精简输出与完整轨迹，并提供会话读取和分页列表。
- Agent 门面通过单一 ToolGuard 接收风险评估规则，并内置一次性审批、超时、取消和重复提交控制。
- 真实 DeepSeek 冒烟仍需在配置 API Key 后执行。
- Fastify 已迁移到 Agent 门面；持久化轨迹查询接口是下一阶段。

## 权威顺序

发生内容冲突时按以下顺序判断：

1. 当前 `Accepted` 的规范定义现行行为。
2. 未被取代的 ADR 解释设计原因。
3. Roadmap 描述计划，不代表已经实现。
4. Delivery 描述历史交付快照。
5. Learning 用于理解和实践，不作为协议定义。

## 文档维护规则

- 一个文档只承担一种主要职责，混合内容应拆分并互相链接。
- 新增或修改公共协议时同步更新规范、代码测试和必要的 ADR。
- 所有导出类型、类、函数和公共方法必须带有 JSDoc。
- 关键状态转换、取消语义、安全边界和不变量必须解释“为什么”。
- 未实现功能必须标记为“规划中”，不能写成已经具备的能力。
- 内部链接使用相对路径；文件名使用小写 `kebab-case`。
