# ADR-0014：显式注入 Adapter，并统一模型选择对象

> 状态：Accepted；日期：2026-09-11。

## 背景

旧 `AgentModelInput` 同时接受声明式 DeepSeek 配置、OpenAI Compatible 配置和 `ModelAdapter` 实例。
模型名藏在 `model.model`，推理强度却位于 `execution.reasoningEffort`；运行时切换模型还需要为每个模型
创建 Agent 或维护解析注册表。联合类型虽然少写了一次 import，却把判别、默认值和扩展规则留给每个使用者理解。

## 决策

`AgentConfigInput` 使用两个稳定根字段：

```ts
const agent = new Agent({
  adapter: new DeepSeekAdapter({ apiKey, baseURL }),
  model: { id: 'deepseek-chat', reasoningEffort: 'high' },
})

void agent
```

- `adapter` 只持有 provider、SDK、鉴权、base URL 与协议转换，不持有模型。
- `model` 固定为 `{ id, reasoningEffort? }`；`id` 是供应商标识，展示名归应用模型目录。
- `AgentRequest.model` 使用同一形状。一旦出现就整体替换默认选择，防止新模型继承旧模型推理等级。
- `ModelRequest.model` 是必填字符串；同一个 Adapter 和 Agent 可按请求服务多个同协议模型。
- `execution` 保留预算 `limits` 与测试时钟 `now`，不再保存模型选择字段。
- 官方类名采用 `DeepSeekAdapter` 与 `OpenAICompatibleAdapter`。
- 不提供全局 Adapter 注册表，也不恢复声明式联合配置。协议不同或连接不同才创建另一个 Adapter/Agent。

## 理由与后果

模型名称与推理能力在 UI 和供应商侧天然一起变化，把它们放入同一个选择对象可避免跨区域配置。
显式构造 Adapter 让依赖、生命周期和供应商差异在代码中可见，也让自定义 Adapter 与官方 Adapter 使用方式一致。
应用侧模型目录仍负责候选与能力校验，库只校验非空字符串并透传开放等级。

这贯彻项目的库设计原则：把简单、稳定且一致的入口留给使用者；判别、归一化、完整覆盖和供应商字段翻译由库承担。
