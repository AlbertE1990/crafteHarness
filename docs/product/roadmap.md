# craft-harness 分阶段开发路线图

> 文档类型：产品路线图；状态：Active。

## 1. 当前优先级原则

- **先完成可运行的 Agent 主链，再扩展低收益的防御性体系。**
- 每个阶段先在同一个仓库内测试验证；库与官方案例共享仓库，但发布单元只有一个：库发布 `src/**` 的产物，
  案例位于 `sample/` 且不参与打包。
- craft-harness 核心继续保持与模型 SDK、HTTP 框架、数据库驱动和前端解耦。
- 当前使用者是能够修改并运行服务端代码的第一方开发者，暂不支持不可信第三方工具注入。
- 工具默认不重试；配置重试即表示开发者允许重复调用，真实幂等性由业务实现保证。
- 安全信任、插件沙箱和第三方代码治理放在核心功能完成后的长期强化阶段。

## 2. 阶段总览

```mermaid
flowchart LR
  P1[阶段 1<br/>Tool Harness<br/>已完成] --> P11[阶段 1.1<br/>接入现有 Server<br/>已完成]
  P11 --> P2[阶段 2<br/>ModelAdapter<br/>代码已完成]
  P2 --> P21[阶段 2.1<br/>官方 Adapter 工具包<br/>已完成]
  P21 --> P3[阶段 3<br/>Session Log<br/>已完成]
  P3 --> P4[阶段 4<br/>Agent Loop<br/>已完成]
  P4 --> P41[阶段 4.1<br/>craft-harness 门面<br/>已完成]
  P41 --> P42[阶段 4.2<br/>内置工具自动装载<br/>已完成]
  P42 --> P43[阶段 4.3<br/>SessionStore 持久化契约<br/>已完成]
  P43 --> P44[阶段 4.4<br/>Agent API 归一化与收口<br/>已完成]
  P44 --> P45[阶段 4.5<br/>PostgreSQL 学习基座<br/>已完成]
  P45 --> P46[阶段 4.6<br/>会话读模型与 PostgreSQL Store<br/>已完成]
  P46 --> P47[阶段 4.7<br/>ToolGuard 与内置审批管理<br/>已完成]
  P47 --> P48[阶段 4.8<br/>配置分组与公共 API 收口<br/>已完成]
  P48 --> P49[阶段 4.9<br/>单次模型设置与非流式 JSON<br/>已完成]
  P49 --> P410[阶段 4.10<br/>分层 Guard 与运行上下文<br/>已完成]
  P410 --> P411[阶段 4.11<br/>意图优先调用 API<br/>已完成]
  P411 --> P412[阶段 4.12<br/>配置减负与统一 Guard<br/>已完成]
  P412 --> P413[阶段 4.13<br/>多用户 Session Catalog<br/>已完成]
  P413 --> P414[阶段 4.14<br/>推理强度单轴化与配置外置<br/>已完成]
  P414 --> P415[阶段 4.15<br/>拆分为可发布 npm 包<br/>已完成]
  P415 --> P416[阶段 4.16<br/>工作区工具与案例契约<br/>已完成]
  P416 --> P5[阶段 5<br/>轨迹持久化与查询<br/>下一阶段]
  P5 --> P6[阶段 6<br/>异常诊断]
  P6 --> P7[阶段 7<br/>长期安全与扩展]
```

## 3. 阶段 1：工具协议与 Harness（已完成）

完成范围：

- `defineTool()` 将 Schema、实现和执行元数据放在一起。
- Zod 输入/输出校验及 Draft 7 JSON Schema 投影。
- allow/deny/ask 策略与单次审批。
- 显式重试、随机退避、协作式超时和取消。
- `ToolError`、`ToolExecutionResult` 和工具轨迹事件。
- `get_current_time`、`calculator` 安全内置工具。

学习入口见[Tool Harness 学习指南](../learning/tool-harness.md)。

## 4. 阶段 1.1：接入现有 Server（已完成）

目标是先在真实 DeepSeek 对话中使用和验证 craft-harness 工具协议。

当前完成：

- Server 的工具通过 `defineTool()` 定义并直接传给 Agent，模型参数仍只来自 `DefinedTool.model`。
- 模型 Tool Call 由 craft-harness AgentLoop 通过 `executeTool()` 执行。
- 时间、IP 定位和天气工具使用 `defineTool()` 统一 Schema 与实现。
- 移除旧的手写 `tools.json` 和旧 Tool Harness，避免双协议漂移。
- 支持通过静态注册表开发第一方自定义工具。
- 服务端工具测试覆盖 Schema 投影、输入校验、输出和网络重试。

阶段验证：

1. 使用真实 DeepSeek 测试时间、指定城市天气和自动定位天气。
2. 按[自定义工具开发实践](../learning/custom-tool-development.md)新增一个简单工具。
3. 验证错误输入、错误输出和可重试异常是否符合预期。
4. 自定义工具通过静态注册表接入，不修改 Agent 分支。

## 5. 阶段 2：ModelAdapter（代码已完成，真实联调待执行）

目标是让 Agent Loop 只依赖内部模型协议，不直接依赖 OpenAI SDK。

已完成范围：

- 定义供应商无关消息、工具调用、用量和结束原因。
- 同时定义非流式响应与标准流事件。
- 定义 `ModelAdapter` 接口、取消语义和错误分类。
- 第一份实现采用 DeepSeek；OpenAI 兼容 SDK 只能存在于 adapter 内部。
- adapter 将 `DefinedTool.model` 转换成供应商格式。
- 使用契约测试保证供应商类型不泄漏到 craft-harness 核心。
- 标准 chunk 最大程度复用 OpenAI Chat Completions，新增字段采用只增不减原则。
- 增加统一模型配置，并在阶段 4.1 收敛为 `defineAgentConfig()`。

真实环境验收仍需配置 `DEEPSEEK_API_KEY`（阶段 4.14 起模型名由必填的 `DEEPSEEK_MODEL` 提供，不再回退到内置
默认模型名），覆盖普通对话、工具调用、多轮 `reasoning_content` 回放和取消。
详细交付见[阶段 2 记录](./deliveries/delivery-003-model-adapter.md)。

## 6. 阶段 2.1：官方 Adapter 工具包（已完成）

目标是在不改变 Core 依赖方向的前提下，让常见模型开箱即用，并为新 Adapter 提供可运行范例。

已完成范围：

- 提取 `OpenAICompatibleModelAdapter`，复用消息、工具、响应、流、usage 和错误映射。
- 将 DeepSeek 收缩为消息、token 参数、thinking 与 reasoning 字段的差异层。
- 仓库测试目录提供 Scripted Adapter 与不绑定测试框架的契约探针，不把测试夹具作为生产 API。
- Agent 配置同时支持内置兼容服务和自定义 Adapter。
- 生产 Adapter 使用独立入口，测试工具留在 `test/support`，Core 继续禁止导入 SDK。

详细交付见[阶段 2.1 记录](./deliveries/delivery-004-official-adapter-toolkit.md)，设计依据见
[ADR-0003](./decisions/adr-0003-official-adapter-toolkit.md)。

## 7. 阶段 3：Session Log（已完成）

已完成范围：

- 定义 append-only `SessionEvent`。
- 实现内存 `SessionStore`，不接具体数据库。
- 从事件推导模型消息，而不是维护第二份可变消息数组。
- 使用批量原子追加和 `expectedVersion` 乐观并发。
- 分页读取固定 `throughVersion`，得到一致性快照。
- 事件通过 JSON 序列化边界复制并冻结。
- 提供稳定错误、离线测试、协议规范和学习文档。

详细交付见[阶段 3 记录](./deliveries/delivery-005-session-log.md)，设计依据见
[ADR-0004](./decisions/adr-0004-append-only-session-log.md)。

## 8. 阶段 4：Agent Loop（已完成）

已完成范围：

- 建立 Run、Turn、Step、Tool Call 和 Attempt 状态模型。
- 串联 ModelAdapter、Tool Harness 与 Session Store。
- 支持最大 Step、最大工具调用、每 Step completion token、总 token、时间预算和取消。
- 定义 completed/stopped/failed 终态与稳定停止原因，防止无限循环。
- 从 Session 固定快照生成每次模型请求，并通过 expectedVersion 阻止旧上下文结果写入。
- 组装流式 `reasoning_content`、content、usage 和分片 Tool Call。
- 工具按 index 串行执行；未知工具和 Harness 失败写回模型继续处理。
- 提供独立于持久化 Session 的实时 Agent Event，观察器异常不影响主链。
- 明确当前不自动重试模型、并行工具或恢复崩溃后未完成 Tool Call。

详细交付见[阶段 4 记录](./deliveries/delivery-006-agent-loop.md)，设计依据见
[ADR-0005](./decisions/adr-0005-deterministic-agent-loop.md)。

## 9. 阶段 4.1：craft-harness 门面与 Server 迁移（已完成）

已完成范围：

- 产品名、源码目录、导入和文档统一迁移为 craft-harness。
- 默认导出 `Agent`，并提供 `defineAgentConfig()`；原始 DefinedTool 由配置边界自动归一化。
- 声明式创建内置 DeepSeek/OpenAI Compatible Adapter，或直接注入自定义 Adapter。
- 自动 Session ID、精简输出事件、完整 `onTrace` 和 Session 查询。
- SessionStore 增加可选会话目录能力，MemorySessionStore 支持创建顺序分页。
- 删除 Server 过渡 Agent/Config；Fastify 只保留部署配置、HTTP/SSE 和展示投影。

详细交付见[阶段 4.1 记录](./deliveries/delivery-007-agent-facade.md)。

## 10. 阶段 4.2：Agent 内置工具自动装载（已完成）

已完成范围：

- Agent 默认装载 `get_current_time` 和 `calculator`。
- 工具配置支持禁用、显式同名覆盖、追加和整体替换。
- 配置阶段拒绝歧义组合与静默名称覆盖。
- Server 工具注册表只保留应用拥有的定位和天气工具。

详细交付见[阶段 4.2 记录](./deliveries/delivery-008-default-builtin-tools.md)，设计依据见
[ADR-0006](./decisions/adr-0006-agent-default-builtin-tools.md)。

## 11. 阶段 4.3：SessionStore 持久化契约（已完成）

已完成范围：

- 明确 SQL、ORM、Service 和 API 只通过 SessionStore Port 接入。
- 增加外部持久化操作错误及操作类型。
- 在 `test/support` 增加可复用、无测试框架依赖的 SessionStore 契约探针。
- 定义 SQL 原子事务、远程 API 幂等和 Runtime 生命周期边界。
- 提供从 MemorySessionStore 调试到 PostgreSQL 实现的完整学习教程。
- 明确 Session 持久化不是模型工具，不提供通用 SQL 内置工具。

详细交付见[阶段 4.3 记录](./deliveries/delivery-009-session-store-persistence-contract.md)，设计依据见
[ADR-0007](./decisions/adr-0007-session-store-persistence-port.md)。

## 12. 阶段 4.4：Agent API 归一化与预发布收口（已完成）

已完成范围：

- Agent 工具配置直接接受 `defineTool()` 结果，不要求调用方预先转换。
- 追加、覆盖和整体替换统一执行“归一化 → 去重 → 冻结”。
- 工具配置只保留 `defineTool()` 产物这一种输入，不接受内部 `AgentTool` 执行结构。
- 删除额外的工具组装入口和双形态兼容分支。
- 自定义模型只直接接受 `ModelAdapter`，删除无使用者的包装配置。
- `SessionStore` 与 `SessionCatalogStore` 分别表达执行和目录能力，不在基本接口重复声明可选 `list()`。
- 删除未被实现或使用的输出投影器类型草案。
- Server 和普通文档示例移除额外工具组装步骤。
- 开发规范沉淀“降低使用者心智负担”的公共 API 原则。

详细交付见[阶段 4.4 记录](./deliveries/delivery-010-internal-tool-normalization.md)。

## 13. 阶段 4.5：PostgreSQL 持久化学习基座（已完成）

已完成范围：

- 创建本地 PostgreSQL 开发数据库和通用 Session Log 表。
- 提供可重复迁移、Node 连接配置及数据库检查命令。
- 建立 `PostgresSessionStore` 学习骨架和独立契约测试入口。
- 保留 `read/append/list` 实现、Server 注入和重启恢复验证作为学习任务。
- 常规 Agent 测试继续使用 MemorySessionStore，不依赖本地数据库。

详细交付见[阶段 4.5 记录](./deliveries/delivery-011-postgres-learning-scaffold.md)。

## 14. 阶段 4.6：会话读模型与 PostgreSQL Store（已完成）

已完成范围：

- 会话目录只读取摘要，详情按 Session ID 加载，消除列表 N+1 和全历史读取。
- 详情消息保留事件、Run 和 Turn 关联信息。
- 完成 PostgreSQL SessionStore 的事务追加、固定快照读取和稳定目录分页。
- Server Runtime 正式注入 PostgreSQL Store，并管理连接池生命周期。
- 契约测试使用自动清理的临时 schema，不污染开发数据。

详细交付见[阶段 4.6 记录](./deliveries/delivery-012-session-query-and-postgres-store.md)。

## 15. 阶段 4.7：ToolGuard 与内置审批管理（已完成）

已完成范围：

- Agent 公共配置将风险决策收口为单一评估函数；阶段 4.12 已将其归入 `tools.guard` 并与局部 Guard 统一协议。
- 评估器按工具静态信息和已校验参数返回 `allow/deny/ask`。
- Agent 内部管理一次性审批 ID、pending Promise、超时、取消和重复提交。
- 单次 ask 超时优先于 ToolGuard 通用超时；`-1` 表示永久等待，其余情况通过事件暴露绝对过期时间。
- `AgentOutputEvent` 成为 Runtime 可直接输出的标准应用事件，避免默认维护第二套字段投影。
- 自动拒绝和用户拒绝都只产生当前工具失败，由 AgentLoop 写入 `role=tool` 后继续模型循环。
- 删除未发布的 Agent `toolPolicy/requestToolApproval` 双入口和 Runtime ApprovalBroker 接线。

详细交付见[阶段 4.7 记录](./deliveries/delivery-013-agent-tool-guard.md)。

## 16. 阶段 4.8：配置分组与公共 API 收口（已完成）

已完成范围：

- 本阶段建立配置分组；阶段 4.12 进一步将单字段 `session` 收口为根 `sessionStore`，并将全局 Guard 归入 `tools`。
- 默认提供 OpenAI Compatible 声明式模型配置，只有供应商协议差异才要求显式选择或实现 Adapter。
- 输入配置和 `agent.config` 使用相同分组，不保留旧扁平配置兼容层。
- 新增可公开命名的 `AgentToolInput`，内部工具归一化实现继续隐藏。
- craft-harness 根入口改为显式导出白名单，生产 Adapter 保留独立高级入口。
- Adapter、Session 契约探针和学习型可执行测试迁入 `test/`，删除生产源码中的 testing 子入口。
- 开发规范新增配置分组、公共导出和测试代码放置原则。

详细交付见[阶段 4.8 记录](./deliveries/delivery-014-config-and-public-api.md)。

## 17. 阶段 4.9：单次模型设置与非流式 JSON（已完成）

已完成范围：

- 本阶段曾由 `execution.model` 同时定义流式与推理默认值；阶段 4.11 已用意图优先 API 替代该调用形态，
  阶段 4.14 进一步删除 `execution.model` 分组，只保留单个 `execution.reasoningEffort`。
- 通用推理等级使用开放字符串，由具体 Adapter 映射到供应商字段；阶段 4.14 起不再在 Adapter 维护合法集合。
- AgentLoop 同时执行 `stream()` 与 `complete()`，并为完整响应提供独立轨迹事件。
- 当前联调 Runtime 在流式时使用 SSE，非流式时返回普通 JSON。
- 明确同步 JSON 无法承载中途人工审批；当前 fail-closed，未来如有需求再设计异步任务协议。

详细交付见[阶段 4.9 记录](./deliveries/delivery-015-run-model-options-and-json.md)。

## 18. 阶段 4.10：分层 Guard、metadata 与运行上下文（已完成）

已完成范围：

- 删除无法由框架证明且与 retry 重复的 `security/idempotent`，工具改用任意 JSON 安全 `metadata`。
- 超时与重试收进 `execution`；配置 retry 本身表示工具作者允许重复调用。
- 工具级 Guard 和 Agent 全局 Guard 固定执行，按 `deny > ask > allow` 合并；缺省 Guard 直接允许。
- `new Agent<TContext>()` 的请求 context 将租户、用户和环境数据只传给当前 Guard 与工具执行。
- 内置工具可通过 `tools.guardOverrides` 替换或移除局部 Guard，全局 Guard 始终执行。
- 审批标准事件使用通用 `toolMetadata`，不再固化 risk 枚举。

详细交付见[阶段 4.10 记录](./deliveries/delivery-016-layered-tool-guards.md)。

## 19. 阶段 4.11：意图优先的 Agent 调用 API（已完成）

已完成范围：

- `invoke()` 与 `stream()` 分别表达完整结果和实时事件，不保留可矛盾的公共 `model.stream`。
- 请求级模型设置进入 `AgentRequest.model`，公开为 `reasoningEnabled/reasoningEffort` 扁平字段；阶段 4.14
  已删除该对象，收敛为请求顶层的单个 `reasoningEffort` 字符串。
- 唯一控制参数直接使用 AbortSignal；关联 ID 与轨迹接线由 Agent 配置统一管理。
- `stream()` 提供带背压和消费者取消的 `AsyncIterable<AgentOutputEvent>`。
- AgentLoop 与 Adapter 继续使用内部嵌套协议，由门面承担转换复杂度。

详细交付见[阶段 4.11 记录](./deliveries/delivery-017-intent-first-agent-api.md)。

## 20. 阶段 4.12：配置减负与统一 Guard 协议（已完成）

已完成范围：

- 公共 `AgentConfigInput` 删除 `createId/createSessionId`，内部统一使用语义前缀加 UUID。
- 单字段 `session.store` 改为根 `sessionStore`。
- 全局风险策略改为直接函数 `tools.guard`，审批默认值为同组的 `tools.approvalTimeoutMs`。
- 工具定义的局部入口统一命名为 `guard`；局部和全局 Guard 共用请求与决定协议。
- `AgentRequest.context` 原样进入同一个 Guard 请求对象，并继续传给工具执行上下文。
- 不保留未发布旧配置的兼容别名，避免形成双入口。

详细交付见[阶段 4.12 记录](./deliveries/delivery-018-agent-config-and-guard-context.md)。

## 21. 阶段 4.13：可搜索、多用户 Session Catalog（已完成）

已完成范围：

- 将 `sessionName` 从不透明 metadata 提升为标准 Session 字段和可索引目录列。
- 引入不解释业务身份的稳定 `scopeId`，让个人、租户、团队或项目使用同一隔离协议。
- 不增加 Agent 配置项；由调用方在 `invoke/stream/get/list` 的请求中组装 `scopeId`。单用户传固定
  默认值，多用户从可信认证结果确定。
- 所有 Session 读写和目录搜索同时约束作用域，且不同 scope 可以使用相同 sessionId。
- Memory/PostgreSQL Store 使用相同的大小写不敏感字面子串名称搜索语义。
- 当前身份和权限仍由可信 Runtime 放入 context；scope 只负责持久化分区，不作为授权证明。
- 新增 002 数据库迁移、迁移版本记录和旧 metadata 名称回填；真实开发库及 PostgreSQL 契约均已验证。
- 应用自定义查询字段放在应用自己的投影表或 Repository，不继续扩大 craft-harness 目录表。
- 名称重命名留作后续独立协议，不在本阶段引入不完整的覆盖式更新。

详细交付见[阶段 4.13 记录](./deliveries/delivery-019-searchable-multi-user-session-catalog.md)，设计依据见
[ADR-0010](./decisions/adr-0010-searchable-multi-user-session-catalog.md)。

## 22. 阶段 4.14：推理强度单轴化与运行时配置外置（已完成）

已完成范围：

- 删除 `AgentModelExecutionOptions`、`DefinedAgentModelExecutionOptions` 和 `execution.model` 分组，公开形态
  收敛为单个顶层字符串：`AgentRequest.reasoningEffort` 与 `AgentExecutionConfig.reasoningEffort`。
- `'off'` 是唯一保留值，按大小写不敏感识别并统一归一化为小写；其他非空字符串是供应商等级，原样透传；
  省略时不产生任何推理参数，空白字符串在配置边界报错。
- 删除“只提供 effort 会自动启用推理”和“关闭推理时会清除继承 effort，且不能同时提供 effort”两条规则；
  单轴形态下不存在可表达的矛盾状态。
- 内部契约同步收敛为单轴：删除 `ModelReasoningOptions`，`ModelRequest.reasoning` 改为 `reasoningEffort`，
  AgentLoop 的执行设置与门面字段同名同形，层间不再做维度分解；`normalizeReasoningEffort()` 成为门面、
  AgentLoop 与 Adapter 共用的唯一归一化规则。
- 保留值 `'off'` 由 `contracts/model.ts` 的 `REASONING_OFF` 常量唯一提供，不进入根入口的公共导出；两个
  官方 Adapter 各自把它翻译成自己的关闭字段（DeepSeek 用 `thinking.type`，OpenAI 兼容用
  `reasoning_effort: 'none'`）。
- 删除 DeepSeek Adapter 的推理等级白名单，`reasoning_effort` 改为开放字符串直接透传：过期的白名单会在合法
  输入上 fail closed，而供应商返回的 400 已被归类为 `MODEL_INVALID_REQUEST`。
- 门面与两个 Adapter 里原先针对 `enabled: false` 加 effort 的防御性互斥检查全部删除，而不是搬到别处。
- DeepSeek Adapter 的 `model` 改为必填，库不再内置默认模型名；`baseURL` 仍保留方言自身的稳定默认值。
- Runtime 配置外置：新增必填 `DEEPSEEK_MODEL`，删除判断有缺陷的 `DEEPSEEK_THINKING`，
  `DEEPSEEK_REASONING_EFFORT` 成为唯一开关，`DEEPSEEK_REASONING_EFFORTS` 提供下拉候选并只用于启动期
  自查，不校验单次请求。
- 新增 `GET /api/model`，聊天请求体收敛为 `{ message, sessionId?, stream, reasoningEffort? }`；前端
  下拉改由部署词表驱动，不再硬编码多家供应商等级词表。
- 换模型或增删推理等级只需改 `sample/.env.local` 并重启，不需要改库，也不需要改前端代码。

设计依据见 [ADR-0011](./decisions/adr-0011-single-axis-reasoning-effort.md)，协议细节见
[Agent 门面规范](../standards/protocols/agent.md)与 [Server Runtime 接入规范](../standards/integrations/server-runtime.md)。

## 23. 阶段 4.15：拆分为可发布 npm 包（已完成）

目标：让仓库根成为真正可发布的库，同时保留一个可运行的官方应用案例。此前库与应用混在同一个 `src/` 下，
既无法发布，也无法验证“使用者按包名导入”这条真实路径。

已完成范围：

- 仓库根即发布包：包名 `craft-harness`、版本 `0.1.0`、ESM-only，`exports` 暴露 `.` 与 `./adapters`，
  `files: ["dist"]`，零运行期 `dependencies`，`openai` 与 `zod` 均为 peerDependency。
- 库源码上提一层：原 `src/craft-agent/**` 整体变为 `src/**`（`contracts`、`core`、`agent`、`tools`、
  `sessions`、`adapters`、`builtins`、`types` 都少了一层目录）。
- 应用整体下移为官方案例：`src/server/**` → `sample/src/server/**`，`src/pages/index.vue` →
  `sample/src/pages/index.vue`，`database/` → `sample/database/`，`vite.config.ts`、`uno.config.ts`、
  `index.html`、`auto-imports.d.ts`、`components.d.ts`、`shims.d.ts` 与 `sample/.env.example` 同样位于 `sample/`。
- 测试分成两份：库测试留在 `test/`（`test/support/*` 是共享替身），案例测试进入 `sample/test/`；
  根 `vitest.config.ts` 改为两个 vitest project——`harness`（node 环境）与 `sample`（jsdom，引用
  `sample/vite.config.ts`）。
- 改名 `craft-agent` → `craft-harness`：改的是包名与文档称谓，导出的符号（`Agent`、`AgentLoop`、
  `defineAgentConfig`、`defineTool`、`MemorySessionStore` 等）一个都没变。
- 新增 `scripts/smoke-pack.mjs` 打包冒烟测试与 `sample/tsconfig.json`；根 `tsconfig.json` 只覆盖库
  （`src/**`，node only，无 DOM）。
- 删除模板残留：`src/components/TheCounter.vue|TheFooter.vue|TheInput.vue`、`test/basic.test.ts`、
  `test/component.test.ts`；`test/craft-agent-tools.test.ts` 重命名为 `test/tool-harness.test.ts`。
- 脚本语义随之调整：`pnpm build` 从“构建前端”变为“构建库”，前端构建改为 `pnpm build:sample`；
  `postinstall` 改为 `prepare`，避免使用者在安装依赖时被改动 git hooks。

阶段验证：

1. `pnpm build`、`pnpm typecheck`、`pnpm lint` 与 `pnpm smoke:pack` 全部通过。
2. `pnpm test` 同时运行库与案例两个 vitest project，全部用例通过。
3. `pnpm pack` 产物安装到临时项目后，可按包名导入根入口与 `craft-harness/adapters`，且根入口没有泄漏
   内部归一化实现。
4. `test/model-boundary.test.ts` 断言 `src/**` 不导入 `sample/`，库对案例的依赖方向由测试守住。

设计依据见
[ADR-0012：仓库拆分与包名 craft-harness](./decisions/adr-0012-package-extraction-and-naming.md)，仓库布局见
[总体架构](../standards/architecture.md)，案例 Runtime 的组装边界见
[Server Runtime 接入规范](../standards/integrations/server-runtime.md)。

## 24. 阶段 4.16：工作区工具与案例契约收口（已完成）

已完成范围：

- 默认新增 `read/write/edit/glob/grep/terminal`，并复用禁用、同名覆盖、Guard 覆盖、追加与 replace。
- 文件路径受 workspace 和符号链接边界约束；已有文件采用读后改版本检查与临时文件原子发布。
- 搜索通过运行期依赖 `@vscode/ripgrep` 执行，不拼接 shell，并限制数量、时间与捕获字节。
- 写、编辑和终端默认 ask；终端是跨平台一次性 shell，并明确不是 OS 沙箱。
- 案例 HTTP Schema 由 Zod 投影，聊天请求字段统一为 sessionId；同步 Logo 和横向轮次导航。

详细交付见[Delivery 020](./deliveries/delivery-020-workspace-tools-and-sample-contract.md)，设计依据见
[ADR-0013](./decisions/adr-0013-default-workspace-tools.md)。

## 25. 阶段 4.17：模型选择与内置工具边界收口（已完成）

已完成范围：

- Adapter 与模型选择分离；配置和请求统一使用 `{ id, reasoningEffort? }`。
- 请求级模型整体覆盖默认选择，同一 Agent/Adapter 可在运行时切换同协议模型。
- 删除声明式 Adapter 联合类型，`execution` 收窄为预算和可注入时钟。
- 内置工具归入 `src/tools/builtins`，工作区工具改为由 `workspaceRoot` 显式启用。

详细交付见[Delivery 021](./deliveries/delivery-021-model-selection-and-tool-layout.md)，决策依据见
[ADR-0014](./decisions/adr-0014-explicit-adapter-and-model-selection.md)与
[ADR-0015](./decisions/adr-0015-opt-in-workspace-tools.md)。

## 26. 阶段 5：轨迹持久化与查询（下一阶段）

计划范围：

- 暴露可分页查询的轨迹接口，服务前端调试。
- 定义独立 TraceStore 或 TraceSink，不与 Session 的模型事实混写。
- 支持轨迹脱敏、按 Session/Run 查询和保留策略。
- Runtime 将 Agent `onTrace` 接入轨迹存储和调试查询。
- 保持前端展示数据不进入 craft-harness 核心协议。

## 27. 阶段 6：异常诊断

主链稳定后补充服务端诊断，不阻塞 ModelAdapter、Session 和 Loop 开发。

计划范围：

- 定义供应商无关、可注入的 `DiagnosticSink` 或最小 `AgentLogger`。
- 在原始异常归一化前记录 `stack`、`cause` 和安全的 Node 错误字段。
- 使用 `errorId` 关联公开错误、轨迹和服务端诊断。
- 覆盖工具、Guard、审批、模型 Adapter 和事件输出异常。
- Runtime 负责接入具体日志库、日志级别和输出位置。
- 日志 Sink 故障不能改变 Agent 业务结果。

## 28. 阶段 7：长期安全与扩展（最低优先级）

只有项目需要加载不可信第三方工具时，才评估以下能力：

- 工具来源、版本、代码摘要和部署侧 allowlist。
- 第三方幂等声明审查或 Runtime 重试许可。
- 受控文件、网络、数据库和 Secret Broker。
- 独立低权限进程、容器或 OS 沙箱。
- 文件系统挂载、网络出口、资源和系统调用限制。
- 更多模型 Adapter、评测体系和 OpenTelemetry。
- 协议稳定后评估把扩展能力拆成独立子包（例如自建 Adapter 集合），而不是继续扩大单一包。

当前明确不实现：

- 自动分析任意 JavaScript 是否真正幂等。
- 根据工具源码自动推断真实风险。
- 第三方插件安装和权限管理体系。
- 为尚不存在的第三方工具场景提前搭建沙箱。

[安全与信任模型](../standards/security/trust-model.md)保留为长期边界说明，不作为前序功能阶段的验收项。
