# 自定义工具开发实践

> 文档类型：实践指南；适用版本：阶段 1.1 及以后。

## 1. 学习目标

完成本实践后，你应该能够：

- 使用 Zod 和 `defineTool()` 定义一个第一方工具。
- 把工具加入现有 Server 静态注册表，而不修改 Agent 分支。
- 验证输入、输出、权限和重试边界。
- 使用真实对话完成本地冒烟测试。

开始前建议先阅读[工具协议](../standards/protocols/tool.md)和
[Server Runtime 接入规范](../standards/integrations/server-runtime.md)。

## 2. 定义工具

下面的 `echo` 工具没有外部能力，适合验证完整接入链路：

```ts
import { z } from 'zod'
import { defineTool } from '../craft-agent'

export const echoTool = defineTool({
  name: 'echo',
  description: '原样返回用户要求回显的文本。',
  inputSchema: z.strictObject({
    text: z.string().min(1).describe('需要回显的文本。'),
  }),
  outputSchema: z.strictObject({
    text: z.string(),
  }),
  security: {
    risk: 'safe',
    capabilities: [],
    idempotent: true,
  },
  execute(input) {
    return { text: input.text }
  },
})
```

需要网络、数据库或其他依赖时，优先通过闭包注入。不要从 CraftAgent 获取全局 service locator。

## 3. 加入静态注册表

在 `src/server/agent-tools.ts` 中加入定义：

```ts
export const serverTools = Object.freeze([
  createServerToolRegistration(getTimeTool),
  createServerToolRegistration(getUserLocationTool),
  createServerToolRegistration(getWeatherTool),
  createServerToolRegistration(echoTool),
] as const)
```

不需要修改独立 JSON Schema、工具名映射或 `agent.ts` 的 switch/case。Agent 会把 `tool.model` 交给
ModelAdapter，并在收到同名 Tool Call 时通过 Tool Harness 执行。

## 4. 编写测试

每个应用工具至少验证：

1. 正常输入返回 `ok: true`。
2. 非法输入在 `attempts: 0` 时拒绝，业务函数没有执行。
3. 错误成功值返回 `INVALID_TOOL_OUTPUT`。
4. 外部依赖使用 mock，不在核心测试中访问真实网络或数据库。
5. 配置重试时，同时覆盖可重试和不可重试错误。
6. 申请外部能力时，覆盖许可和拒绝路径。

可参考 [`test/server-tools.test.ts`](../../test/server-tools.test.ts) 中的 `invokeServerTool()`。

## 5. 本地验证

```powershell
$env:DEEPSEEK_API_KEY = '你的开发密钥'
pnpm dev
```

依次验证：

1. “现在几点？”：验证 `get_time`。
2. “杭州天气怎么样？”：验证指定城市的 `get_weather`。
3. “我这里天气怎么样？”：验证 IP 近似定位。
4. 要求模型回显指定文本：验证新工具注册。
5. 临时制造错误输出：验证 `INVALID_TOOL_OUTPUT` 回写。

真实 API Key 不得写入代码、测试、文档或提交记录。

## 6. 常见问题

- `security.risk` 是工具声明，不是授权；最终决定属于 Runtime 策略。
- 配置 `retry` 前必须建立真实幂等语义，不能只把 `idempotent` 改成 `true`。
- `outputSchema` 即使不发送给模型，也必须验证业务和上游返回值。
- 大型结果应分页或摘要，不能依赖提高模型内容大小上限。
