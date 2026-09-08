# 阶段 1.1：接入现有 Server

- 文档类型：交付记录
- 状态：已完成
- 对应提交：`e116ec3`

## 本阶段目标

让现有 Fastify + DeepSeek 对话真正使用阶段 1 的工具协议，消除旧工具 JSON 与执行函数之间的双协议。

## 实际完成

- 时间、IP 近似定位和天气工具改为 `defineTool()`。
- `DefinedTool.model` 自动生成模型可见工具参数。
- 模型 Tool Call 统一经过 `executeTool()`。
- 异构工具通过 `ServerToolRegistration` 放入静态注册表。
- 定位和天气的临时网络错误进入 CraftAgent 幂等重试管线。
- Fastify SSE 支持内容与思考两个增量频道，并在浏览器断开时取消上游请求。

## 主要文件

- `src/server/agent-tools.ts`
- `src/server/agent.ts`
- `src/server/func.ts`
- `test/server-tools.test.ts`

## 验证

- 模型 Schema 投影和静态注册表。
- 自定义工具无须修改 Agent 分支。
- 非法参数在业务执行前拒绝。
- IP、天气网络调用使用 mock 验证输出和重试。

## 阶段结束时的过渡限制

- `agent.ts` 当时仍直接依赖 OpenAI SDK 与 DeepSeek chunk。
- 会话保存在进程内可变数组。
- 工具调用顺序执行，循环上限固定。

第一项已在阶段 2 消除，后两项留给 Session Log 和 Agent Loop。
