# ADR-0016：安装 craft-harness 时提供完整运行依赖

> 状态：Accepted；日期：2026-09-12；局部取代：[ADR-0012](./adr-0012-package-extraction-and-naming.md) 的依赖安装决策。

## 背景

`openai` 与 `zod` 原本声明为 peerDependency，要求使用者理解并维护库运行所需的第三方依赖。现代 pnpm 虽会
自动解析必需 peer，但不会把它们写成宿主的直接依赖；在严格 `node_modules` 布局下，应用也不能因此直接
`import 'zod'`。这与“把方便留给使用者”的库设计原则不一致。

`openai` 是官方 Adapter 的实现依赖，`zod` 则已经进入 `defineTool()` 的公共 Schema 契约。二者都是当前包的
实际运行条件，应由发布包提供可工作的默认组合。

## 决策

- `openai` 与 `zod` 从 peerDependency 改为普通 `dependencies`，与 `@vscode/ripgrep` 一起随
  `pnpm add craft-harness` 安装。
- 构建继续把 `openai` 与 `zod` 标记为 external；依赖由 Node 正常解析，不复制进 craft-harness bundle。
- 根入口导出 `z`，自定义工具使用 `import { defineTool, z } from 'craft-harness'`，不要求第二条安装命令。
- 不使用 `postinstall` 修改宿主 `package.json`，也不依赖 pnpm 的自动 peer 配置。
- 应用若要直接导入原始 `openai` 或 `zod` 包，仍应把它声明为自己的直接依赖；传递依赖不属于应用公共 API。

## 后果

- 最短安装路径固定为 `pnpm add craft-harness`，基础 Agent、官方 Adapter 和自定义工具 Schema 都有完整依赖。
- craft-harness 负责测试一组兼容的 SDK 与 Zod 版本，升级它们需要随库版本发布并经过打包冒烟。
- 安装体积会包含 OpenAI SDK，即使使用者只实现自定义 Adapter；当前优先选择一致、低学习成本的默认体验。
- 高级应用仍可通过 pnpm overrides 或包管理器的依赖解析能力统一版本，但不再由 peer range 主动协商。
