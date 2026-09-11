# Delivery 020：阶段 4.16 工作区工具与示例契约收口

- 文档类型：阶段交付记录
- 状态：Completed
- 日期：2026-09-11

本阶段默认新增 `read/write/edit/glob/grep/terminal`，实现 workspace/symlink 边界、读后改、原子发布、资源
上限、ripgrep 搜索、一次性终端和高风险操作审批，并提供公开组合工厂与测试。

示例 Runtime 的请求/响应 Schema 改由 Zod 投影 Draft 7 JSON Schema；聊天接口统一使用 `sessionId`，删除
conversationId 到 sessionId 的映射。页面使用 `sample/public/logo.png` 作为品牌标识，轮次导航改为横条。

已知限制：终端不是沙箱，写观察状态仅限当前工具套件进程；不提供持久终端、后台任务或二进制文件编辑。
