import { defineConfig } from 'vitest/config'

/**
 * 测试入口：一次 `pnpm test` 同时跑库测试与案例测试。
 *
 * 两个 project 各自声明环境与插件——harness 是 Node 库，不需要 Vue 与 jsdom；
 * sample 是浏览器应用，配置在 `sample/vite.config.ts` 里，与它的开发/构建共用一份。
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'harness',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      'sample/vite.config.ts',
    ],
  },
})
