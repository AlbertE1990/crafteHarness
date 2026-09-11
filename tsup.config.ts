import { defineConfig } from 'tsup'

/**
 * 库构建配置：只打包 src 下的 harness 源码，案例应用（sample/）不参与发布。
 *
 * `openai` 与 `zod` 声明为 peerDependency，因此必须保持 external——把供应商 SDK
 * 打进产物会让使用者同时存在两份副本，也会让 peer 版本约束失去意义。
 */
export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'adapters/index': 'src/adapters/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ['openai', 'zod'],
})
