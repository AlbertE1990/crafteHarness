# craft-harness 官方案例：Web 聊天 Runtime

这是一个**完整可运行**的案例应用，演示如何把 [craft-harness](../README.md) 组装成一个真实 Runtime：

- **Fastify** 提供 HTTP 与 SSE，把 `AgentOutputEvent` 原样直出给前端（不裁剪、不二次包装）
- **PostgreSQL** 作为 `SessionStore` 实现，配合可搜索的多用户会话目录
- **Vue 3 + Vite** 聊天界面：流式思考展示、工具审批卡片、会话列表与历史恢复

它**不参与发布**（根 `package.json` 的 `files` 只包含 `dist`），通过相对路径 `../../../src` 直接导入库源码，
因此在开发时不需要先构建库。

## 运行

```bash
# 1. 配置：复制后填写真实密钥
cp .env.example .env.local

# 2. 建表（需要本地 PostgreSQL）
pnpm db:migrate        # 在仓库根执行

# 3. 同时启动后端 :3000 与前端 :3333
pnpm dev               # 在仓库根执行
```

`.env.local` **相对模块定位**（`sample/src/server/index.ts` 用 `import.meta.url` 解析），不依赖当前工作目录；
文件不存在时会跳过加载并直接使用宿主环境变量，便于容器与 CI 注入。

## 环境变量

| 变量                            | 必填 | 说明                                                                   |
| ------------------------------- | ---- | ---------------------------------------------------------------------- |
| `DEEPSEEK_API_KEY`              | 是   | 供应商密钥                                                             |
| `DEEPSEEK_MODEL`                | 是   | 模型名。库不内置默认值：模型名会过期，必须由部署显式声明               |
| `DEEPSEEK_BASE_URL`             | 否   | 默认 `https://api.deepseek.com`                                        |
| `DEEPSEEK_REASONING_EFFORT`     | 否   | 部署默认推理等级；`off` 关闭推理；留空表示不下发该参数。解析时统一小写 |
| `DEEPSEEK_REASONING_EFFORTS`    | 否   | 前端下拉候选（逗号分隔）。**只影响候选与启动自查，不校验单次请求**     |
| `CRAFT_AGENT_DATABASE_URL`      | 是   | PostgreSQL 连接串                                                      |
| `CRAFT_AGENT_DATABASE_POOL_MAX` | 否   | 连接池上限                                                             |
| `CRAFT_AGENT_DATABASE_SSL`      | 否   | 是否启用 SSL                                                           |
| `PORT`                          | 否   | 后端端口，默认 `3000`                                                  |

## HTTP 接口

| 方法   | 路径                              | 说明                                                                                                                  |
| ------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/chat`                       | 发起一次 Agent Run。请求体 `{ message, conversationId?, stream?, reasoningEffort? }`；`stream` 默认 `true` 时返回 SSE |
| `GET`  | `/api/model`                      | 返回部署的模型与推理等级候选，前端下拉由此渲染，不在页面里硬编码                                                      |
| `GET`  | `/api/conversation/list`          | 会话目录（仅列表展示所需的最小摘要）                                                                                  |
| `GET`  | `/api/conversation/:sessionId`    | 按需读取单个会话的完整投影                                                                                            |
| `POST` | `/api/tool-approvals/:approvalId` | 提交工具审批决定 `{ decision: 'allow' \| 'deny' }`                                                                    |

## 测试

案例测试在 `sample/test/`，从仓库根执行 `pnpm test` 时会和库测试一起跑（vitest 的两个 project）：

```bash
pnpm test                  # 库（node 环境）+ 案例（jsdom）
pnpm db:test-store         # PostgreSQL SessionStore 的真实契约测试（需要数据库）
pnpm build:sample          # 构建案例前端
```

## 目录

```text
sample/
├── src/
│   ├── server/            Fastify 应用、PostgreSQL Store、工具与 Guard、部署配置
│   ├── pages/index.vue    聊天界面
│   ├── composables/ styles/ App.vue main.ts
├── test/                  HTTP/SSE 协议、工具、聊天页面与 Store 契约测试
├── database/migrations/   建表脚本
├── vite.config.ts         Vite + vitest project 配置（root 指向 sample/）
└── tsconfig.json          vue-tsc 使用；DOM 环境，可引用库源码
```
