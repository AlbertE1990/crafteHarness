# craft-harness 官方案例：Web 聊天 Runtime

这是一个**完整可运行**的案例应用，演示如何把 [craft-harness](../README.md) 组装成一个真实 Runtime：

- **Fastify** 提供 HTTP 与 SSE，把 `AgentOutputEvent` 原样直出给前端（不裁剪、不二次包装）
- **PostgreSQL** 作为 `SessionStore` 实现，配合可搜索的多用户会话目录
- **Vue 3 + Vite** 聊天界面：流式思考展示、工具审批卡片、会话列表与历史恢复

它是独立的私有 pnpm workspace 包，自行维护运行依赖、开发依赖和脚本。案例通过 `workspace:*` 依赖
`craft-harness` 并只使用公开导出，不会被根 npm 包发布；相关脚本会在启动、构建和测试前先构建库。

## 运行

```bash
# 1. 在仓库根配置案例环境变量，复制后填写真实密钥
cp sample/.env.example sample/.env.local

# 2. 预先创建 PostgreSQL 数据库，并把连接串写入 .env.local

# 3. 在仓库根安装全部 workspace 依赖
pnpm install

# 4. 同时启动后端 :3000 与前端 :3333（首次启动自动建表）
pnpm --dir sample dev
```

Server 在监听端口前自动执行尚未应用的数据库迁移，因此新数据库不需要手工建表。部署流水线仍可使用
`pnpm --dir sample db:migrate` 提前迁移，`pnpm --dir sample db:check` 只做连通性和表存在性检查。当前结构、权限要求和新增迁移规则见
[数据库文档](./database/README.md)。

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

Runtime 只创建一个 `DeepSeekAdapter` 和一个 `Agent`。每次请求把目录选中的 `{ id, reasoningEffort? }`
作为 `AgentRequest.model` 传入，因此切换同一供应商下的模型不需要重建 Agent，也不需要模型到 Agent 的注册表。
本案例没有工作区，所以不配置 `tools.workspaceRoot`；文件、搜索和终端工具不会装载。

## 环境变量

这里只有**连接与部署凭据**；模型与推理能力一律走 `config/models.json`，不放进环境变量。

| 变量                            | 必填 | 说明                                             |
| ------------------------------- | ---- | ------------------------------------------------ |
| `DEEPSEEK_API_KEY`              | 是   | 供应商密钥                                       |
| `DEEPSEEK_BASE_URL`             | 否   | 默认 `https://api.deepseek.com`                  |
| `CRAFT_AGENT_DATABASE_URL`      | 是   | PostgreSQL 连接串                                |
| `CRAFT_AGENT_DATABASE_POOL_MAX` | 否   | 连接池上限                                       |
| `CRAFT_AGENT_DATABASE_SSL`      | 否   | 是否启用 SSL                                     |
| `PORT`                          | 否   | 后端端口，默认 `3000`                            |
| `CRAFT_HARNESS_DOCS_ROOT`       | 否   | Craft Harness 文档根目录，默认自动定位仓库根目录 |

## Craft Harness 自身问答

案例注册了只读工具 `search_craft_harness_docs`。当用户询问 Craft Harness 的功能、用法、API、
架构或开发方式时，system prompt 会要求模型先检索官方文档，再根据命中的片段回答并列出来源文件。
检索范围固定为根 `README.md`、`docs/learning/**/*.md` 和 `docs/standards/**/*.md`，用户问题不能
控制文件路径，因此不会读取源码、`.env` 或其他服务器文件。

生产镜像需要把上述文档与 Server 一起部署。如果目录结构与仓库不同，通过
`CRAFT_HARNESS_DOCS_ROOT` 指向包含 `README.md` 和 `docs/` 的根目录；文档索引在首次查询时构建并
缓存，更新文档后重启 Server 即可生效。当前实现使用轻量关键词检索，文档规模明显增大后可保持工具
协议不变，把内部实现替换为 embeddings + 向量数据库，并加入版本字段和引用 URL。

## HTTP 接口

### 匿名浏览器作用域

页面首次打开时会生成一个 UUID v4，并以 `craft-agent.browser-scope-id.v1` 保存在当前站点的
`localStorage` 中。所有聊天、会话和工具审批请求都会通过 `X-Craft-Scope-Id` 请求头携带该值，
Server 再把它作为 SessionStore 的 `scopeId`，因此不同浏览器的会话目录和历史互相不可见。
进程内演示资源同样按该 `scopeId` 分区：同一浏览器可跨会话读写，其他浏览器无法读取。

这个标识按“浏览器配置文件 + 站点来源”持久化：刷新和重新打开页面不会改变；清理站点数据、使用
无痕窗口或更换浏览器后会获得新 ID，也无法自动找回旧会话。反向代理必须保留
`X-Craft-Scope-Id` 请求头。它只是无注册场景下的匿名数据分区，不是身份认证；如果以后保存敏感数据，
应改为由登录态或服务端签名 Cookie 推导 `scopeId`，不能把客户端请求头当作权限凭据。

| 方法     | 路径                              | 说明                                                                                                                     |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `POST`   | `/api/chat`                       | 发起一次 Agent Run。请求体 `{ message, sessionId?, stream?, reasoningEffort?, model? }`；`stream` 默认 `true` 时返回 SSE |
| `GET`    | `/api/model`                      | 返回模型目录（每个模型各自的推理能力），前端由此渲染，不在页面里硬编码                                                   |
| `GET`    | `/api/conversation/list`          | 会话目录（仅列表展示所需的最小摘要）                                                                                     |
| `GET`    | `/api/conversation/:sessionId`    | 按需读取单个会话的完整投影                                                                                               |
| `PATCH`  | `/api/conversation/:sessionId`    | 重命名会话，请求体 `{ name }`（非空、≤80 字符）                                                                          |
| `DELETE` | `/api/conversation/:sessionId`    | 删除会话及其全部事件                                                                                                     |
| `POST`   | `/api/tool-approvals/:approvalId` | 提交工具审批决定 `{ decision: 'allow' \| 'deny' }`                                                                       |

除公共的 `GET /api/model` 外，上表接口都要求 `X-Craft-Scope-Id`；缺失或格式非法会返回 `400`。

重命名与删除**不在库的 `SessionStore` 契约里**：名称是可变的展示投影（`session.created` 事件仍保留创建时的原始名称），删除则会移除已记录的事实。两者都由 Runtime 通过 `ConversationCatalogMutations` 端口注入，未注入时接口明确返回 `501`，库的 append-only 协议保持不变。

## 测试

案例测试在 `sample/test/`，由案例包自己的脚本运行；根包测试只覆盖 `craft-harness`：

```bash
pnpm --dir sample test           # 案例单元测试与界面测试
pnpm --dir sample typecheck      # 案例 TypeScript/Vue 类型检查
pnpm --dir sample lint           # 案例代码规范检查
pnpm --dir sample build          # 构建案例前端
pnpm --dir sample db:test-store  # PostgreSQL Store 契约测试（需要数据库）
```

## 目录

```text
sample/
├── package.json           案例自身的依赖与开发命令
├── src/
│   ├── server/            Fastify 应用、PostgreSQL Store、工具与 Guard、部署配置
│   ├── pages/index.vue    聊天界面
│   ├── composables/ styles/ App.vue main.ts
├── test/                  HTTP/SSE 协议、工具、聊天页面与 Store 契约测试
├── database/              数据库结构说明与版本化迁移
├── vite.config.ts         Vite + vitest project 配置（root 指向 sample/）
└── tsconfig.json          vue-tsc 使用；DOM 环境，可引用库源码
```
