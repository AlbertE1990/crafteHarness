# 架构决策记录

ADR 记录重要技术选择及其背景、备选方案和后果。

- [ADR-0001：采用 Zod 作为工具 Schema 单一来源](./adr-0001-zod-tool-contract.md)
- [ADR-0002：模型流协议以 OpenAI Chat Completions 为兼容基线](./adr-0002-openai-compatible-model-contract.md)
- [ADR-0003：官方 Adapter 随项目提供但不进入 Core 依赖](./adr-0003-official-adapter-toolkit.md)
- [ADR-0004：Session 使用 append-only Event Log](./adr-0004-append-only-session-log.md)
- [ADR-0005：Agent Loop 使用 Session 驱动的确定性串行状态机](./adr-0005-deterministic-agent-loop.md)
- [ADR-0006：Agent 默认装载安全内置工具](./adr-0006-agent-default-builtin-tools.md)
- [ADR-0007：外部持久化只通过 SessionStore Port 接入](./adr-0007-session-store-persistence-port.md)
- [ADR-0008：Agent 调用采用意图优先的 invoke/stream API](./adr-0008-intent-first-agent-invocation.md)
- [ADR-0009：Agent 配置按使用意图减负并统一 Guard 协议](./adr-0009-agent-config-and-guard-context.md)

状态使用：

- `Proposed`：等待评审。
- `Accepted`：当前有效。
- `Superseded`：已被后续 ADR 替代，并必须链接替代项。
- `Rejected`：评审后未采用，仅保留历史依据。
