# 阶段 3：Session Log

- 文档类型：交付记录
- 状态：代码、离线测试和文档已完成；等待 Agent Loop 集成
- 日期：2026-09-08

## 本阶段目标

建立与网络、数据库、模型供应商和前端无关的 append-only Session 协议，提供内存实现，并能够从唯一事实来源
恢复下一次模型调用需要的消息历史。

## 实际完成

- 新增 `SessionEventDraft`、`SessionEvent`、分页、快照和 `SessionStore` 协议。
- 定义 session、message 和 Turn 生命周期基础事件。
- `MemorySessionStore` 实现批量原子追加和 `expectedVersion` 乐观并发。
- Store 分配全局唯一 eventId、Session 内 sequence 和写入 timestamp。
- 新 Session 强制以唯一 `session.created` 开始。
- 事件在提交前经过 JSON 序列化边界并复制、深度冻结。
- 分页读取支持 `throughVersion` 一致性快照。
- `readSessionSnapshot()` 负责跨页读取并防止无进展游标。
- `deriveModelMessages()` 从 `message.appended` 确定性生成模型历史。
- `loadModelMessages()` 组合快照读取与消息推导。
- 新增规范错误和完整单元测试。

## 主要文件

- `src/craft-agent/contracts/session.ts`
- `src/craft-agent/sessions/errors.ts`
- `src/craft-agent/sessions/memory-session-store.ts`
- `src/craft-agent/sessions/derive-messages.ts`
- `test/session-log.test.ts`
- `docs/standards/protocols/session-log.md`
- `docs/learning/session-log.md`
- `docs/product/decisions/adr-0004-append-only-session-log.md`

## 离线验证

- 首批初始化与连续 sequence。
- system/user/assistant 消息推导。
- 旧 expectedVersion 冲突不产生部分写入。
- 重复 session.created 被拒绝。
- 输入对象后续修改不影响已提交事实。
- 循环引用等不可序列化事件被拒绝。
- 并发追加发生在分页之间时，既有快照保持固定。
- 重复 eventId 导致整批失败。
- 混合 Session 或不连续历史不会被静默排序。

## 明确不在本阶段实现

- 把过渡 `server/agent.ts` 迁移到 SessionStore。
- 完整 Agent Loop 和 Turn 状态机。
- 数据库、文件或 Redis Store。
- Session 列表、搜索、删除、归档和压缩。
- Runtime API、前端展示与轨迹接口。

以上集成由下一阶段 Agent Loop 消费，本阶段保持 Core 独立可测试。
