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

function collectCraftAgentCoreFiles(): string[] {
  const root = join(process.cwd(), 'src/craft-agent')
  return ['builtins', 'contracts', 'core', 'sessions', 'tools', 'types']
    .flatMap(name => collectTypeScriptFiles(join(root, name)))
}

describe('model dependency boundary', () => {
  it('keeps OpenAI SDK imports out of CraftAgent Core', () => {
    const files = collectCraftAgentCoreFiles()

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"]openai[/'"]/)
    }
  })

  it('keeps co-located official adapters outside the Core dependency graph', () => {
    const files = collectCraftAgentCoreFiles()

    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file)
        .not
        .toMatch(/from\s+['"][^'"]*adapters/)
    }
  })

  it('keeps provider presets and testing exports out of the generic production entry', () => {
    const compatibleSource = readFileSync(join(
      process.cwd(),
      'src/craft-agent/adapters/openai-compatible/openai-compatible-model-adapter.ts',
    ), 'utf8')
    const productionIndex = readFileSync(join(
      process.cwd(),
      'src/craft-agent/adapters/index.ts',
    ), 'utf8')

    expect(compatibleSource).not.toMatch(/deepseek/i)
    expect(productionIndex).not.toMatch(/export\s+\*\s+from\s+['"][^'"]*testing/i)
  })
})
