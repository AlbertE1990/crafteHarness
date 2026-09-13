# ADR-0017：sample 作为独立 workspace 包消费公开 API

> 状态：Accepted；日期：2026-09-13；局部取代：[ADR-0012](./adr-0012-package-extraction-and-naming.md) 的案例依赖与测试编排决策。

## 背景

仓库根 `package.json` 是 `craft-harness` 的发布清单，但此前同时包含 Fastify、PostgreSQL、Vue、Vite 和案例测试
所需依赖与脚本。虽然这些依赖不会进入 npm 的 `files` 白名单，它们仍让根清单看起来像“库 + 应用”的混合包，
也让库的安装、测试和升级范围不够清晰。

案例还通过 `../../../src` 等相对路径直接读取库源码。这种方式绕过 `exports` 和构建声明，无法在日常开发中验证
案例是否只使用了真实发布包允许的公共入口。

## 决策

- 在 pnpm workspace 中注册 `sample/`，并由 `sample/package.json` 自行维护前后端运行依赖、开发依赖和脚本。
- `sample` 是 `private: true` 的应用包，通过 `"craft-harness": "workspace:*"` 依赖根库。
- 案例源码从 `craft-harness` 与 `craft-harness/adapters` 导入，不再跨目录读取 `src/**`。
- 根 `package.json` 只保留库运行、构建、测试、lint 和发布所需依赖与命令。
- 根测试只运行 `test/**`；案例使用自己的 Vite/Vitest、Vue 类型检查和 ESLint 配置。
- 案例的开发、测试、类型检查和构建脚本在执行前先构建根库，保证 `dist` 和声明文件与源码一致。
- `pnpm-lock.yaml` 仍由 workspace 根统一维护，以获得单次安装和一致的依赖解析。

## 后果

- 根包清单可以准确表达 `craft-harness` 的实际发布职责，升级案例依赖不会污染库的直接依赖列表。
- `pnpm test`、`pnpm typecheck`、`pnpm lint` 和 `pnpm build` 只验证库；案例使用
  `pnpm --dir sample <command>` 独立验证。
- 一次 `pnpm install` 仍会安装两个 workspace 包，无需在 `sample/` 再维护独立锁文件。
- 案例日常运行会覆盖公共 `exports` 与 `.d.ts` 边界；`pnpm smoke:pack` 继续负责验证真实 tarball 和发布白名单。
- 修改库后启动案例会多一次构建步骤，但换来与 npm 使用者一致的模块解析路径。
