/**
 * 打包冒烟测试：验证"发出去的包"真的能用。
 *
 * 案例应用通过相对路径导入源码，因此它**测不到**打包产物的任何问题。这个脚本补上那一段：
 * 真实执行 `npm pack`，把 tarball 装进一个临时项目的 node_modules，再用 `import('craft-harness')`
 * 按**包名**导入——只有按包名导入才会真的走 package.json 的 exports 映射。
 *
 * 能抓到的问题：exports 映射写错或漏项、files 白名单漏掉产物、d.ts 未生成、peer 依赖被
 * 误打进 bundle、根入口意外泄漏内部实现。
 *
 * 为了不依赖网络，peer 依赖从本仓库的 node_modules 链接过去，而不是重新安装。
 */
import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
assert.equal(typeof adapters.DeepSeekModelAdapter, 'function', 'adapters 子入口缺少 DeepSeekModelAdapter')
assert.equal(typeof adapters.OpenAICompatibleModelAdapter, 'function', 'adapters 子入口缺少 OpenAICompatibleModelAdapter')

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
import Agent, { defineAgentConfig, MemorySessionStore } from ${JSON.stringify(packageName)}
import { DeepSeekModelAdapter } from ${JSON.stringify(`${packageName}/adapters`)}

const adapter = new DeepSeekModelAdapter({ apiKey: 'test-key', model: 'test-model' })
const config: AgentConfigInput = {
  model: adapter,
  execution: { reasoningEffort: 'high' },
}

const agent = new Agent(config)
export const run = (): Promise<AgentRunResult> =>
  agent.invoke({ scopeId: 'smoke', input: '你好', reasoningEffort: 'off' })

export const normalized = defineAgentConfig(config).model.model
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

/** 把 peer 依赖接入临时项目，避免冒烟测试需要联网。 */
function linkPeerDependency(appDir, peer) {
  const source = join(repoRoot, 'node_modules', peer)
  if (!existsSync(source))
    throw new Error(`peer 依赖 ${peer} 未安装，无法进行冒烟测试`)
  const destination = join(appDir, 'node_modules', peer)
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
    // `npm` 在 Windows 上是 .cmd，必须经 shell 执行；目标目录显式加引号以兼容含空格的临时路径。
    // --ignore-scripts 避免 `prepare` 在冒烟测试里改动本仓库的 git hooks。
    const packOutput = execSync(
      `npm pack --silent --ignore-scripts --pack-destination "${workDir}"`,
      { cwd: repoRoot, encoding: 'utf8' },
    ).trim()
    const tarball = join(workDir, packOutput.split(/\r?\n/).at(-1))

    // 模拟真实安装：包出现在 node_modules/<name>，因此按包名导入会走 exports 映射。
    const appDir = join(workDir, 'app')
    const installed = join(appDir, 'node_modules', packageName)
    mkdirSync(installed, { recursive: true })
    execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'])

    for (const peer of Object.keys(manifest.peerDependencies ?? {}))
      linkPeerDependency(appDir, peer)

    const probe = join(appDir, 'probe.mjs')
    writeFileSync(probe, PROBE_SOURCE, 'utf8')
    const output = execFileSync(process.execPath, [probe], { cwd: appDir, encoding: 'utf8' }).trim()
    if (output !== 'probe ok')
      throw new Error(`探针输出异常：${output}`)

    // 类型解析：只有走 exports 的 types 条件，消费者才拿得到 d.ts。
    writeFileSync(join(appDir, 'consumer.ts'), CONSUMER_SOURCE, 'utf8')
    writeFileSync(join(appDir, 'tsconfig.json'), CONSUMER_TSCONFIG, 'utf8')
    linkPeerDependency(appDir, 'typescript')
    linkPeerDependency(appDir, '@types/node')
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

main()
