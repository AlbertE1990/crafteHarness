# ADR-0011：推理强度全链路收敛为单轴字符串，供应商词表与模型名归部署所有

> 状态：Accepted；日期：2026-09-11；实现：2026-09-11。

## 背景

公开推理设置原本是两个字段：`reasoningEnabled` 加 `reasoningEffort`，并同时出现在 `AgentRequest.model`
和 `AgentConfigInput.execution.model` 两个位置。同一个意图因此有三种写法：`{ reasoningEnabled: true }`
（开启）、`{ reasoningEffort: 'high' }`（隐式开启并指定等级）、`{ reasoningEnabled: false }`（关闭）。
调用方必须记住哪一种写法在另一项缺省时生效，库也必须把这三条路径归一化成同一种内部结构。

两字段形态本身需要四条一致性检查，而且请求和配置两个入口都要重复同一套归一化：

1. `reasoningEnabled` 必须是 boolean。
2. `reasoningEffort` 必须是非空字符串。
3. `reasoningEnabled: false` 不能与 `reasoningEffort` 同时出现。
4. 对象字段白名单校验，以及“关闭时必须清除继承的 effort、开启时必须回填默认等级”的联合继承规则。

这些规则不是业务不变量，只是两字段形态的副产物：真正的业务意图只有一根轴——要么关闭推理，要么采用某个
推理等级。库为一条轴维护了两个字段、两条规则和一个隐式启用约定，把复杂度转移给了每个调用方。

同一时期还有两处供应商知识留在库里，方向同样是错的：

- DeepSeek Adapter 持有 `'low' | 'high' | 'max'` 等级白名单。白名单是 fail closed 的设计：DeepSeek 新增
  一档等级时，旧版库会把**合法**请求判成 `MODEL_INVALID_REQUEST`，使用者只能等库发版。真实错误也应该由
  供应商权威给出——供应商返回的 400 已被归一化为同一个 `MODEL_INVALID_REQUEST`，信息比库内旧枚举更准确。
- DeepSeek Adapter 为 `model` 提供了内置默认模型名。模型名属于部署配置、变化频繁，库不该替部署挑模型；
  相比之下 `baseURL` 是该方言自身的稳定 endpoint，保留默认值不构成同样的腐化风险。

Core 的既有原则是“模型和供应商会扩展的能力值不能在 Core 固定枚举，开放值由具体 Adapter 承载”，上面的
白名单和默认模型名都违反了这个原则的精神。前端也把 `none/minimal/low/medium/high/xhigh/max` 写死在
`index.vue`——那是多家供应商词表的整体并集，是最容易腐化的位置。

把公开层收敛成单轴后，内部契约一度仍保留两维 `ModelReasoningOptions { enabled?, effort? }`，由门面一次性
分解。复核后认为这不彻底：矛盾状态只是从门面搬到了 Adapter 层，而且同一个契约值在两个官方 Adapter 里的
含义并不相同。因此同一条决策被贯彻到最后一层：**全链路只有一根轴**。被否决的“外单轴、内两维”方案与理由
记录在本文末的备选方案中。

## 决策

- 删除 `AgentModelExecutionOptions`、`DefinedAgentModelExecutionOptions` 和 `execution.model` 配置组。
  公开形态收敛为单个顶层字符串：`AgentRequest.reasoningEffort` 与 `AgentExecutionConfig.reasoningEffort`。
- 语义固定为单轴：`'off'` 是唯一保留值，按大小写不敏感识别（`'OFF'` 等价）并在解析时统一规范成小写；
  其他任何非空字符串都是供应商定义的等级，原样透传、不做大小写转换，也不做白名单校验；省略该字段时不产生
  任何推理参数，由供应商或模型默认值决定；空白字符串在配置边界报错（错误信息带字段路径，如
  `Agent request.reasoningEffort 必须是非空字符串`）。
- 请求级 `reasoningEffort` 覆盖配置级 `execution.reasoningEffort`；两者都没有时不下发任何推理参数。
- 删除“只提供 effort 会自动启用推理”和“`reasoningEnabled: false` 会清除继承 effort，且不能同时提供
  effort”两条规则。单轴形态下没有第二个字段，无法表达出需要这两条规则约束的矛盾状态。
- **内部契约同样是单轴**：删除 `ModelReasoningOptions`，`ModelRequest.reasoning` 改为
  `ModelRequest.reasoningEffort?: string`；`AgentLoopModelExecutionOptions` 与
  `DefinedAgentLoopModelExecutionOptions` 的 `reasoning` 同样改为 `reasoningEffort`，AgentLoop 直接把该字段
  放进 `ModelRequest`。根入口的显式白名单不再导出这一类型。
- Core 保留值 `'off'` 由 `contracts/model.ts` 的 `REASONING_OFF` 常量唯一提供，Core 与两个官方 Adapter 都从
  它导入，不再各自书写字面量。它是契约词汇的一部分而不是公共 API：`contracts` barrel 导出它供 Adapter 实现
  使用，根入口白名单**不导出**它，使用者也无需认识这个字面量。
- 归一化规则收敛为一份：`core/model-options.ts` 的 `normalizeReasoningEffort(value, path)` 是门面与 AgentLoop
  共用的唯一校验与归一化实现——校验非空字符串，并把保留值统一规范成小写 `'off'`（`'OFF'` 与 `'off'` 等价），
  其他等级原样保留、不做大小写转换；Adapter 直接消费归一化后的结果，按小写 `'off'` 识别，不再自行校验或
  处理大小写。原先 `agent/model-options.ts` 的 `normalizeAgentReasoningEffort()` 删除；
  `resolveAgentReasoningEffort()` 保留，只负责优先级（请求优先、其次部署默认值）；
  `createAgentLoopModelExecution()` 保留，但不再做维度分解，只构造进入循环前冻结的
  `{ stream, reasoningEffort }`。
- Adapter 各自解释保留值，这是本次决策接受的唯一代价。翻译只发生一次、且只发生在 Adapter 内部：
  - DeepSeek：省略 → 两个字段都不发；`'off'` → 只发 `thinking: { type: 'disabled' }`；其他等级 →
    `thinking: { type: 'enabled' }` 加 `reasoning_effort: <等级>`。开关完全由等级派生，因此不存在“关闭却
    指定等级”的请求。
  - OpenAI 兼容：省略 → 不发；`'off'` → `reasoning_effort: 'none'`；其他等级 → 原样下发。语义不同的兼容
    供应商应在自己的差异层覆盖该映射。
- **彻底删除所有防御性矛盾检查**：门面一处、两个 Adapter 各一处原先“`enabled: false` 与 effort 互斥则抛错”
  的检查全部删除，而不是搬到别处。单轴形态下该组合无法被构造，继续保留检查只会让 Adapter 实现者误以为契约
  里仍存在两维状态。
- 删除 DeepSeek Adapter 的等级白名单（`isDeepSeekReasoningEffort()` 与 `DeepSeekRequestExtension.reasoning_effort`
  的封闭联合类型）。`reasoning_effort` 改为开放字符串直接透传，库不做任何等级校验；部署配置只自查自己的
  默认等级，供应商是最终权威。DeepSeek Adapter 继续承担真实协议差异：`thinking: { type: 'enabled' | 'disabled' }`
  与 `reasoning_effort` 的下发、`developer` 消息降级、`reasoning_content` 回放。
- `DeepSeekModelAdapterConfig.model` 从可选改为必填，与 `OpenAICompatibleAgentModelConfig` 对齐；库不再
  内置默认模型名。`baseURL` 仍保留默认值 `https://api.deepseek.com`。
- 推理词表与模型名归部署所有，由 Runtime 通过环境变量拥有：新增必填 `DEEPSEEK_MODEL`（缺失即启动报错）；
  删除 `DEEPSEEK_THINKING`（它原先判断 `process.env.DEEPSEEK_THINKING === 'disabled'`，于是
  `DEEPSEEK_THINKING=false` 这类写法会反过来开启思考）；`DEEPSEEK_REASONING_EFFORT` 成为唯一开关，取值为
  `off` 或任意供应商等级，解析时 trim 加小写归一，并在候选列表非空时校验自身；
  `DEEPSEEK_REASONING_EFFORTS` 是逗号分隔的候选列表（未设置时默认 `off,low,high,max`，留空表示前端退化为
  自由输入），只用于启动期自查和前端下拉，**不校验单次请求**。
- 新增 `GET /api/model`，返回 `{ data: { provider, model, reasoningEffort, reasoningEfforts } }`。
  `reasoningEffort` 是部署默认等级（可能为 `null`），`reasoningEfforts` 是下拉候选列表。前端下拉由此渲染，
  不再硬编码任何供应商词表。`POST /api/chat` 请求体随之变为
  `{ message, sessionId?, stream, reasoningEffort? }`，原 `model: { reasoningEnabled, reasoningEffort }`
  对象删除。
- 核心原则：换模型或增删推理等级 = 改 `.env.local` 加重启，不需要改库，也不需要改前端代码。

## 后果

可表达的状态变少：关闭、指定等级、交给默认值三种意图各有唯一写法，隐式启用约定、字段互斥检查和两维解释
全部消失，门面、AgentLoop 与 Adapter 全程搬运同一个字符串。等级不再被库内旧枚举拒绝，供应商新增等级时无需
等待库发版，错误信息由供应商权威提供；模型名和词表不再随库发版漂移，同一份库可以服务不同部署。

代价是这些知识必须有明确的归属：部署配置只自查自己的默认等级，单次请求的等级由供应商裁定；
`GET /api/model` 必须与 Agent 配置同源，前端不能再把词表当作常量，候选列表为空时页面要退化为自由输入。
Adapter 契约测试需要覆盖“任意非空 effort 原样透传”和“不静默降级”，而不能再用“库拒绝未知等级”作为断言。
本次决策另外接受一个明确代价：保留值的**翻译动作**由每个 Adapter 各自实现一次（DeepSeek 映射为
`thinking.type`，OpenAI 兼容映射为 `reasoning_effort: 'none'`），换来的是内部契约不再存在含义随 Adapter
变化的状态。

迁移规则如下（项目尚未发布，不保留兼容别名或双形态识别）：

- `execution.model = { reasoningEnabled: true, reasoningEffort: 'high' }` → `execution.reasoningEffort: 'high'`。
- `execution.model = { reasoningEnabled: true }` → 删除该配置组，交给供应商默认值。
- `execution.model = { reasoningEnabled: false }` → `execution.reasoningEffort: 'off'`。
- 请求中的 `model: { reasoningEffort: 'max' }` → 请求顶层的 `reasoningEffort: 'max'`；HTTP Runtime 的
  `POST /api/chat` 请求体同步删除这个对象。
- `DEEPSEEK_THINKING=disabled` → `DEEPSEEK_REASONING_EFFORT=off`；其余 `DEEPSEEK_THINKING` 取值一律删除，
  需要覆盖默认等级时改用 `DEEPSEEK_REASONING_EFFORT`（旧写法中 `DEEPSEEK_THINKING=false` 的行为与字面
  含义相反，不能等价迁移）。
- DeepSeek 部署必须补上 `DEEPSEEK_MODEL`，因为库不再回退到内置默认模型名；可选地配置
  `DEEPSEEK_REASONING_EFFORT` 与 `DEEPSEEK_REASONING_EFFORTS` 来声明默认等级和下拉候选。
- **直接使用 AgentLoop 的高级用法**：`model.reasoning` 改为 `model.reasoningEffort`，取值同样是单轴字符串。
- **第三方或自定义 Adapter**：`ModelRequest.reasoning` 改为 `ModelRequest.reasoningEffort`；
  `{ enabled: false }` 写成 `'off'`，`{ enabled: true, effort: X }` 写成 `X`，`{ enabled: true }` 直接省略
  该字段。Adapter 必须自己认识 `'off'` 并翻译成目标协议的关闭语义；Core 已保证传入的是小写字面量，Adapter
  不必再处理大小写。

本 ADR **部分取代** [adr-0008-intent-first-agent-invocation.md](./adr-0008-intent-first-agent-invocation.md) 中
“`AgentRequest.model` 只暴露 `reasoningEnabled/reasoningEffort`，公开层不再提供 `stream` 字段”这一条决策的
前半部分：公开层现在只暴露单个 `reasoningEffort` 字符串。ADR-0008 的其余决策（`invoke/stream` 意图优先、
AbortSignal 作为唯一控制量、Run/Turn ID 由内部生成、AgentLoop 保留 `{ stream, ... }` 高级执行协议而不向公开
层暴露流式开关）继续有效，因此 ADR-0008 保持 Accepted 状态；该高级协议中的推理字段名由本 ADR 定为
`reasoningEffort`。历史 ADR 与 Delivery 记录均保持原样，不被改写；当前协议以本 ADR 与
[Agent 门面规范](../../standards/protocols/agent.md)为准。

## 备选方案

**保留内部两维契约（外单轴、内两维）——已否决。** 这一方案曾短暂采用，理由是“两维差异是真实的协议差异，
应由 Adapter 承担”。复核后否决，原因有三：

1. 它只是把矛盾状态从门面搬到 Adapter：`ModelReasoningOptions` 在类型上仍然允许
   `{ enabled: false, effort: 'high' }`，于是每个 Adapter 都要重新加一次互斥检查——检查没有消失，只是扩散了。
2. 同一个契约值在不同 Adapter 里含义不一致：`{ enabled: true }`（不带 effort）对 DeepSeek 是“强制开启
   思考、等级用供应商默认”，对 OpenAI 兼容 Adapter 却是**什么都不下发**（被静默忽略）。契约值含义随实现
   变化，是比“Adapter 多写一次映射”更贵的成本。
3. 门面永远不产生 `{ enabled: true }`（无 effort）和“只有 effort”这两种形态，它们纯粹是为理论上的兼容性
   留在契约里，却要求所有 Adapter 实现者理解两个字段的组合语义。

其余被否决的方向：保留两字段对象但加强校验，成本最低，但四类一致性检查、隐式启用约定和三种写法会长期留在
公共 API 里，且每次新增配置入口都要复制同一套归一化。只删除 `reasoningEnabled` 而保留 `reasoningEffort`
作为唯一字段，与最终方案接近，但若不规定保留值，就无法表达“显式关闭推理”和“不覆盖部署默认值”之间的差别。
用布尔加枚举两级对象（例如 `{ enabled: 'off' | 'on', effort?: string }`）仍然会重新引入两字段互斥问题。
把等级白名单留在 Adapter 并随供应商发版更新，则把库的发布节奏绑定到供应商能力变化上，正是本 ADR 要消除的
耦合。
