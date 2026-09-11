import type { WorkspaceToolsOptions } from './workspace'
import { createFilesystemTools } from './filesystem-tools'
import { createSearchTools } from './search-tools'
import { createTerminalTool } from './terminal'
import { WorkspaceRuntime } from './workspace'

/** 创建共享 workspace 边界、读版本和写锁的六个通用工具。 */
export function createWorkspaceTools(options: WorkspaceToolsOptions = {}) {
  const runtime = new WorkspaceRuntime(options)
  return Object.freeze([
    ...createFilesystemTools(runtime),
    ...createSearchTools(runtime),
    createTerminalTool(runtime),
  ] as const)
}

export type { WorkspaceToolsOptions } from './workspace'
