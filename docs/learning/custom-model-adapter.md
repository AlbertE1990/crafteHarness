# 自定义模型 Adapter 开发实践

> 文档类型：学习指南；适用版本：阶段 2.1 及以后。

## 1. 先选择最短接入路径

如果服务支持 OpenAI Chat Completions，通常不需要编写 Adapter：

```ts
const config = new AgentConfig({
  model: {
    provider: 'openai-compatible',
    providerName: 'my-provider',
    apiKey: process.env.MY_PROVIDER_API_KEY!,
    baseURL: 'https://example.com/v1',
    model: 'my-model',
  },
})
```

DeepSeek 直接使用 `provider: 'deepseek'`，其 thinking、reasoning 和消息差异已经由官方 Adapter 处理。
只有服务不是 Chat Completions 兼容，或者兼容接口存在无法用配置表达的差异时，才新增 Adapter。

## 2. OpenAI 兼容供应商的差异层

兼容供应商可以继承 `OpenAICompatibleModelAdapter`，只覆盖必要的 protected 模板方法：

- `toMessage()`：角色或 reasoning 回放差异。
- `createBaseParams()`：请求字段或 token 参数差异。
- `normalizeCompletion()`：非流式供应商扩展。
- `normalizeChunk()`：流式供应商扩展。
- `normalizeError()`：SDK 之外的错误类型。

不要根据 `provider` 名称在通用基类中增加条件分支。一个差异只属于某个供应商时，就留在对应目录。
可参考 `src/common-agent/adapters/deepseek/deepseek-model-adapter.ts`。

## 3. 非兼容协议的最小实现

非兼容协议直接实现 Core 的 `ModelAdapter`：

```ts
class NativeModelAdapter implements ModelAdapter {
  readonly provider = 'native-provider'
  readonly model = 'native-model'

  async complete(request, options) {
    // 1. 将 ModelRequest 转换成供应商请求。
    // 2. 传递 options.signal。
    // 3. 将结果转换成 ModelCompletion。
  }

  async stream(request, options) {
    // 返回 AsyncIterable<ModelStreamChunk>，并处理创建与迭代期间的错误。
  }
}
```

实现必须遵守[模型 Adapter 协议](../standards/protocols/model-adapter.md)：工具参数保持原始 JSON 文本，
未知 finish reason 不能改写，错误只分类不重试，SDK 类型不能穿过 Adapter 边界。

## 4. 接入统一配置

应用可以先通过自定义分支使用新实现，不必立即修改 Runtime：

```ts
const adapter = new NativeModelAdapter()
const config = new AgentConfig({
  model: { provider: 'custom', adapter },
})
const agent = new Agent(config)
```

当一个 Adapter 被项目正式支持后，再为 `AgentModelConfig` 增加命名分支和默认值。模型配置仍留在
`AgentConfig`，不能在 Adapter、Agent 和环境变量读取代码中维护三份默认值。

## 5. 无网络测试

测试 Agent 行为时使用 `ScriptedModelAdapter`：

```ts
const adapter = new ScriptedModelAdapter({
  script: [
    { method: 'stream', chunks: [firstChunk, finalChunk] },
  ],
})
```

测试供应商 Adapter 时注入 SDK 客户端替身，然后运行契约探针：

```ts
const result = await assertModelAdapterContract(adapter)
```

契约探针会分别调用一次 `complete()` 和 `stream()`，因此客户端替身必须准备两次响应。它只检查公共
骨架、异步迭代和 provider 一致性；供应商专属 reasoning、请求扩展和错误映射仍要单独断言。

## 6. 提交前检查

- Core 和 `server/agent.ts` 没有导入供应商 SDK。
- provider、model 和标准对象身份非空。
- `AbortSignal` 同时覆盖请求创建和流迭代。
- 标准字段与未知扩展字段没有被静默删除。
- 工具调用可按 index 跨 chunk 拼装。
- 供应商错误转换为稳定 `ModelError`，且 Adapter 没有自行重试。
- 普通响应、工具调用、reasoning、usage、取消和异常都有离线测试。
