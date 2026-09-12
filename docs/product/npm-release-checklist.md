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

1. 在 npmjs.com 注册并验证邮箱，启用 2FA；本机登录后确认账号：

   ```bash
   npm login
   npm whoami
   ```

2. 确认包名尚未被占用，并检查当前 registry 确实是 npm 官方源：

   ```bash
   npm config get registry
   npm view craft-harness
   ```

   registry 应为 `https://registry.npmjs.org/`。首次查询返回 404 表示包名尚无公开版本；若已经存在且不属于当前
   账号，必须更换包名或改为自己账号下的 scoped 包，不能覆盖他人的包。

3. 确认 `package.json` 中的版本、作者、许可证、仓库地址和 `files/exports` 正确，并确保工作树只包含准备发布的
   内容。npm 上已经发布过的 `name + version` 不能再次使用，后续版本使用 `pnpm version patch|minor|major` 更新。

4. 执行发布前检查，并预览最终 tarball 内容：

   ```bash
   pnpm release:check
   pnpm pack --dry-run
   ```

5. 当前 `craft-harness` 是无 scope 公共包，`publishConfig.access` 已设为 `public`。首次发布执行：

   ```bash
   pnpm publish --access public
   ```

   `prepublishOnly` 会再次执行 `pnpm release:check`；启用 2FA 后按终端提示完成验证。不要使用 `--force`、
   `--no-git-checks` 或跳过脚本来绕过失败。

6. 发布后从 registry 和空项目验证：

   ```bash
   npm view craft-harness version dist-tags repository
   pnpm view craft-harness version dist-tags repository
   ```

   再在仓库外的空目录执行 `pnpm add craft-harness`，确认依赖树包含 `openai` 与 `zod`，并验证根入口的 `z`、
   `defineTool` 和 `craft-harness/adapters`。

7. 推送版本提交与 tag，并记录该版本的变更摘要。首次手工发布跑通后，后续优先使用 GitHub Actions trusted
   publishing，不保存长期 npm token。

## 后续增强

- 增加由受保护 tag 触发的发布流水线，并使用 npm trusted publishing/provenance，避免长期保存发布 token。
- 建立 CHANGELOG 或自动 release notes；进入稳定版前明确公共 API 的弃用周期和 SemVer 策略。
- 增加 Node.js 最低版本与当前 LTS 的 CI 矩阵，并在 Linux、Windows 上覆盖工作区工具。
- 视外部贡献规模补充 CONTRIBUTING、SECURITY 和行为准则；这些不阻塞首次技术预览版。
