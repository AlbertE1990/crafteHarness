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

## 模型目录：有哪些模型、每个模型能用哪些推理等级

这份数据属于**部署**，唯一来源是 `config/models.json`：

```json
{
  "defaultModel": "deepseek-v4-flash",
  "models": [
    {
      "id": "deepseek-v4-flash",
      "label": "DeepSeek V4 Flash",
      "reasoningEfforts": ["off", "low", "high", "max"],
      "defaultReasoningEffort": "high"
    },
    { "id": "deepseek-reasoner", "label": "DeepSeek Reasoner" }
  ]
}
```

| 字段                     | 说明                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `defaultModel`           | 默认模型 id；省略时取 `models[0]`，必须存在于 `models` 中    |
| `id`                     | 模型名，请求体里传的就是它；大小写敏感                       |
| `label`                  | 界面展示名；省略时等于 `id`                                  |
| `reasoningEfforts`       | **该模型**允许的推理等级；省略或 `[]` 表示这个模型不接受等级 |
| `defaultReasoningEffort` | 请求未指定等级时采用的值；`null`/省略表示不下发该参数        |

前端只做两件事：`GET /api/model` 拿这份目录、按选中的模型渲染等级下拉。因此**换模型或增删等级
只需要改这个 JSON 并重启** —— 不用改前端、不用改库，也不用改 Adapter。

三条语义要点：

- **等级是按模型的**：切到某个模型时，等级下拉只显示该模型的 `reasoningEfforts`；当前选中值不在新
  模型列表里时会重置为该模型的 `defaultReasoningEffort`。
- **`reasoningEfforts: []` 表示"这个模型没有推理控制"**（例如纯推理模型）：界面隐藏等级控件，
  请求里也不带 `reasoningEffort`。
- **请求会在 HTTP 边界按选中模型校验**：模型没声明的等级返回 `400 REASONING_EFFORT_NOT_SUPPORTED`
  并列出可用值。这属于部署自查——目录是运维自己写的，报错比把非法值送给供应商更清楚。

### Adapter 不持有词表

`craft-harness` 的 DeepSeek Adapter 只负责把开放值翻译成供应商字段（`thinking` / `reasoning_effort`），
**不知道也不校验有哪些模型和等级**。目录在部署、协议形状在 Adapter，两边各自演化：供应商加一档等级时，
改 JSON 即可生效，不需要等库发版，也不会被库里的旧枚举拒绝。

## 环境变量

这里只有**连接与部署凭据**；模型与推理能力一律走 `config/models.json`，不放进环境变量。

| 变量                            | 必填 | 说明                            |
| ------------------------------- | ---- | ------------------------------- |
| `DEEPSEEK_API_KEY`              | 是   | 供应商密钥                      |
| `DEEPSEEK_BASE_URL`             | 否   | 默认 `https://api.deepseek.com` |
| `CRAFT_AGENT_DATABASE_URL`      | 是   | PostgreSQL 连接串               |
| `CRAFT_AGENT_DATABASE_POOL_MAX` | 否   | 连接池上限                      |
| `CRAFT_AGENT_DATABASE_SSL`      | 否   | 是否启用 SSL                    |
| `PORT`                          | 否   | 后端端口，默认 `3000`           |

## HTTP 接口

| 方法     | 路径                              | 说明                                                                                                                          |
| -------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/chat`                       | 发起一次 Agent Run。请求体 `{ message, conversationId?, stream?, reasoningEffort?, model? }`；`stream` 默认 `true` 时返回 SSE |
| `GET`    | `/api/model`                      | 返回模型目录（每个模型各自的推理能力），前端由此渲染，不在页面里硬编码                                                        |
| `GET`    | `/api/conversation/list`          | 会话目录（仅列表展示所需的最小摘要）                                                                                          |
| `GET`    | `/api/conversation/:sessionId`    | 按需读取单个会话的完整投影                                                                                                    |
| `PATCH`  | `/api/conversation/:sessionId`    | 重命名会话，请求体 `{ name }`（非空、≤80 字符）                                                                               |
| `DELETE` | `/api/conversation/:sessionId`    | 删除会话及其全部事件                                                                                                          |
| `POST`   | `/api/tool-approvals/:approvalId` | 提交工具审批决定 `{ decision: 'allow' \| 'deny' }`                                                                            |

重命名与删除**不在库的 `SessionStore` 契约里**：名称是可变的展示投影（`session.created` 事件仍保留创建时的原始名称），删除则会移除已记录的事实。两者都由 Runtime 通过 `ConversationCatalogMutations` 端口注入，未注入时接口明确返回 `501`，库的 append-only 协议保持不变。

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
