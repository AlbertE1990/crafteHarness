import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

interface DocumentationChunk {
  readonly source: string
  readonly heading: string
  readonly content: string
}

export interface CraftHarnessDocumentationMatch {
  readonly source: string
  readonly heading: string
  readonly excerpt: string
  readonly score: number
}

const moduleUrl = new URL(import.meta.url)
const DEFAULT_PROJECT_ROOT = moduleUrl.protocol === 'file:'
  ? fileURLToPath(new URL('../../../', moduleUrl))
  : process.cwd()
const MAX_CHUNK_CHARACTERS = 1_800
let documentationIndex: Promise<readonly DocumentationChunk[]> | undefined

/**
 * 检索随部署附带的 Craft Harness 官方文档。
 *
 * 用户输入只参与内存文本评分，不能控制文件路径；文件读取范围固定为 README、learning 和
 * standards，避免把源码、环境文件或凭据意外暴露给模型。
 */
export async function searchCraftHarnessDocumentation(
  query: string,
  limit = 4,
): Promise<readonly CraftHarnessDocumentationMatch[]> {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery)
    return []

  const terms = createSearchTerms(normalizedQuery)
  const chunks = await (documentationIndex ??= buildDocumentationIndex())
  return chunks
    .map((chunk) => {
      const heading = chunk.heading.toLowerCase()
      const content = chunk.content.toLowerCase()
      let score = content.includes(normalizedQuery) ? 12 : 0
      for (const term of terms) {
        if (heading.includes(term))
          score += 5
        score += Math.min(3, countOccurrences(content, term))
      }
      return { chunk, score }
    })
    .filter(result => result.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.min(6, Math.max(1, limit)))
    .map(({ chunk, score }) => ({
      source: chunk.source,
      heading: chunk.heading,
      excerpt: createExcerpt(chunk.content, terms),
      score,
    }))
}

async function buildDocumentationIndex(): Promise<readonly DocumentationChunk[]> {
  const projectRoot = path.resolve(process.env.CRAFT_HARNESS_DOCS_ROOT ?? DEFAULT_PROJECT_ROOT)
  const files = [
    path.join(projectRoot, 'README.md'),
    ...await listMarkdownFiles(path.join(projectRoot, 'docs', 'learning')),
    ...await listMarkdownFiles(path.join(projectRoot, 'docs', 'standards')),
  ]
  const chunks: DocumentationChunk[] = []
  for (const file of files) {
    const markdown = await readFile(file, 'utf8')
    chunks.push(...chunkMarkdown(
      markdown,
      path.relative(projectRoot, file).replaceAll(path.sep, '/'),
    ))
  }
  return Object.freeze(chunks)
}

async function listMarkdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory())
      return await listMarkdownFiles(target)
    return entry.isFile() && entry.name.endsWith('.md') ? [target] : []
  }))
  return nested.flat().sort()
}

function chunkMarkdown(markdown: string, source: string): DocumentationChunk[] {
  const chunks: DocumentationChunk[] = []
  let heading = source === 'README.md' ? 'Craft Harness' : source
  let lines: string[] = []

  const flush = (): void => {
    const content = lines.join('\n').trim()
    if (content)
      chunks.push({ source, heading, content })
    lines = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    const headingDepth = line.search(/[^#]/)
    if (headingDepth >= 1 && headingDepth <= 4 && line[headingDepth] === ' ') {
      flush()
      heading = line.slice(headingDepth + 1).trim()
      continue
    }
    if (lines.join('\n').length + line.length > MAX_CHUNK_CHARACTERS)
      flush()
    lines.push(line)
  }
  flush()
  return chunks
}

/** 英文按单词、中文按 2～3 字滑窗拆分，让自然问句也能命中文档标题。 */
function createSearchTerms(query: string): readonly string[] {
  const terms = new Set<string>()
  for (const match of query.matchAll(/[a-z0-9_-]{2,}|[\u3400-\u9FFF]+/g)) {
    const value = match[0]
    if (!/[\u3400-\u9FFF]/.test(value)) {
      terms.add(value)
      continue
    }
    if (value.length <= 3) {
      terms.add(value)
      continue
    }
    for (const size of [2, 3]) {
      for (let index = 0; index <= value.length - size; index++)
        terms.add(value.slice(index, index + size))
    }
  }
  return [...terms]
}

function countOccurrences(content: string, term: string): number {
  let count = 0
  let offset = 0
  while (true) {
    const match = content.indexOf(term, offset)
    if (match < 0)
      break
    count++
    offset = match + term.length
  }
  return count
}

function createExcerpt(content: string, terms: readonly string[]): string {
  const lower = content.toLowerCase()
  const firstMatch = terms
    .map(term => lower.indexOf(term))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0
  const start = Math.max(0, firstMatch - 180)
  const end = Math.min(content.length, start + 900)
  return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`
}
