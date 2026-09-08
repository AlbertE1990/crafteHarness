# CommonAgent 文档

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
- [Server Runtime 接入规范](./standards/integrations/server-runtime.md)
- [安全与信任模型](./standards/security/trust-model.md)

### 学习和扩展 Agent

从[学习路径](./learning/README.md)开始：

- [Tool Harness：从定义工具到执行结果](./learning/tool-harness.md)
- [自定义工具开发实践](./learning/custom-tool-development.md)
- [ModelAdapter：从供应商 chunk 到 Agent](./learning/model-adapter.md)
- [自定义模型 Adapter 开发实践](./learning/custom-model-adapter.md)
- [Session Log：从可变消息数组到事实日志](./learning/session-log.md)
- [Agent Loop：从用户输入到确定终态](./learning/agent-loop.md)

### 查看方向、决策和进度

从[产品与项目记录](./product/README.md)开始：

- [分阶段开发路线图](./product/roadmap.md)
- [架构决策记录](./product/decisions/README.md)
- [阶段交付记录](./product/deliveries/README.md)

## 当前状态

当前已完成 Tool Harness、现有 Server 接入、ModelAdapter、官方 Adapter 工具包、Session Log 和 Agent Loop：

- 工具具有 Zod 输入输出边界、权限、审批、超时、幂等重试和执行事件。
- 模型具有供应商无关消息、OpenAI 兼容标准 chunk、非流式结果、用量和错误协议。
- OpenAI SDK 仅存在于官方 Adapter；Core 不依赖 SDK，DeepSeek 只维护供应商差异。
- OpenAI 兼容服务可使用内置 Adapter，自定义实现可通过同一个 `AgentConfig` 注入。
- Scripted Adapter 与契约探针为应用和 Adapter 开发提供无网络测试入口。
- Session 使用 append-only 事件、乐观并发和一致性分页，并可确定性推导模型历史。
- Agent Loop 以 Run/Turn/Step 串联模型、工具和 Session，并提供预算、取消、稳定终态和实时事件。
- 真实 DeepSeek 冒烟仍需在配置 API Key 后执行。
- Runtime 与轨迹查询接口是下一阶段。

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
