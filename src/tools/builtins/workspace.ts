import type { Stats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { ToolError } from '../errors'

/** 创建工作区工具时可调整的路径与资源上限。 */
export interface WorkspaceToolsOptions {
  /** 所有文件路径和终端 workdir 的根目录，默认创建工具时的 process.cwd()。 */
  readonly workspaceRoot?: string
  readonly readLimit?: number
  readonly readMaxBytes?: number
  readonly readMaxLineLength?: number
  readonly maxFileBytes?: number
  readonly writeMaxBytes?: number
  readonly globLimit?: number
  readonly grepLimit?: number
  readonly searchTimeoutMs?: number
  readonly terminalTimeoutMs?: number
  readonly terminalMaxOutputBytes?: number
}

/** 经过校验并补齐默认值的内部配置。 */
export interface DefinedWorkspaceToolsOptions {
  readonly workspaceRoot: string
  readonly readLimit: number
  readonly readMaxBytes: number
  readonly readMaxLineLength: number
  readonly maxFileBytes: number
  readonly writeMaxBytes: number
  readonly globLimit: number
  readonly grepLimit: number
  readonly searchTimeoutMs: number
  readonly terminalTimeoutMs: number
  readonly terminalMaxOutputBytes: number
}

/** 已解析且确认位于 workspace 内的目标路径。 */
export interface WorkspaceTarget {
  readonly absolutePath: string
  readonly relativePath: string
}

/** 同一工具套件共享路径边界、文件观察版本和进程内写锁。 */
export class WorkspaceRuntime {
  readonly options: DefinedWorkspaceToolsOptions

  private readonly observations = new Map<string, string>()
  private readonly locks = new Map<string, Promise<void>>()
  private rootRealPath?: Promise<string>

  constructor(options: WorkspaceToolsOptions = {}) {
    this.options = defineOptions(options)
  }

  /** 同时阻止 `..` 和符号链接逃出真实工作区。 */
  async resolve(inputPath: string): Promise<WorkspaceTarget> {
    const root = this.options.workspaceRoot
    const candidate = path.resolve(root, inputPath)
    if (!isWithin(root, candidate))
      throw pathDenied(inputPath)

    this.rootRealPath ??= resolveWorkspaceRoot(this.options.workspaceRoot)
    const rootRealPath = await this.rootRealPath
    let actualPath: string
    try {
      actualPath = await resolveThroughExistingAncestor(candidate)
    }
    catch (error) {
      throw fileSystemError('inspect', portable(path.relative(root, candidate)), error)
    }
    if (!isWithin(rootRealPath, actualPath))
      throw pathDenied(inputPath)

    return Object.freeze({
      absolutePath: actualPath,
      relativePath: portable(path.relative(rootRealPath, actualPath) || '.'),
    })
  }

  /** 记录成功读取后的文件版本。 */
  observe(target: WorkspaceTarget, fileStat: Stats): void {
    this.observations.set(target.absolutePath, fileVersion(fileStat))
  }

  /** 覆盖与编辑前必须已经读过同一版本。 */
  requireFreshObservation(target: WorkspaceTarget, fileStat: Stats): void {
    const observed = this.observations.get(target.absolutePath)
    if (observed === undefined) {
      throw new ToolError({
        code: 'FS_NOT_OBSERVED',
        message: `不能修改“${target.relativePath}”：尚未读取该文件，请先调用 read`,
      })
    }
    if (observed !== fileVersion(fileStat)) {
      throw new ToolError({
        code: 'FS_STALE_VERSION',
        message: `不能修改“${target.relativePath}”：文件在读取后已变化，请重新调用 read`,
      })
    }
  }

  /** 对同一路径串行执行本进程内的修改。 */
  async withPathLock<T>(target: WorkspaceTarget, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(target.absolutePath) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.locks.set(target.absolutePath, current)
    await previous
    try {
      return await operation()
    }
    finally {
      release()
      if (this.locks.get(target.absolutePath) === current)
        this.locks.delete(target.absolutePath)
    }
  }
}

/** 读取受限的 UTF-8 普通文件，并拒绝读中变化。 */
export async function readWorkspaceText(runtime: WorkspaceRuntime, target: WorkspaceTarget) {
  let before: Stats
  try {
    before = await stat(target.absolutePath)
  }
  catch (error) {
    throw fileSystemError('read', target.relativePath, error)
  }
  if (!before.isFile())
    throw new ToolError({ code: 'FS_NOT_FILE', message: `不能读取“${target.relativePath}”：目标不是普通文件` })
  if (before.size > runtime.options.maxFileBytes) {
    throw new ToolError({
      code: 'FS_FILE_TOO_LARGE',
      message: `不能读取“${target.relativePath}”：文件超过 ${runtime.options.maxFileBytes} 字节上限`,
    })
  }

  try {
    const bytes = await readFile(target.absolutePath)
    const after = await stat(target.absolutePath)
    if (fileVersion(before) !== fileVersion(after)) {
      throw new ToolError({
        code: 'FS_CHANGED_DURING_READ',
        message: `不能读取“${target.relativePath}”：文件在读取过程中发生变化，请重试`,
        retryable: true,
      })
    }
    try {
      return {
        content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
        stat: after,
      }
    }
    catch (error) {
      throw new ToolError({ code: 'FS_NOT_UTF8', message: `不能读取“${target.relativePath}”：文件不是有效 UTF-8 文本`, cause: error })
    }
  }
  catch (error) {
    if (error instanceof ToolError)
      throw error
    throw fileSystemError('read', target.relativePath, error)
  }
}

/** 同目录临时写入后原子发布；创建模式拒绝覆盖竞争。 */
export async function writeWorkspaceTextAtomically(
  target: WorkspaceTarget,
  content: string,
  replaceExisting: boolean,
): Promise<Stats> {
  const temporaryPath = path.join(path.dirname(target.absolutePath), `.craft-harness-${randomUUID()}.tmp`)
  let temporaryExists = false
  try {
    const handle = await open(temporaryPath, 'wx', 0o600)
    temporaryExists = true
    try {
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    }
    finally {
      await handle.close()
    }
    if (replaceExisting) {
      await rename(temporaryPath, target.absolutePath)
      temporaryExists = false
    }
    else {
      await link(temporaryPath, target.absolutePath)
      await unlink(temporaryPath)
      temporaryExists = false
    }
    return await stat(target.absolutePath)
  }
  catch (error) {
    throw fileSystemError('write', target.relativePath, error)
  }
  finally {
    if (temporaryExists)
      await unlink(temporaryPath).catch(() => undefined)
  }
}

/** 判断路径是否存在，不把权限错误误认为不存在。 */
export async function pathExists(target: WorkspaceTarget): Promise<boolean> {
  try {
    await lstat(target.absolutePath)
    return true
  }
  catch (error) {
    if (hasErrorCode(error, 'ENOENT'))
      return false
    throw fileSystemError('inspect', target.relativePath, error)
  }
}

/** 把文件系统异常转换成不泄漏主机绝对路径的稳定错误。 */
export function fileSystemError(operation: 'inspect' | 'read' | 'write', relativePath: string, error: unknown) {
  if (error instanceof ToolError)
    return error
  const code = getErrorCode(error)
  const verb = operation === 'inspect' ? '检查' : operation === 'read' ? '读取' : '写入'
  if (code === 'ENOENT')
    return new ToolError({ code: 'FS_NOT_FOUND', message: `无法${verb}“${relativePath}”：目标不存在`, cause: error })
  if (code === 'EACCES' || code === 'EPERM')
    return new ToolError({ code: 'FS_PERMISSION_DENIED', message: `无法${verb}“${relativePath}”：操作系统拒绝访问`, cause: error })
  if (code === 'EEXIST')
    return new ToolError({ code: 'FS_STALE_VERSION', message: `无法写入“${relativePath}”：目标已被其他操作创建`, cause: error })
  return new ToolError({ code: 'FS_IO_ERROR', message: `无法${verb}“${relativePath}”`, cause: error })
}

function defineOptions(options: WorkspaceToolsOptions): DefinedWorkspaceToolsOptions {
  if (options.workspaceRoot !== undefined && !options.workspaceRoot.trim())
    throw new TypeError('Workspace tools workspaceRoot 必须是非空字符串')
  return Object.freeze({
    workspaceRoot: path.resolve(options.workspaceRoot ?? process.cwd()),
    readLimit: positive(options.readLimit, 2_000, 'readLimit'),
    readMaxBytes: positive(options.readMaxBytes, 50 * 1024, 'readMaxBytes'),
    readMaxLineLength: positive(options.readMaxLineLength, 2_000, 'readMaxLineLength'),
    maxFileBytes: positive(options.maxFileBytes, 10 * 1024 * 1024, 'maxFileBytes'),
    writeMaxBytes: positive(options.writeMaxBytes, 2 * 1024 * 1024, 'writeMaxBytes'),
    globLimit: positive(options.globLimit, 100, 'globLimit'),
    grepLimit: positive(options.grepLimit, 250, 'grepLimit'),
    searchTimeoutMs: timer(options.searchTimeoutMs, 30_000, 'searchTimeoutMs'),
    terminalTimeoutMs: timer(options.terminalTimeoutMs, 120_000, 'terminalTimeoutMs'),
    terminalMaxOutputBytes: positive(options.terminalMaxOutputBytes, 64 * 1024, 'terminalMaxOutputBytes'),
  })
}

async function resolveWorkspaceRoot(root: string): Promise<string> {
  try {
    await access(root, constants.R_OK)
    const info = await stat(root)
    if (!info.isDirectory())
      throw new ToolError({ code: 'FS_NOT_DIRECTORY', message: 'workspaceRoot 不是目录' })
    return await realpath(root)
  }
  catch (error) {
    if (error instanceof ToolError)
      throw error
    throw new ToolError({ code: 'FS_WORKSPACE_UNAVAILABLE', message: 'workspaceRoot 不可访问', cause: error })
  }
}

async function resolveThroughExistingAncestor(candidate: string): Promise<string> {
  let ancestor = candidate
  while (true) {
    try {
      const realAncestor = await realpath(ancestor)
      return path.resolve(realAncestor, path.relative(ancestor, candidate))
    }
    catch (error) {
      if (!hasErrorCode(error, 'ENOENT'))
        throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor)
        throw error
      ancestor = parent
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function fileVersion(value: Stats): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
}

function pathDenied(inputPath: string) {
  return new ToolError({ code: 'FS_PATH_OUTSIDE_WORKSPACE', message: `路径“${inputPath}”超出允许的 workspace` })
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { readonly code?: unknown }).code === code
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined
}

function positive(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1)
    throw new RangeError(`Workspace tools ${field} 必须是正安全整数`)
  return resolved
}

function timer(value: number | undefined, fallback: number, field: string): number {
  const resolved = positive(value, fallback, field)
  if (resolved > 2_147_483_647)
    throw new RangeError(`Workspace tools ${field} 不能超过 2147483647`)
  return resolved
}

function portable(value: string): string {
  return value.split(path.sep).join('/')
}
