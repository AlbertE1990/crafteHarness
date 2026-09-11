import type { WorkspaceRuntime } from './workspace'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { z } from 'zod'
import { defineTool, ToolError } from '../tools'

const workspacePathSchema = z.string().min(1).max(4_096)
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

/** 创建不经过 shell 拼接的 glob 与 grep 工具。 */
export function createSearchTools(runtime: WorkspaceRuntime) {
  return Object.freeze([createGlobTool(runtime), createGrepTool(runtime)] as const)
}

function createGlobTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'glob',
    description: '按 glob 模式列出 workspace 内的文件。包含隐藏和 ignore 文件，但排除版本控制元数据，结果有数量上限。',
    inputSchema: z.strictObject({
      pattern: z.string().min(1).max(4_096).describe('ripgrep glob 模式，例如 **/*.ts。'),
      path: workspacePathSchema.optional().describe('相对于 workspace 的搜索目录，默认 workspace 根目录。'),
    }),
    outputSchema: z.strictObject({ paths: z.array(z.string()), truncated: z.boolean() }),
    metadata: { category: 'search', mutates: false },
    execution: { timeoutMs: runtime.options.searchTimeoutMs },
    async execute(input, context) {
      const root = await runtime.resolve('.')
      const target = await runtime.resolve(input.path ?? '.')
      const result = await runRipgrep([
        '--files',
        '--hidden',
        '--no-ignore',
        '--null',
        '--sort',
        'path',
        '--glob',
        '!.git',
        '--glob',
        '!.git/**',
        '--glob',
        input.pattern,
        '.',
      ], target.absolutePath, context.signal)
      const found = result.stdout.split('\0').filter(Boolean)
      return {
        paths: found.slice(0, runtime.options.globLimit).map(file => (
          portable(path.relative(root.absolutePath, path.resolve(target.absolutePath, file)))
        )),
        truncated: found.length > runtime.options.globLimit || result.truncated,
      }
    },
    renderOutput(value) {
      const body = value.paths.join('\n') || '[no files found]'
      return value.truncated ? `${body}\n[results truncated]` : body
    },
  })
}

function createGrepTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'grep',
    description: '使用 ripgrep 正则表达式搜索 workspace 内文件内容，返回文件、行号和匹配行；结果有数量上限。',
    inputSchema: z.strictObject({
      pattern: z.string().min(1).max(4_096).describe('ripgrep 正则表达式。'),
      path: workspacePathSchema.optional().describe('相对于 workspace 的文件或目录，默认 workspace 根目录。'),
      include: z.string().min(1).max(4_096).optional().describe('可选文件 glob，例如 *.ts 或 **/*.md。'),
    }),
    outputSchema: z.strictObject({
      matches: z.array(z.strictObject({
        file_path: z.string(),
        line_number: z.number().int().positive(),
        text: z.string(),
      })),
      truncated: z.boolean(),
    }),
    metadata: { category: 'search', mutates: false },
    execution: { timeoutMs: runtime.options.searchTimeoutMs },
    async execute(input, context) {
      const root = await runtime.resolve('.')
      const target = await runtime.resolve(input.path ?? '.')
      const args = ['--json', '--hidden', '--no-ignore', '--glob', '!.git', '--glob', '!.git/**']
      if (input.include)
        args.push('--glob', input.include)
      args.push('--regexp', input.pattern, target.absolutePath)
      const result = await runRipgrep(args, root.absolutePath, context.signal)
      const found = parseMatches(result.stdout, root.absolutePath)
      return {
        matches: found.slice(0, runtime.options.grepLimit),
        truncated: found.length > runtime.options.grepLimit || result.truncated,
      }
    },
    renderOutput(value) {
      const body = value.matches.map(item => `${item.file_path}:${item.line_number}:${item.text}`).join('\n')
        || '[no matches found]'
      return value.truncated ? `${body}\n[results truncated]` : body
    },
  })
}

async function runRipgrep(args: readonly string[], cwd: string, signal: AbortSignal) {
  return await new Promise<{ stdout: string, truncated: boolean }>((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let truncated = false
    let settled = false
    const onAbort = () => child.kill()
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      const appended = appendBounded(stdout, chunk, MAX_CAPTURE_BYTES)
      stdout = appended.value
      truncated ||= appended.truncated
      if (truncated)
        child.kill()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, 16 * 1024).value
    })
    child.once('error', (error) => {
      if (settled)
        return
      settled = true
      signal.removeEventListener('abort', onAbort)
      child.kill()
      reject(new ToolError({ code: 'SEARCH_FAILED', message: '无法启动内置 ripgrep', cause: error }))
    })
    child.once('close', (code) => {
      if (settled)
        return
      settled = true
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) {
        reject(new ToolError({ code: 'ABORTED', message: '搜索已取消' }))
        return
      }
      if (code !== 0 && code !== 1 && !truncated) {
        reject(new ToolError({
          code: 'SEARCH_FAILED',
          message: stderr.toString('utf8').trim() || `ripgrep 退出码：${String(code)}`,
        }))
        return
      }
      resolve({ stdout: stdout.toString('utf8'), truncated })
    })
  })
}

function parseMatches(stdout: string, root: string) {
  const result: Array<{ file_path: string, line_number: number, text: string }> = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line)
      continue
    let event: RipgrepEvent
    try {
      event = JSON.parse(line) as RipgrepEvent
    }
    catch {
      continue
    }
    if (event.type !== 'match' || !event.data?.path?.text || !event.data.lines?.text || !event.data.line_number)
      continue
    result.push({
      file_path: portable(path.relative(root, path.resolve(root, event.data.path.text))),
      line_number: event.data.line_number,
      text: event.data.lines.text.replace(/\r?\n$/, ''),
    })
  }
  return result
}

interface RipgrepEvent {
  readonly type?: string
  readonly data?: {
    readonly path?: { readonly text?: string }
    readonly lines?: { readonly text?: string }
    readonly line_number?: number
  }
}

function appendBounded(current: Buffer<ArrayBufferLike>, chunk: Buffer, maxBytes: number) {
  if (current.length >= maxBytes)
    return { value: current, truncated: true }
  const available = maxBytes - current.length
  return { value: Buffer.concat([current, chunk.subarray(0, available)]), truncated: chunk.length > available }
}

function portable(value: string): string {
  return value.split(path.sep).join('/')
}
