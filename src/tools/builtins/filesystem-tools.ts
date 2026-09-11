import type { WorkspaceRuntime } from './workspace'
import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { diagnostic } from '../../locale'
import { defineTool } from '../define-tool'
import { ToolError } from '../errors'
import { fileSystemError, pathExists, readWorkspaceText, writeWorkspaceTextAtomically } from './workspace'

const workspacePathSchema = z.string().min(1).max(4_096)

const readOutputSchema = z.strictObject({
  file_path: z.string(),
  offset: z.number().int().positive(),
  total_lines: z.number().int().nonnegative(),
  lines: z.array(z.strictObject({
    number: z.number().int().positive(),
    text: z.string(),
  })),
  truncated: z.boolean(),
})

/** 创建共享观察版本的 read、write、edit 工具。 */
export function createFilesystemTools(runtime: WorkspaceRuntime) {
  return Object.freeze([createReadTool(runtime), createWriteTool(runtime), createEditTool(runtime)] as const)
}

function createReadTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'read',
    description: '读取 workspace 内的 UTF-8 文本文件。返回带行号的分页内容；修改已有文件前应先调用本工具。',
    inputSchema: z.strictObject({
      file_path: workspacePathSchema.describe('相对于 workspace 的文件路径。'),
      offset: z.number().int().min(1).optional().describe('从第几行开始，默认 1。'),
      limit: z.number().int().min(1).max(runtime.options.readLimit).optional().describe(
        `最多返回多少行，默认且最多 ${runtime.options.readLimit}。`,
      ),
    }),
    outputSchema: readOutputSchema,
    metadata: { category: 'filesystem', mutates: false },
    async execute(input) {
      const target = await runtime.resolve(input.file_path)
      const result = await readWorkspaceText(runtime, target)
      const allLines = splitLines(result.content)
      const offset = input.offset ?? 1
      const limit = input.limit ?? runtime.options.readLimit
      const lines: Array<{ number: number, text: string }> = []
      let usedBytes = 0
      let truncated = offset > allLines.length + 1
      for (let index = offset - 1; index < allLines.length && lines.length < limit; index++) {
        const text = truncateLine(allLines[index], runtime.options.readMaxLineLength)
        const bytes = Buffer.byteLength(text, 'utf8')
        if (lines.length > 0 && usedBytes + bytes > runtime.options.readMaxBytes) {
          truncated = true
          break
        }
        lines.push({ number: index + 1, text })
        usedBytes += bytes
      }
      truncated ||= offset - 1 + lines.length < allLines.length
      runtime.observe(target, result.stat)
      return { file_path: target.relativePath, offset, total_lines: allLines.length, lines, truncated }
    },
    renderOutput(value) {
      const body = value.lines.map(line => `${line.number}\t${line.text}`).join('\n')
      const end = value.lines.at(-1)?.number ?? value.offset - 1
      const footer = `[${value.file_path}: lines ${value.offset}-${end} of ${value.total_lines}${value.truncated ? '; truncated' : ''}]`
      return body ? `${body}\n${footer}` : footer
    },
  }, { locale: runtime.options.locale })
}

function createWriteTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'write',
    description: '在 workspace 内创建或完整写入 UTF-8 文本文件。覆盖已有文件前必须先 read；不会自动创建父目录。',
    inputSchema: z.strictObject({
      file_path: workspacePathSchema.describe('相对于 workspace 的文件路径。'),
      content: z.string().describe('要写入的完整 UTF-8 文本。'),
    }),
    outputSchema: z.strictObject({
      file_path: z.string(),
      created: z.boolean(),
      bytes: z.number().int().nonnegative(),
    }),
    metadata: { category: 'filesystem', mutates: true },
    guard: ({ input }) => ({
      decision: 'ask',
      title: '写入文件',
      reason: `工具准备写入 workspace 文件“${input.file_path}”`,
      details: { file_path: input.file_path },
    }),
    async execute(input) {
      assertWriteSize(input.content, runtime.options.writeMaxBytes, runtime.options.locale)
      const target = await runtime.resolve(input.file_path)
      return await runtime.withPathLock(target, async () => {
        const existing = await pathExists(target, runtime.options.locale)
        if (existing) {
          let current
          try {
            current = await stat(target.absolutePath)
          }
          catch (error) {
            throw fileSystemError('inspect', target.relativePath, error, runtime.options.locale)
          }
          if (!current.isFile())
            throw new ToolError({ code: 'FS_NOT_FILE', message: diagnostic(runtime.options.locale, `不能写入“${target.relativePath}”：目标不是普通文件`, `Cannot write "${target.relativePath}": target is not a regular file`) })
          runtime.requireFreshObservation(target, current)
        }
        const written = await writeWorkspaceTextAtomically(target, input.content, existing, runtime.options.locale)
        runtime.observe(target, written)
        return {
          file_path: target.relativePath,
          created: !existing,
          bytes: Buffer.byteLength(input.content, 'utf8'),
        }
      })
    },
  }, { locale: runtime.options.locale })
}

function createEditTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'edit',
    description: '精确替换 workspace 内 UTF-8 文本文件的一段内容。必须先 read；默认要求 old_string 只出现一次。',
    inputSchema: z.strictObject({
      file_path: workspacePathSchema.describe('相对于 workspace 的文件路径。'),
      old_string: z.string().min(1).describe('需要匹配的原始文本，必须完全一致。'),
      new_string: z.string().describe('替换后的文本。'),
      replace_all: z.boolean().optional().describe('是否替换所有匹配，默认 false。'),
    }),
    outputSchema: z.strictObject({
      file_path: z.string(),
      replacements: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    }),
    metadata: { category: 'filesystem', mutates: true },
    guard: ({ input }) => ({
      decision: 'ask',
      title: '编辑文件',
      reason: `工具准备编辑 workspace 文件“${input.file_path}”`,
      details: { file_path: input.file_path, replace_all: input.replace_all ?? false },
    }),
    async execute(input) {
      assertWriteSize(input.old_string, runtime.options.writeMaxBytes, runtime.options.locale)
      assertWriteSize(input.new_string, runtime.options.writeMaxBytes, runtime.options.locale)
      const target = await runtime.resolve(input.file_path)
      return await runtime.withPathLock(target, async () => {
        const result = await readWorkspaceText(runtime, target)
        runtime.requireFreshObservation(target, result.stat)
        const matches = countOccurrences(result.content, input.old_string)
        if (matches === 0)
          throw new ToolError({ code: 'FS_EDIT_NO_MATCH', message: diagnostic(runtime.options.locale, `不能编辑“${target.relativePath}”：old_string 未找到`, `Cannot edit "${target.relativePath}": old_string was not found`) })
        if (!input.replace_all && matches !== 1) {
          throw new ToolError({
            code: 'FS_EDIT_AMBIGUOUS',
            message: diagnostic(runtime.options.locale, `不能编辑“${target.relativePath}”：old_string 出现 ${matches} 次，请增加上下文或启用 replace_all`, `Cannot edit "${target.relativePath}": old_string occurs ${matches} times; add context or enable replace_all`),
          })
        }
        const updated = input.replace_all
          ? result.content.split(input.old_string).join(input.new_string)
          : result.content.replace(input.old_string, input.new_string)
        assertWriteSize(updated, runtime.options.writeMaxBytes, runtime.options.locale)
        const written = await writeWorkspaceTextAtomically(target, updated, true, runtime.options.locale)
        runtime.observe(target, written)
        return {
          file_path: target.relativePath,
          replacements: input.replace_all ? matches : 1,
          bytes: Buffer.byteLength(updated, 'utf8'),
        }
      })
    },
  }, { locale: runtime.options.locale })
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/)
  if (lines.length > 1 && lines.at(-1) === '')
    lines.pop()
  return lines
}

function truncateLine(value: string, maxLength: number): string {
  if (value.length <= maxLength)
    return value
  return `${value.slice(0, maxLength)}…`
}

function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    index = content.indexOf(needle, index)
    if (index === -1)
      return count
    count++
    index += needle.length
  }
}

function assertWriteSize(content: string, maxBytes: number, locale: import('../../locale').HarnessLocale): void {
  if (Buffer.byteLength(content, 'utf8') > maxBytes)
    throw new ToolError({ code: 'FS_WRITE_TOO_LARGE', message: diagnostic(locale, `写入内容超过 ${maxBytes} 字节上限`, `Write content exceeds the ${maxBytes}-byte limit`) })
}
