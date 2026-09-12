/**
 * 打包冒烟测试：验证"发出去的包"真的能用。
 *
 * 案例应用通过相对路径导入源码，因此它**测不到**打包产物的任何问题。这个脚本补上那一段：
 * 真实执行 `pnpm pack`，把 tarball 装进一个临时项目的 node_modules，再用 `import('craft-harness')`
 * 按**包名**导入——只有按包名导入才会真的走 package.json 的 exports 映射。
 *
 * 能抓到的问题：exports 映射写错或漏项、files 白名单漏掉产物、d.ts 未生成、运行依赖被
 * 误打进 bundle、根入口意外泄漏内部实现。
 *
 * 为了不依赖网络，运行依赖从本仓库的 node_modules 链接过去，而不是重新安装。
 */
import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'

const repoRoot = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const packageName = manifest.name

/** 在临时项目里按包名导入产物，并断言对外契约。 */
const PROBE_SOURCE = `
import assert from 'node:assert/strict'

const runtime = await import(${JSON.stringify(packageName)})
const adapters = await import(${JSON.stringify(`${packageName}/adapters`)})

assert.equal(typeof runtime.Agent, 'function', '根入口缺少 Agent')
assert.equal(typeof runtime.defineAgentConfig, 'function', '根入口缺少 defineAgentConfig')
assert.equal(typeof runtime.MemorySessionStore, 'function', '根入口缺少 MemorySessionStore')
assert.equal(typeof runtime.createWorkspaceTools, 'function', '根入口缺少 createWorkspaceTools')
assert.equal(typeof runtime.z.strictObject, 'function', '根入口缺少 z')
assert.equal(typeof adapters.DeepSeekAdapter, 'function', 'adapters 子入口缺少 DeepSeekAdapter')
assert.equal(typeof adapters.OpenAICompatibleAdapter, 'function', 'adapters 子入口缺少 OpenAICompatibleAdapter')

// 公共入口不应泄漏内部归一化实现。
assert.ok(!('normalizeAgentToolDefinitions' in runtime), '根入口泄漏了内部实现')

console.log('probe ok')
`

/**
 * TypeScript 消费者样本。
 *
 * 运行时导入成功不代表类型可用：exports 的 types 条件写错、或 d.ts 没进 tarball，
 * 都会让使用者在这里失败而在上面通过。
 */
const CONSUMER_SOURCE = `
import type { AgentConfigInput, AgentRunResult } from ${JSON.stringify(packageName)}
import Agent, { defineAgentConfig, defineTool, MemorySessionStore, z } from ${JSON.stringify(packageName)}
import { DeepSeekAdapter } from ${JSON.stringify(`${packageName}/adapters`)}

const adapter = new DeepSeekAdapter({ apiKey: 'test-key' })
const config: AgentConfigInput = {
  adapter,
  model: { id: 'test-model', reasoningEffort: 'high' },
}

const agent = new Agent(config)
export const tool = defineTool({
  name: 'echo',
  description: 'echo',
  inputSchema: z.strictObject({ text: z.string() }),
  outputSchema: z.strictObject({ text: z.string() }),
  execute: input => input,
})
export const run = (): Promise<AgentRunResult> =>
  agent.invoke({
    scopeId: 'smoke',
    input: '你好',
    model: { id: 'test-model', reasoningEffort: 'off' },
  })

export const normalized = defineAgentConfig(config).model.id
export const store = new MemorySessionStore()
`

/** 消费者 tsconfig：真实使用者会用的 bundler 解析，必须走 exports 的 types 条件。 */
const CONSUMER_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2021',
    lib: ['ESNext'],
    module: 'ESNext',
    moduleResolution: 'bundler',
    types: ['node'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  },
  include: ['consumer.ts'],
}, null, 2)

/** 把依赖接入临时项目，避免冒烟测试需要联网。 */
function linkDependency(appDir, dependency) {
  const source = join(repoRoot, 'node_modules', dependency)
  if (!existsSync(source))
    throw new Error(`依赖 ${dependency} 未安装，无法进行冒烟测试`)
  const destination = join(appDir, 'node_modules', dependency)
  mkdirSync(dirname(destination), { recursive: true })
  try {
    symlinkSync(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }
  catch {
    // 少数权限环境拒绝创建链接；退化为复制，保证脚本仍能给出结论。
    cpSync(source, destination, { recursive: true, dereference: true })
  }
}

function main() {
  if (!existsSync(join(repoRoot, 'dist', 'index.js')))
    throw new Error('缺少 dist/index.js：请先执行 pnpm build')

  const workDir = mkdtempSync(join(tmpdir(), 'craft-harness-smoke-'))
  try {
    // pnpm publish/pack 会把 workspace catalog 解析成普通版本；冒烟必须验证这份最终清单。
    const packOutput = execSync(
      `pnpm pack --silent --pack-destination "${workDir}"`,
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim()
    const packedPath = packOutput.split(/\r?\n/).at(-1)
    const tarball = isAbsolute(packedPath) ? packedPath : join(workDir, packedPath)

    // 模拟真实安装：包出现在 node_modules/<name>，因此按包名导入会走 exports 映射。
    const appDir = join(workDir, 'app')
    const installed = join(appDir, 'node_modules', packageName)
    mkdirSync(installed, { recursive: true })
    execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'])

    // npm 消费者不认识 workspace/catalog 协议；pnpm 生成的最终清单不得继续泄漏它们。
    const packedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, specifier] of Object.entries(packedManifest[section] ?? {})) {
        assertPublishableSpecifier(section, name, specifier)
      }
    }
    for (const requiredDependency of ['openai', 'zod']) {
      if (!packedManifest.dependencies?.[requiredDependency])
        throw new Error(`发布清单缺少运行依赖 ${requiredDependency}`)
      if (packedManifest.peerDependencies?.[requiredDependency])
        throw new Error(`发布清单不能把 ${requiredDependency} 保留为 peer 依赖`)
    }

    for (const peer of Object.keys(manifest.peerDependencies ?? {}))
      linkDependency(appDir, peer)
    // 冒烟测试离线手工展开 tarball，因此也要模拟包管理器安装普通依赖。
    for (const dependency of Object.keys(manifest.dependencies ?? {}))
      linkDependency(appDir, dependency)
    if (manifest.dependencies?.['@vscode/ripgrep']) {
      linkDependency(
        appDir,
        `@vscode/ripgrep-${process.platform}-${process.arch}`,
      )
    }

    const probe = join(appDir, 'probe.mjs')
    writeFileSync(probe, PROBE_SOURCE, 'utf8')
    const output = execFileSync(process.execPath, [probe], { cwd: appDir, encoding: 'utf8' }).trim()
    if (output !== 'probe ok')
      throw new Error(`探针输出异常：${output}`)

    // 类型解析：只有走 exports 的 types 条件，消费者才拿得到 d.ts。
    writeFileSync(join(appDir, 'consumer.ts'), CONSUMER_SOURCE, 'utf8')
    writeFileSync(join(appDir, 'tsconfig.json'), CONSUMER_TSCONFIG, 'utf8')
    linkDependency(appDir, 'typescript')
    linkDependency(appDir, '@types/node')
    execFileSync(
      process.execPath,
      [join(appDir, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '-p', 'tsconfig.json'],
      { cwd: appDir, stdio: 'inherit' },
    )

    const packedFiles = execSync(`tar -tzf "${tarball}"`, { encoding: 'utf8' })
    for (const required of ['package/package.json', 'package/dist/index.js', 'package/dist/index.d.ts', 'package/dist/adapters/index.js']) {
      if (!packedFiles.includes(required))
        throw new Error(`tarball 缺少 ${required}，检查 files 白名单与构建产物`)
    }

    console.log(`smoke:pack ok — ${packageName} 可按包名导入，exports 映射与 files 白名单均已验证`)
  }
  finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

/** 阻止 monorepo 内部依赖协议泄漏到发布清单。 */
function assertPublishableSpecifier(section, name, specifier) {
  if (typeof specifier !== 'string' || /^(?:catalog|workspace):/.test(specifier)) {
    throw new Error(
      `package.json ${section}.${name} 使用了不可发布的依赖版本：${String(specifier)}`,
    )
  }
}

main()
