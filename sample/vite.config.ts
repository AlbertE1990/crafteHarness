/// <reference types="vitest" />

import path from 'node:path'
import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import VueMacros from 'unplugin-vue-macros/vite'
import { defineConfig } from 'vitest/config'
import { VueRouterAutoImports } from 'vue-router/unplugin'
import VueRouter from 'vue-router/vite'

export default defineConfig({
  // 固定案例应用根目录，确保从 workspace 根或 sample/ 执行命令时行为一致。
  root: __dirname,
  resolve: {
    alias: {
      '~/': `${path.resolve(__dirname, 'src')}/`,
    },
  },
  plugins: [
    // https://github.com/vuejs/router/pull/2603
    // 使用绝对路径，避免调用命令的工作目录影响路由扫描和声明文件位置。
    VueRouter({
      routesFolder: path.resolve(__dirname, 'src/pages'),
      dts: path.resolve(__dirname, 'src/typed-router.d.ts'),
    }),

    VueMacros({
      defineOptions: false,
      defineModels: false,
      plugins: {
        vue: Vue({
          script: {
            propsDestructure: true,
            defineModel: true,
          },
        }),
      },
    }),

    // https://github.com/antfu/unplugin-auto-import
    AutoImport({
      imports: [
        'vue',
        '@vueuse/core',
        VueRouterAutoImports,
        {
          // add any other imports you were relying on
          'vue-router/auto': ['useLink'],
        },
      ],
      dts: true,
      dirs: [
        './src/composables',
      ],
      vueTemplate: true,
    }),

    // https://github.com/antfu/vite-plugin-components
    Components({
      dts: true,
    }),

    // https://github.com/antfu/unocss
    // 显式指定案例自己的 UnoCSS 配置，避免工作目录影响配置发现。
    UnoCSS({ configFile: path.resolve(__dirname, 'uno.config.ts') }),
  ],

  server: {
    port: 3333,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
    watch: {
      /*
        编辑器与工具链常在被写文件旁边建临时目录（例如 `.foo.ts.<pid>.<uuid>.tmpdir/`），
        并在写完后改名就位。Windows 上这些临时文件在 watcher 注册的瞬间可能仍被占用，
        chokidar 抛 EBUSY 会让 dev server 直接退出，而不是只报一个警告。
        这里统一忽略这类临时产物：它们本来就不该参与 HMR。
      */
      ignored: ['**/*.tmpdir/**', '**/.*.tmpdir/**', '**/*.tmp', '**/.*.swp'],
    },
  },

  // https://github.com/vitest-dev/vitest
  // 作为根 vitest.config.ts 里的一个 project 被引用；name 用于在报告中区分两个 project。
  test: {
    name: 'sample',
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
})
