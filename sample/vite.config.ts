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
  // 案例应用位于 sample/，而命令从仓库根执行；显式声明 root 才能让 index.html、
  // public/ 与构建输出都落在 sample/ 下，避免生成物跑到库的 src/ 里。
  root: __dirname,
  resolve: {
    alias: {
      '~/': `${path.resolve(__dirname, 'src')}/`,
    },
  },
  plugins: [
    // https://github.com/vuejs/router/pull/2603
    // routesFolder 的默认值 "src/pages" 相对**当前工作目录**解析（仓库根），不是相对 vite root；
    // 不写绝对路径就会扫不到任何页面，生成空的路由表。
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
    // 命令从仓库根执行，因此显式指定 sample/uno.config.ts，避免退化成默认配置。
    UnoCSS({ configFile: path.resolve(__dirname, 'uno.config.ts') }),
  ],

  server: {
    port: 3333,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
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
