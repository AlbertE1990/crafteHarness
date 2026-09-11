# ADR-0012：仓库根成为发布的库，应用下移为 sample，包名改为 craft-harness

> 状态：Accepted；日期：2026-09-11；实现：2026-09-11。

## 背景

在此之前，这个仓库是“一个可运行的应用 + 一套库源码”混装在同一个 `src/` 下的单项目仓库：

```text
src/
  craft-agent/     # 其实可以独立发布的库：contracts、core、agent、tools、sessions、adapters、builtins
  server/          # Fastify Runtime
  pages/           # Vue 页面
```

这种结构有两个直接后果。

第一，**它无法发布**。仓库根不是包：没有 `exports`、没有构建产物、`package.json` 描述的是一个前端应用
（Vite、UnoCSS、Vue 插件）而不是库。任何想复用 Agent Loop 的人只能复制源码，或者把整个应用连 Fastify、
`pg`、Vue 一起装下来。

第二，**包名描述错了东西**。当时的名字是 `craft-agent`，而项目实质是一套**基于 Node 的 agent harness**：
确定性的 Agent Loop（Run/Turn/Step 状态机、预算、稳定终态）、工具 harness（Schema 校验、两层 Guard、
审批、超时、重试）、追加式 Session Log（append-only 事实、乐观并发、一致性分页）以及供应商无关的模型契约
（官方 Adapter 只是可替换实现）。harness 是“让 agent 跑起来的骨架与约束”，而不是某一个 agent 产品；
继续用 `craft-agent` 命名，会让使用者以为拿到的是一个 agent，而不是一套构造 agent 的库。

同时，仓库里的 `server/`、`pages/` 和 `database/` 是有价值的：它们是这套库唯一“真的被用起来”的证据，
也是回归验证的载体。拆分不能把这份证据丢掉。

## 决策

- **仓库根即发布包**。根的 `package.json`、`tsup.config.ts`、`tsconfig.json` 只服务库；发布产物是 `dist/`。
  `README`、`LICENSE`、脚本和测试入口都留在根，仓库根不再同时扮演“应用工作区”的角色。
- **库源码上提一层**：原 `src/craft-agent/**` 整体变为 `src/**`。`contracts`、`core`、`agent`、`tools`、
  `sessions`、`adapters`、`builtins`、`types` 都少了一层没有信息量的 `craft-agent` 目录。库的根入口回到
  `src/index.ts`，`src/adapters/index.ts` 继续做 `./adapters` 子入口。
- **应用下移为 `sample/`**：`src/server/**` → `sample/src/server/**`，`src/pages/index.vue` →
  `sample/src/pages/index.vue`，`database/` → `sample/database/`，`vite.config.ts`、`uno.config.ts`、
  `index.html`、`auto-imports.d.ts`、`components.d.ts`、`shims.d.ts`、`sample/.env.example` 也一并进入
  `sample/`。它通过相对路径导入库源码（`sample/src/server/*` 与 `sample/src/pages/*` 写作 `../../../src`），
  因此是**库的普通使用者**，只是恰好与库同仓库。
- **案例走相对路径导入，因此它不验证打包边界**。相对路径绕过了 `exports`，也绕过了 `files` 白名单，所以
  案例测试全绿并不能说明发布出去的包可用。为补偿这一点，新增 `scripts/smoke-pack.mjs`：它真实执行
  `npm pack`，把 tarball 装进临时项目的 `node_modules`，再按**包名** `import('craft-harness')` 与
  `import('craft-harness/adapters')` 断言导出存在、内部实现没有泄漏，并检查 tarball 含
  `dist/index.js`、`dist/index.d.ts`、`dist/adapters/index.js`。这条冒烟测试是“包能用”的唯一证据。
- **包名改为 `craft-harness`**（npm registry 上可用）。改名只动包名与文档称谓：**导出的符号一个都没变**，
  `Agent`、`AgentLoop`、`defineAgentConfig`、`defineTool`、`MemorySessionStore` 等继续按原样导入，变化的
  只有 `from 'craft-agent'` → `from 'craft-harness'`。
- **ESM-only，`engines: node >=20`**。库从一开始就只面向现代 Node：源码使用 ESM、顶层 `import`、
  `import.meta`，内部没有 CJS 兼容负担；与其发布一份双方都要维护的双格式产物，不如明确只支持 ESM。
- **`openai` 与 `zod` 是 peerDependency，且都不可选**。`zod` 不可选是因为工具 Schema 就是公共 API 的一部分
  （`defineTool()` 直接接受 Zod Schema）；`openai` 不可选是因为库的根入口会静态导入两个官方 Adapter
  （`src/agent/config.ts` 导入 `../adapters/deepseek` 与 `../adapters/openai-compatible`），而它们在最顶层
  导入 `openai`，所以按包名导入根入口的那一刻 `openai` 就必须存在。既然无法真正可选，就不要用
  `peerDependenciesMeta.optional` 制造“可以没有”的假象。
- **零运行期 `dependencies`**。库运行时只依赖 Node 标准库、`zod` 和 `openai`；后两者由使用者提供，
  `dependencies` 保持为空，包不存在传递依赖的版本漂移。
- **`files: ["dist"]`**。发布清单只包含构建产物（以及 npm 自动纳入的 `package.json`/`README`/`LICENSE`），
  不会把 `src/`、`sample/`、测试或脚本带进 tarball。
- **构建用 tsup**，产出 ESM 与 `.d.ts`，`external: ['openai', 'zod']` 保证 peer 不被误打进产物。选 tsup
  而不是“`tsc` 直出 + 手改导入”的关键原因是**保留无扩展名相对导入**：库源码写 `from '../core'`，若必须让
  `tsc` 直接产出可被 Node ESM 加载的代码，就得给每一处相对导入手工补 `.js` 后缀，源码可读性、重构可靠性和
  测试工具链都会变差。tsup 在打包时解析这些导入，源码保持 bundler 风格。
- **测试分成两份，但一次运行**：库测试留在 `test/`（`test/support/*` 是 Scripted Adapter 与契约探针等共享
  替身），案例测试进入 `sample/test/`；根 `vitest.config.ts` 用两个 project——`harness`（node 环境）与
  `sample`（jsdom，直接引用 `sample/vite.config.ts`，与该案例的开发/构建共用一份配置）。

## 后果

正向影响：

- `npm i craft-harness` 后按包名导入即可使用，`exports` 只有 `.`、`./adapters` 和 `./package.json` 三个出口，
  公共面因此是可枚举的；内部归一化、审批管理器等实现没有出口。
- 仓库里同时存在“库”和“真实使用者”，任何公共 API 变更都能立刻在案例里被消费到，不需要另建 demo 仓库。
- 边界可被测试守住：`test/model-boundary.test.ts` 除了断言 Core 不导入 OpenAI SDK，还断言 `src/**` 不出现
  指向 `sample/` 的导入——库一旦依赖案例，发布出去的包就会要求使用者安装 Fastify、`pg` 和 Vue。
- 发布内容与开发内容分离：根 `tsconfig.json` 只覆盖 `src/**`（node only，无 DOM），案例用
  `sample/tsconfig.json`；`pnpm build` 不会再顺手构建前端。

迁移与代价：

- **导入路径**：`from 'craft-agent'` → `from 'craft-harness'`；子入口 `craft-agent/adapters` →
  `craft-harness/adapters`。
- **脚本语义**：`pnpm build` 从“构建前端”变为“构建库”，前端构建改用 `pnpm build:sample`；`preview` 与
  `dev:web` 显式带 `--config sample/vite.config.ts`。语义变化是必要的，因为“根 = 库”之后，无参数的
  `build` 必须指向发布产物。
- **生命周期脚本**：`postinstall` 改为 `prepare`。`postinstall` 会在使用者安装本包时执行，而它原先做的是
  安装仓库自己的 git hooks——库不应该改动使用者的开发环境；改为 `prepare` 后只在本地开发（开发依赖已安装）
  时生效。打包冒烟测试也显式使用 `npm pack --ignore-scripts`，避免冒烟过程本身改动 hooks。
- **案例的存储与展示仍归案例**：`sample/database/migrations/*`、`PostgresSessionStore`、Fastify 路由和
  Vue 页面都不进入库；库只保留 `SessionStore` 契约与内存实现。
- **历史记录不改写**：`docs/product/deliveries/**` 与 `adr-0001`…`adr-0011` 中的 `src/craft-agent`、
  `craft-agent` 都是当时的事实，保持原样；当前行为以本 ADR 与现行规范为准。
- 库的公共导出符号不变，因此这次改名对使用者是单纯的字符串替换；`README` 与学习文档中的示例同步更新为
  `craft-harness`。

## 备选方案

**把 `sample/` 做成 pnpm workspace 包，并以包名 `craft-harness` 导入（未采纳）。** 这是与最终方案最接近的
备选，取舍也最真实：它的最大优点是**开发期间就在验证发布边界**——案例只能按包名导入，于是 `exports` 漏项、
`files` 漏产物、类型声明缺失、peer 依赖被误打进 bundle 这类问题会在日常 `pnpm test` 里立刻暴露，而不必等到
发布前才靠冒烟测试发现；测试覆盖率与发布路径完全一致。

未采纳的原因不是它错了，而是它把开发链路变重：案例消费的是 `dist/`，所以本地开发需要“改库 → 构建库 →
案例生效”的链路，通常要并行运行 watch 构建与 dev server，并把 TypeScript 的路径解析、IDE 跳转、Vitest 的
模块解析都调到指向产物；调试库代码时还要面对 sourcemap，出错位置与源码行号之间隔了一层。对一个仍在快速
演进的库来说，每次改一行源码都要经过一次打包的反馈循环，代价明显高于收益。因此当前选择是“案例直接读源码
换取开发速度”，并把发布正确性交给一个独立、可重复的 `pnpm smoke:pack` 来补偿。若将来发布节奏变快、或出现
多次“冒烟才发现”的问题，这个备选可以重新评估，届时把案例改成 workspace 包即可，库侧不需要再动。

其余被否决的方向：

- **只改 `package.json` 的 `name`，保留 `src/craft-agent` 目录结构**。改动最小，但目录名继续与发布边界错位：
  根仍然是一个混装的应用仓库，`src/craft-agent` 与 `src/server` 并列会让“哪部分是发布的库”继续模糊，也无法
  让根 `tsconfig.json` 只覆盖库。
- **把案例拆到独立仓库**。边界最干净，但会失去“就近的真实使用者”：公共 API 一改就只能靠人工同步另一个
  仓库才能发现破坏性变更，库里也会缺少端到端回归的载体，对当前阶段是过度隔离。
- **保留双格式产物（ESM + CJS）以扩大兼容面**。会让构建、类型声明和测试矩阵都翻倍，而库的目标环境
  （Node 20+、只吃 ESM 的官方 Adapter、服务端应用）都不要求 CJS。
- **把 `openai` 与 `zod` 声明为可选 peer，或改成 `dependencies`**。可选 peer 与事实不符：根入口静态导入
  官方 Adapter，缺 `openai` 会在导入期直接失败；写进 `dependencies` 则让使用者无法控制 SDK 版本，也违背
  “peer 由宿主提供”的初衷。`pnpm smoke:pack` 会按 `peerDependencies` 逐个接入依赖，正是为了验证这份声明
  与实际导入行为一致。
