# 阶段 4.5：PostgreSQL 持久化学习基座

- 文档类型：交付记录
- 状态：数据库、迁移、Node 连接和学习骨架已完成
- 日期：2026-09-09

## 本阶段目标

在不替学习者完成核心 SessionStore 算法的前提下，准备可运行的本地 PostgreSQL 环境，让后续练习集中在
append-only 日志、事务和分页语义，而不是安装、连接和建表。

## 实际完成

- 创建本地 `craft_agent_dev` 数据库及 Session、Session Event 两张表。
- 新增可重复执行的 PostgreSQL 建表迁移。
- Node Runtime 接入 `pg`，提供连接配置、迁移和连通性检查命令。
- 新增不包含真实密码的 `.env.example`。
- 新增 `PostgresSessionStore` 类型骨架，保留 `read/append/list` 三项核心学习任务。
- 新增独立 `db:test-store` 契约测试入口；骨架完成前不会接入现有 Server。
- 持久化教程补充本地文件导航、练习顺序和验收步骤。

## 验证范围

- PostgreSQL 18.6 可以通过 Node `pg` 驱动连接。
- 迁移可重复执行，两张表和必要索引存在。
- 常规测试不依赖本地数据库。
- Runtime 配置解析有离线单元测试。
- 完成学习骨架后可直接运行完整 SessionStore 契约探针。

## 留给学习者

1. 实现 `PostgresSessionStore.read()`。
2. 实现事务化 `append()`。
3. 实现稳定目录 `list()`。
4. 通过 `pnpm db:test-store`。
5. 注入 Server，重启进程后验证历史恢复。
