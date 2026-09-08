# ADR-0004：Session 使用 append-only Event Log

- 文档类型：架构决策
- 状态：Accepted
- 日期：2026-09-08

## 背景

过渡 Agent 使用可变 `messages` 和会话数组保存上下文。覆盖数组虽然简单，但不能可靠回答某条消息何时产生、
一次 Turn 是否完整结束、工具调用结果是否已经成为模型事实，也难以处理并发请求和崩溃恢复。

CraftAgent 需要与数据库无关的会话协议，并保证模型实际看到的历史可以从唯一事实来源重建。

## 决定

- Session 状态使用 append-only `SessionEvent` 表达，不提供更新和删除旧事件的 Core API。
- 调用方提交 `SessionEventDraft`；Store 分配 `eventId`、`sessionId`、`sequence` 和 `timestamp`。
- 每个 Session 的 sequence 从 1 连续递增，version 等于事件数量。
- append 强制携带 `expectedVersion` 并以批次为原子单位。
- 第一个事件必须是唯一的 `session.created`。
- 模型消息使用 `message.appended` 保存，`deriveModelMessages()` 是模型历史的标准投影。
- 分页读取使用固定 `throughVersion`，保证一次快照不会混入并发追加。
- 第一份实现为 `MemorySessionStore`；数据库实现遵守同一 `SessionStore` 接口。
- 事件必须可安全 JSON 序列化，内存实现复制并冻结已提交事实。

## 备选方案

### 直接保存和覆盖 `ModelMessage[]`

实现最少，但并发写入容易丢失更新，也无法恢复 Turn 边界和审计工具事实。

### Session 行加版本，消息存独立表

可以满足常见聊天应用，但会把当前数据库结构提前固化进 Core，并需要另一套机制记录 Turn 和工具事实。

### 每个事件单独 append，不支持批量原子提交

接口更小，但创建 Session 与系统消息、assistant tool call 与相关事实之间容易留下部分状态。

### Store 自动合并版本冲突

对普通列表可能方便，但 Agent 输出依赖它看到的精确上下文；自动追加旧结果会破坏因果关系。

## 后果

正面影响：

- 模型历史、恢复和审计共享同一事实来源。
- 乐观并发可以阻止基于旧上下文的结果静默写入。
- Store 可以替换为数据库而不改变 Agent Loop。
- 工具调用和结果可以复用现有 `ModelMessage` 协议。

代价与限制：

- 上层必须显式管理 expectedVersion 和冲突。
- 查询当前状态需要投影事件，而不是直接读取一行可变对象。
- Session 压缩、摘要、归档和删除需要后续独立设计。
- 本阶段只定义基础 Turn 边界，不验证完整 Agent Loop 状态机。
