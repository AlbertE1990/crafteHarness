import { defineConfig } from 'tsup'

/**
 * 库构建配置：只打包 src 下的 harness 源码，案例应用（sample/）不参与发布。
 *
 * `openai` 与 `zod` 是随包安装的运行依赖，但仍保持 external，避免把第三方 SDK 与 Schema 实现复制进
 * bundle。Node 会从 craft-harness 自己的依赖树解析它们。
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
