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

function collectCommonAgentCoreFiles(): string[] {
  const root = join(process.cwd(), 'src/common-agent')
  return readdirSync(root).flatMap((name) => {
    if (name === 'adapters')
      return []
    const child = join(root, name)
    return statSync(child).isDirectory()
      ? collectTypeScriptFiles(child)
      : child.endsWith('.ts')
        ? [child]
        : []
  })
}

describe('model dependency boundary', () => {
  it('keeps OpenAI SDK imports out of CommonAgent Core and server Agent', () => {
    const files = [
      ...collectCommonAgentCoreFiles(),
      join(process.cwd(), 'src/server/agent.ts'),
    ]

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"]openai[/'"]/)
    }
  })

  it('keeps co-located official adapters outside the Core dependency graph', () => {
    const files = collectCommonAgentCoreFiles()

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"][^'"]*adapters/)
    }
  })

  it('keeps provider presets and testing exports out of the generic production entry', () => {
    const compatibleSource = readFileSync(join(
      process.cwd(),
      'src/common-agent/adapters/openai-compatible/openai-compatible-model-adapter.ts',
    ), 'utf8')
    const productionIndex = readFileSync(join(
      process.cwd(),
      'src/common-agent/adapters/index.ts',
    ), 'utf8')

    expect(compatibleSource).not.toMatch(/deepseek/i)
    expect(productionIndex).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*testing/i)
  })
})
