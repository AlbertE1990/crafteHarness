import type { WorkspaceRuntime } from './workspace'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import process from 'node:process'
import { z } from 'zod'
import { defineTool, ToolError } from '../tools'
import { fileSystemError } from './workspace'

/** 创建一次调用一个新 shell、默认要求审批的跨平台终端工具。 */
export function createTerminalTool(runtime: WorkspaceRuntime) {
  return defineTool({
    name: 'terminal',
    description: '在 workspace 内指定目录运行一次性系统 shell；调用间不保留 cwd、环境变量或后台任务。',
    inputSchema: z.strictObject({
      command: z.string().min(1).max(32_768),
      description: z.string().min(1).max(500),
      workdir: z.string().min(1).max(4_096).optional(),
      timeout_ms: z.number().int().min(1).max(runtime.options.terminalTimeoutMs).optional(),
    }),
    outputSchema: z.strictObject({
      exit_code: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      truncated: z.boolean(),
    }),
    metadata: { category: 'process', mutates: true, risk: 'high' },
    guard: ({ input }) => ({
      decision: 'ask',
      title: '执行终端命令',
      reason: input.description,
      details: { command: input.command, workdir: input.workdir ?? '.' },
    }),
    execution: { timeoutMs: runtime.options.terminalTimeoutMs },
    async execute(input, context) {
      const target = await runtime.resolve(input.workdir ?? '.')
      let info
      try {
        info = await stat(target.absolutePath)
      }
      catch (error) {
        throw fileSystemError('inspect', target.relativePath, error)
      }
      if (!info.isDirectory())
        throw new ToolError({ code: 'FS_NOT_DIRECTORY', message: `终端 workdir“${target.relativePath}”不是目录` })
      return await runCommand(
        input.command,
        target.absolutePath,
        input.timeout_ms ?? runtime.options.terminalTimeoutMs,
        runtime.options.terminalMaxOutputBytes,
        context.signal,
      )
    },
    renderOutput(value) {
      return [
        `exit_code: ${value.exit_code ?? 'signal'}`,
        value.stdout ? `stdout:\n${value.stdout}` : '',
        value.stderr ? `stderr:\n${value.stderr}` : '',
        value.truncated ? '[output truncated; tail retained]' : '',
      ].filter(Boolean).join('\n')
    },
  })
}

async function runCommand(command: string, cwd: string, timeoutMs: number, maxBytes: number, signal: AbortSignal) {
  return await new Promise<{ exit_code: number | null, stdout: string, stderr: string, truncated: boolean }>((resolve, reject) => {
    const shell = process.platform === 'win32'
      ? { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
      : { executable: '/bin/sh', args: ['-lc', command] }
    const child = spawn(shell.executable, shell.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0)
    let truncated = false
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const onAbort = () => child.kill()
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      const next = appendTail(stdout, chunk, maxBytes)
      stdout = next.value
      truncated ||= next.truncated
    })
    child.stderr.on('data', (chunk: Buffer) => {
      const next = appendTail(stderr, chunk, maxBytes)
      stderr = next.value
      truncated ||= next.truncated
    })
    child.once('error', (error) => {
      if (settled)
        return
      settled = true
      cleanup()
      reject(new ToolError({ code: 'TERMINAL_START_FAILED', message: '无法启动系统 shell', cause: error }))
    })
    child.once('close', (code) => {
      if (settled)
        return
      settled = true
      cleanup()
      if (timedOut) {
        reject(new ToolError({ code: 'TERMINAL_TIMEOUT', message: `命令在 ${timeoutMs}ms 内未完成`, retryable: true }))
        return
      }
      if (signal.aborted) {
        reject(new ToolError({ code: 'ABORTED', message: '终端命令已取消' }))
        return
      }
      resolve({ exit_code: code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), truncated })
    })
    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  })
}

function appendTail(current: Buffer<ArrayBufferLike>, chunk: Buffer, maxBytes: number) {
  const combined = Buffer.concat([current, chunk])
  if (combined.length <= maxBytes)
    return { value: combined, truncated: false }
  return { value: combined.subarray(combined.length - maxBytes), truncated: true }
}
