# 阶段 4.1：CraftAgent 统一门面与 Server 迁移

- 文档类型：交付记录
- 状态：代码、离线测试、Server 接入和文档已完成
- 日期：2026-09-08

## 本阶段目标

将产品名和源码根统一为 CraftAgent，并在不把 HTTP、数据库或前端协议引入核心的前提下，提供开发者可直接
构造和调用的 `Agent` 对象。

## 实际完成

- `src/common-agent` 迁移为 `src/craft-agent`，代码、测试和文档引用同步更新。
- 根入口默认导出 `Agent`，保留全部底层协议的命名导出。
- 新增 `defineAgentConfig()`，统一模型 Adapter、工具、Store、预算和测试注入点。
- 内置 DeepSeek、OpenAI Compatible 配置，同时接受直接传入的自定义 ModelAdapter。
- 新增异构工具归一化边界；后续已进一步收进 Agent 配置，普通调用方无需显式组装。
- `Agent.run()` 自动生成可注入的 Session ID，并分离精简应用事件与完整轨迹事件。
- 新增 `getSession()` 和分页 `listSessions()`。
- 新增会话目录能力，MemorySessionStore 实现稳定创建顺序分页；后续由 `SessionCatalogStore` 独立表达该能力。
- 官方 Adapter 改为直接依赖 contracts，避免根入口默认导出 Agent 后形成循环依赖。
- 删除过渡 `src/server/agent.ts` 和 `src/server/agent-config.ts`。
- Fastify 只读取环境变量、构造 Agent、映射 SSE 与前端展示字段。

## 验证范围

- 声明式内置模型配置与直接自定义 Adapter。
- 自动 Session ID、精简事件、全量轨迹和观察器分层。
- 会话读取、创建顺序分页和跨 Turn 历史恢复。
- Tool Call 分片组装与 Tool Harness 执行。
- Fastify HTTP/SSE 边界和会话列表投影。
- Core 对 OpenAI SDK 和官方 Adapter 的依赖边界。

## 后续范围

- 持久化、分页查询和脱敏 Agent 轨迹。
- 可注入 DiagnosticSink，记录原始 stack、cause 与 Node 错误字段。
- 数据库 SessionStore。
- 真实 DeepSeek 环境联调。
- 长期第三方工具信任、幂等审查和沙箱。
