# npm 首次发布清单

> 文档类型：产品运维；状态：Ready for first release。

## 代码仓库已具备

- 包名 `craft-harness`、ESM 入口、类型入口和 `./adapters` 子路径均已声明。
- npm tarball 只包含 LICENSE、README、package.json 与 `dist` 产物。
- 仓库使用 pnpm catalog 统一版本；`pnpm pack/publish` 会把它转换成普通 semver，冒烟测试检查最终清单不会泄漏
  `catalog:` 或 `workspace:`。
- `openai` 与 `zod` 是普通运行依赖；`pnpm add craft-harness` 会自动安装它们，根入口同时导出工具定义使用的 `z`。
- 发布包没有安装期脚本；Git hook 通过开发者主动执行 `pnpm hooks:install` 安装。
- `pnpm release:check` 覆盖 lint、两套类型检查、全部测试、构建与 tarball 消费冒烟。

## 首次发布前人工完成

1. 确认 npm 账号已启用双因素认证，并有权发布 `craft-harness`。当前 registry 查询结果为 404，说明尚无公开版本；
   最终所有权仍以实际 `npm publish` 结果为准。
2. 确认工作树只包含本次发布内容，创建版本提交和 Git tag（首版建议保持 `0.1.0`）。
3. 执行 `pnpm release:check`，再执行 `pnpm publish`。不要改用 `npm publish`，也不要使用 `--force` 或跳过脚本。
4. 发布后在空目录执行 `pnpm add craft-harness`，确认依赖树包含 `openai` 与 `zod`，并验证根入口的 `z`、
   `defineTool` 和 `craft-harness/adapters`；再用 npm 重复一次安装验证。
5. 推送版本提交与 tag，并记录该版本的变更摘要。

## 后续增强

- 增加由受保护 tag 触发的发布流水线，并使用 npm trusted publishing/provenance，避免长期保存发布 token。
- 建立 CHANGELOG 或自动 release notes；进入稳定版前明确公共 API 的弃用周期和 SemVer 策略。
- 增加 Node.js 最低版本与当前 LTS 的 CI 矩阵，并在 Linux、Windows 上覆盖工作区工具。
- 视外部贡献规模补充 CONTRIBUTING、SECURITY 和行为准则；这些不阻塞首次技术预览版。
