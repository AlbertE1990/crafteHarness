# 阶段 2.1：官方 Adapter 工具包

- 文档类型：交付记录
- 状态：代码、离线测试和构建已完成；真实供应商冒烟仍需 API Key
- 日期：2026-09-07

## 本阶段目标

将可复用 Adapter 作为 CommonAgent 官方能力提供，在不增加 Core 供应商依赖的前提下，降低应用接入
和第三方 Adapter 开发所需代码。

## 实际完成

- 新增 `OpenAICompatibleModelAdapter`，统一 Chat Completions 请求、响应、流、usage 和错误映射。
- 通用层保留未知响应字段，并允许供应商差异层读取 reasoning 扩展。
- DeepSeek Adapter 收缩为 developer 消息降级、`max_tokens`、thinking 和 reasoning 差异层。
- 新增生产 Adapter 汇总入口，测试能力保持独立入口。
- 新增 `ScriptedModelAdapter`，支持确定性 complete/stream 脚本、请求快照、取消和模拟错误。
- 新增不绑定测试框架的 `assertModelAdapterContract()` 契约探针。
- `AgentConfig` 扩展为 DeepSeek、OpenAI Compatible 和自定义 Adapter 判别联合。
- 新增通用 Adapter、测试工具和统一配置分支测试。

## 主要文件

- `src/common-agent/adapters/openai-compatible/*`
- `src/common-agent/adapters/deepseek/*`
- `src/common-agent/adapters/testing/*`
- `src/common-agent/adapters/index.ts`
- `src/server/agent-config.ts`
- `test/openai-compatible-adapter.test.ts`
- `test/model-adapter-testing.test.ts`
- `test/deepseek-adapter.test.ts`
- `test/agent-config.test.ts`

## 关键决定

- 官方提供不等于 Core 直接依赖，依赖方向仍然是 Adapter 指向 Core 协议。
- 通用兼容层使用模板方法承载明确扩展点，不包含按供应商名称判断的条件分支。
- 测试工具不从生产 Adapter 汇总入口导出。
- 自定义 Adapter 仍必须通过 `AgentConfig` 进入 Runtime，保持单一配置根。

## 离线验证

- OpenAI 标准消息、工具和请求控制字段转换。
- completion、chunk、usage、provider 和未来未知字段保留。
- 创建流与迭代流期间的错误归一化。
- DeepSeek thinking、reasoning、developer 消息与 token 参数差异。
- Scripted Adapter 的契约探针、请求快照和取消语义。
- 内置兼容配置与自定义 Adapter 配置。
- Core 和 `server/agent.ts` 继续禁止导入 OpenAI SDK。

## 明确不在本阶段实现

- Anthropic、Gemini 等非 Chat Completions 原生协议 Adapter。
- 自动探测供应商能力或静默降级不兼容字段。
- Adapter 内部重试。
- npm 多包和可选依赖拆分。
- 真实供应商联网测试。
