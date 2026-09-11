import type { WorkspaceRuntime } from './workspace'
import { Buffer } from 'node:buffer'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import { defineTool, ToolError } from '../tools'
import { fileSystemError, pathExists, readWorkspaceText, writeWorkspaceTextAtomically } from './workspace'

const filePathSchema = z.string().min(1).max(4_096)

/** 创建共享观察版本的 read、write、edit 工具。 */
export function createFilesystemTools(runtime: WorkspaceRuntime) {
  return Object.freeze([createReadTool(runtime), createWriteTool(runtime), createEditTool(runtime)] as const)
}

function createReadTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'read',
    description: '读取 workspace 内的 UTF-8 文本文件，返回带行号分页；修改已有文件前应先调用本工具。',
    inputSchema: z.strictObject({
      file_path: filePathSchema.describe('相对于 workspace 的文件路径。'),
      offset: z.number().int().min(1).optional().describe('起始行，默认 1。'),
      limit: z.number().int().min(1).max(runtime.options.readLimit).optional().describe('最多返回行数。'),
    }),
    outputSchema: z.strictObject({
      file_path: z.string(),
      offset: z.number().int().positive(),
      total_lines: z.number().int().nonnegative(),
      lines: z.array(z.strictObject({ number: z.number().int().positive(), text: z.string() })),
      truncated: z.boolean(),
    }),
    metadata: { category: 'filesystem', mutates: false },
    async execute(input) {
      const target = await runtime.resolve(input.file_path)
      const result = await readWorkspaceText(runtime, target)
      const allLines = result.content.split(/\r?\n/)
      if (allLines.length > 1 && allLines.at(-1) === '')
        allLines.pop()
      const offset = input.offset ?? 1
      const limit = input.limit ?? runtime.options.readLimit
      const lines: Array<{ number: number, text: string }> = []
      let usedBytes = 0
      let truncated = offset > allLines.length + 1
      for (let index = offset - 1; index < allLines.length && lines.length < limit; index++) {
        const raw = allLines[index]
        const text = raw.length > runtime.options.readMaxLineLength
          ? `${raw.slice(0, runtime.options.readMaxLineLength)}…`
          : raw
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
  })
}

function createWriteTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'write',
    description: '在 workspace 内创建或完整写入 UTF-8 文本文件；覆盖已有文件前必须先 read。',
    inputSchema: z.strictObject({ file_path: filePathSchema, content: z.string() }),
    outputSchema: z.strictObject({
      file_path: z.string(),
      created: z.boolean(),
      bytes: z.number().int().nonnegative(),
    }),
    metadata: { category: 'filesystem', mutates: true },
    guard: ({ input }) => ({
      decision: 'ask',
      title: '写入文件',
      reason: `准备写入 workspace 文件“${input.file_path}”`,
      details: { file_path: input.file_path },
    }),
    async execute(input) {
      assertWriteSize(input.content, runtime.options.writeMaxBytes)
      const target = await runtime.resolve(input.file_path)
      return await runtime.withPathLock(target, async () => {
        const existing = await pathExists(target)
        if (existing) {
          let current
          try {
            current = await stat(target.absolutePath)
          }
          catch (error) {
            throw fileSystemError('inspect', target.relativePath, error)
          }
          if (!current.isFile())
            throw new ToolError({ code: 'FS_NOT_FILE', message: `不能写入“${target.relativePath}”：目标不是普通文件` })
          runtime.requireFreshObservation(target, current)
        }
        const written = await writeWorkspaceTextAtomically(target, input.content, existing)
        runtime.observe(target, written)
        return {
          file_path: target.relativePath,
          created: !existing,
          bytes: Buffer.byteLength(input.content, 'utf8'),
        }
      })
    },
  })
}

function createEditTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'edit',
    description: '精确替换 workspace 内 UTF-8 文件的一段内容；必须先 read，默认要求原文只出现一次。',
    inputSchema: z.strictObject({
      file_path: filePathSchema,
      old_string: z.string().min(1),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
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
      reason: `准备编辑 workspace 文件“${input.file_path}”`,
      details: { file_path: input.file_path, replace_all: input.replace_all ?? false },
    }),
    async execute(input) {
      const target = await runtime.resolve(input.file_path)
      return await runtime.withPathLock(target, async () => {
        const result = await readWorkspaceText(runtime, target)
        runtime.requireFreshObservation(target, result.stat)
        const matches = countOccurrences(result.content, input.old_string)
        if (matches === 0)
          throw new ToolError({ code: 'FS_EDIT_NO_MATCH', message: `不能编辑“${target.relativePath}”：old_string 未找到` })
        if (!input.replace_all && matches !== 1) {
          throw new ToolError({
            code: 'FS_EDIT_AMBIGUOUS',
            message: `不能编辑“${target.relativePath}”：old_string 出现 ${matches} 次，请增加上下文或启用 replace_all`,
          })
        }
        const updated = input.replace_all
          ? result.content.split(input.old_string).join(input.new_string)
          : result.content.replace(input.old_string, input.new_string)
        assertWriteSize(updated, runtime.options.writeMaxBytes)
        const written = await writeWorkspaceTextAtomically(target, updated, true)
        runtime.observe(target, written)
        return {
          file_path: target.relativePath,
          replacements: input.replace_all ? matches : 1,
          bytes: Buffer.byteLength(updated, 'utf8'),
        }
      })
    },
  })
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

function assertWriteSize(content: string, maxBytes: number): void {
  if (Buffer.byteLength(content, 'utf8') > maxBytes)
    throw new ToolError({ code: 'FS_WRITE_TOO_LARGE', message: `写入内容超过 ${maxBytes} 字节上限` })
}
