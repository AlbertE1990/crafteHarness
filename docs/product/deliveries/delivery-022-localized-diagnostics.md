# Delivery 022：阶段 4.18 双语异常与实例级语言配置

> 文档类型：产品交付记录；状态：Completed；日期：2026-09-12。

## 交付范围

- 新增 `HarnessLocale`、`SUPPORTED_LOCALES` 与默认语言 `zh-CN`，支持 `en-US`。
- `AgentConfigInput.locale` 统一控制 Agent、AgentLoop、模型调用、工具执行、默认 Store 与自动内置工具的诊断文本。
- `defineTool`、`executeTool`、MemorySessionStore、工作区工具和官方 Adapter 支持独立配置 locale。
- 工具参数/输出、Guard、审批、模型协议、预算停止、Session 校验及文件/搜索/终端错误补齐英文消息。
- 保留业务工具、第三方 Store/Adapter、SDK、Zod 和供应商的原始异常，不进行不可靠的文本翻译。
- 不引入全局可变语言状态，允许不同语言实例并发运行。

## 验证

- 新增本地化契约测试，覆盖默认中文、Agent 英文、实例隔离、工具注册/执行、内置工具、Store、Adapter 和非法 locale。
- `pnpm typecheck` 通过。
- `pnpm lint` 通过。

当前协议以[本地化诊断协议](../../standards/protocols/localized-diagnostics.md)为准。
