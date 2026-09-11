import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function collectTypeScriptFiles(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name)
    return statSync(child).isDirectory()
      ? collectTypeScriptFiles(child)
      : child.endsWith('.ts')
        ? [child]
        : []
  })
}

/** 库核心：不包含 co-located 的官方 Adapter，它们有自己的依赖边界。 */
function collectHarnessCoreFiles(): string[] {
  const root = join(process.cwd(), 'src')
  return ['agent', 'contracts', 'core', 'sessions', 'tools', 'types']
    .flatMap(name => collectTypeScriptFiles(join(root, name)))
}

/** 库全部源码；用于检查库不会反向依赖案例应用。 */
function collectHarnessFiles(): string[] {
  return collectTypeScriptFiles(join(process.cwd(), 'src'))
}

describe('model dependency boundary', () => {
  it('keeps OpenAI SDK imports out of the harness Core', () => {
    const files = collectHarnessCoreFiles()

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"]openai[/'"]/)
    }
  })

  it('keeps co-located official adapters outside the Core dependency graph', () => {
    const files = collectHarnessCoreFiles()

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"][^'"]*adapters/)
    }
  })

  it('keeps provider presets and testing exports out of the generic production entry', () => {
    const compatibleSource = readFileSync(join(
      process.cwd(),
      'src/adapters/openai-compatible/openai-compatible-model-adapter.ts',
    ), 'utf8')
    const productionIndex = readFileSync(join(
      process.cwd(),
      'src/adapters/index.ts',
    ), 'utf8')
    const sessionIndex = readFileSync(join(
      process.cwd(),
      'src/sessions/index.ts',
    ), 'utf8')

    expect(compatibleSource).not.toMatch(/deepseek/i)
    expect(productionIndex).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*testing/i)
    expect(sessionIndex).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*testing/i)
  })

  it('keeps the published harness independent from the co-located sample app', () => {
    const files = collectHarnessFiles()

    // 案例应用是库的使用者，方向不能反过来：库一旦依赖 sample，发布出去的包就会
    // 要求使用者安装 Fastify、pg 和 Vue。
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"][^'"]*sample\//)
    }
  })
})
