# Session Log 协议

> 文档类型：规范；状态：Accepted。

## 1. 目标

Session Log 是 CraftAgent 的持久事实边界。它使用 append-only 事件记录模型可见消息和 Turn 生命周期，
并从事件确定性推导下一次模型请求所需的 `ModelMessage[]`。

本协议只定义供应商无关 Store、内存实现和消息推导，不接数据库或前端展示类型。

## 2. 核心原则

- 已写入事件不能修改或删除。
- 每个 Session 的 `sequence` 从 1 开始严格递增且无空洞。
- Session `version` 等于当前已写入事件数量。
- 追加必须携带 `expectedVersion`，版本不一致时整批拒绝。
- 一批事件必须全成或全败，不能产生部分写入。
- 事件 ID、sequence 和 timestamp 由 Store 分配，调用方不能伪造。
- 持久化事件必须可以安全转换为 JSON。
- 模型历史只能从 Session Event 推导，不能维护第二份权威可变消息数组。

## 3. 事件结构

调用方先创建 `SessionEventDraft`，Store 成功接受后附加 `SessionEventEnvelope`：

```ts
interface SessionEventEnvelope {
  eventId: string
  sessionId: string
  sequence: number
  timestamp: string
}
```

当前事件类型：

| type               | 事实                                     | 是否进入模型历史 |
| ------------------ | ---------------------------------------- | ---------------- |
| `session.created`  | Session 已创建，可携带 JSON metadata     | 否               |
| `message.appended` | 一条 `ModelMessage` 已成为模型可见历史   | 是               |
| `turn.started`     | 某个 Turn 已开始                         | 否               |
| `turn.completed`   | 某个 Turn 已正常完成                     | 否               |
| `turn.failed`      | 某个 Turn 因安全、可持久化的规范错误结束 | 否               |
| `turn.cancelled`   | 某个 Turn 被调用方取消                   | 否               |

`runId` 和 `turnId` 是关联字段，不用于决定事件顺序。SessionStore 只检查最小事件结构；完整 Turn 状态机
由 AgentLoop 负责。

## 4. Session 初始化

一个新 Session 的第一次追加满足：

```text
expectedVersion = 0
events[0].type = session.created
整条 Session 只能出现一次 session.created
```

创建事件和初始系统消息可以在同一批中提交：

```ts
await store.append({
  sessionId: 'session-1',
  expectedVersion: 0,
  events: [
    { type: 'session.created' },
    {
      type: 'message.appended',
      message: { role: 'system', content: '你是一个 AI 助手。' },
    },
  ],
})
```

这样不会出现“Session 已创建，但初始系统事实尚未写入”的中间状态。

## 5. 乐观并发

```mermaid
sequenceDiagram
  participant A as Writer A
  participant B as Writer B
  participant S as SessionStore

  A->>S: read session，version=4
  B->>S: read session，version=4
  A->>S: append expectedVersion=4
  S-->>A: success，version=5
  B->>S: append expectedVersion=4
  S-->>B: SESSION_VERSION_CONFLICT，actualVersion=5
```

冲突后由上层重新读取并决定是否重试。Store 不能自动把旧决策追加到新历史之后，因为新的事件可能改变
模型上下文和业务含义。

## 6. 一致性分页

`read()` 支持：

- `afterSequence`：从指定 sequence 之后读取。
- `limit`：默认 100，最大 1000。
- `throughVersion`：把多页读取固定到某个版本。

第一页返回 `snapshotVersion`。后续页面必须继续携带该值；读取期间追加的新事件不会混入当前快照。

```text
第一页：snapshotVersion=250，读取 1..100
此时新事件写入，latestVersion=251
第二页：throughVersion=250，读取 101..200
第三页：throughVersion=250，读取 201..250
```

`readSessionSnapshot()` 已封装这个分页过程，并检测 Store 返回 `hasMore=true` 但游标不前进的协议错误。

## 7. 模型消息推导

```mermaid
flowchart LR
  Events[连续 SessionEvent 快照] --> Validate[同一 sessionId<br/>sequence 从 1 连续<br/>首事件为 session.created]
  Validate --> Filter[筛选 message.appended]
  Filter --> Messages[readonly ModelMessage 数组]
  Messages --> Model[下一次 ModelAdapter 请求]
```

`deriveModelMessages()` 不会排序、不修复坏序列，也不会把 Turn 状态和诊断信息发送给模型。发现混合 Session、
sequence 空洞或缺少创建事件时直接失败。

工具调用和工具结果仍使用模型协议中的 assistant `tool_calls` 消息与 `role: 'tool'` 消息，因此它们同样通过
`message.appended` 成为可重建历史。

## 8. JSON 持久化边界

`MemorySessionStore` 在提交前通过 JSON 往返复制事件，拒绝：

- 循环引用。
- `bigint`。
- 函数和 Symbol。
- `NaN`、`Infinity` 和 `-Infinity`。

输入副本和返回事件会被深度冻结，调用方之后修改原对象不能改写日志。

数据库 Store 必须提供等价的序列化约束，不能依赖 ORM 的静默转换。

## 9. Store 接口

```ts
interface SessionStore {
  append: (
    request: AppendSessionEventsRequest,
  ) => Promise<AppendSessionEventsResult>

  read: (
    sessionId: string,
    options?: ReadSessionEventsOptions,
  ) => Promise<SessionEventPage>

  list?: (
    options?: ListSessionsOptions,
  ) => Promise<SessionListPage>
}
```

实现要求：

- `append()` 的版本比较、sequence 分配和整批写入必须处于同一原子边界。
- `eventId` 在 Store 范围内唯一。
- 相同 Session 的事件按 sequence 返回。
- `throughVersion` 不能读取超过指定版本的事件。
- 未找到的 Session 读取为空快照，version 为 0；创建仍必须显式追加 `session.created`。
- `list()` 是可选目录能力，按首次创建顺序使用 `afterSessionId` 和 `limit` 分页。
- 列表只返回 sessionId、createdAt、version 和 metadata；完整消息仍由事件快照推导。
- 实现不得把数据库连接、ORM 类型或供应商异常泄漏到 Core 协议。

## 10. 规范错误

| code                             | 含义                             |
| -------------------------------- | -------------------------------- |
| `SESSION_INVALID_ARGUMENT`       | ID、版本、分页或事件参数无效     |
| `SESSION_VERSION_CONFLICT`       | expectedVersion 与实际版本不一致 |
| `SESSION_INVALID_EVENT_SEQUENCE` | 初始化、顺序或读取协议不成立     |
| `SESSION_SERIALIZATION_FAILED`   | 事件不能安全持久化为 JSON        |
| `SESSION_EVENT_ID_CONFLICT`      | Store 生成了重复事件 ID          |

## 11. 当前明确不实现

- 数据库、Redis 或文件 Store。
- Session 删除、归档和搜索。
- Session 压缩、摘要和历史裁剪。
- 轨迹、指标和异常堆栈日志。
- 将 Runtime 或前端展示字段写入 Core Session 协议。

这些能力不能通过修改已写入事件实现；需要时应增加新事件、Store 适配器或上层投影。
当前 Agent Loop 如何消费本协议见[Agent Loop 协议](./agent-loop.md)。
