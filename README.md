# CraftAgent

CraftAgent 是面向 Node.js、与 HTTP、数据库和前端解耦的通用 Agent。当前默认入口已经统一为：

```ts
import Agent from 'craft-agent'

const agent = new Agent({
  model: {
    adapter: 'deepseek',
    apiKey: process.env.DEEPSEEK_API_KEY!,
  },
  execution: {
    model: {
      stream: true,
      reasoning: { enabled: true, effort: 'high' },
    },
  },
})

const result = await agent.run({ input: '你好' }, {
  // 页面或 CLI 可以按次覆盖；非流式会调用 Adapter.complete()。
  model: { stream: false },
})
```

需要租户、用户或环境级约束时，使用 `new Agent<AppRunContext>()`，并在每次 `run({ context })` 中传入
由服务端认证结果构造的上下文；它只会进入当前 Run 的 Guard 和工具执行函数。

完整架构、使用方式与开发规范见[中文项目文档](./docs/README.md)。下方暂时保留原前端模板说明，前端只用于联调。

<p align='center'>
  <img src='https://user-images.githubusercontent.com/11247099/111864893-a457fd00-899e-11eb-9f05-f4b88987541d.png' alt='Vitesse - Opinionated Vite Starter Template' width='600'/>
</p>

<h6 align='center'>
<a href="https://vitesse-lite.netlify.app/">Live Demo</a>
</h6>

<h5 align='center'>
<b>Lightweight version of <a href="https://github.com/antfu/vitesse">Vitesse</a></b>
</h5>

<br>

<p align='center'>
<b>English</b> | <a href="https://github.com/antfu-collective/vitesse-lite/blob/main/README.zh-CN.md">简体中文</a>
<!-- Contributors: Thanks for geting interested, however we DON'T accept new transitions to the README, thanks. -->
</p>

## Features

- ⚡️ [Vue 3](https://github.com/vuejs/core), [Vite](https://github.com/vitejs/vite), [pnpm](https://pnpm.io/), [ESBuild](https://github.com/evanw/esbuild) - born with fastness

- 🗂 [File based routing](./src/pages)

- 📦 [Components auto importing](./src/components)

- 🎨 [UnoCSS](https://github.com/antfu/unocss) - The instant on-demand atomic CSS engine.

- 😃 Use icons from any icon sets in [Pure CSS](https://github.com/antfu/unocss/tree/main/packages/preset-icons)

- 🔥 Use the [new `<script setup>` style](https://github.com/vuejs/rfcs/pull/227)

- ✅ Use [Vitest](http://vitest.dev/) for unit and components testing

- 🦾 TypeScript, of course

- ☁️ Deploy on Netlify, zero-config

<br>

See [Vitesse](https://github.com/antfu/vitesse) for full featureset.

## Dropped Features from [Vitesse](https://github.com/antfu/vitesse)

- ~~i18n~~
- ~~Layouts~~
- ~~SSG~~
- ~~PWA~~
- ~~Markdown~~

## Pre-packed

### UI Frameworks

- [UnoCSS](https://github.com/antfu/unocss) - The instant on-demand atomic CSS engine.

### Icons

- [Iconify](https://iconify.design) - use icons from any icon sets [🔍Icônes](https://icones.netlify.app/)
- [Pure CSS Icons via UnoCSS](https://github.com/antfu/unocss/tree/main/packages/preset-icons)

### Plugins

- [Vue Router](https://github.com/vuejs/vue-router) - file system based routing
- [`unplugin-auto-import`](https://github.com/antfu/unplugin-auto-import) - Directly use Vue Composition API and others without importing
- [`unplugin-vue-components`](https://github.com/antfu/unplugin-vue-components) - components auto import
- [`unplugin-vue-macros`](https://github.com/sxzz/unplugin-vue-macros) - Explore and extend more macros and syntax sugar to Vue.
- [VueUse](https://github.com/antfu/vueuse) - collection of useful composition APIs

## Try it now!

### GitHub Template

[Create a repo from this template on GitHub](https://github.com/antfu-collective/vitesse-lite/generate).

### Clone to local

If you prefer to do it manually with the cleaner git history

```bash
npx degit antfu-collective/vitesse-lite my-vitesse-app
cd my-vitesse-app
pnpm i # If you don't have pnpm installed, run: npm install -g pnpm
```
