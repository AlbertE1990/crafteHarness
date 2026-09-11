// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkspaceTools, executeTool } from '../src'

describe('workspace built-in tools', () => {
  let workspaceRoot: string

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(path.join(tmpdir(), 'craft-harness-workspace-'))
    await mkdir(path.join(workspaceRoot, 'src'))
    await writeFile(path.join(workspaceRoot, 'src', 'sample.ts'), 'alpha\nbeta alpha\ngamma\n', 'utf8')
  })

  afterEach(async () => {
    if (path.basename(path.resolve(workspaceRoot)).startsWith('craft-harness-workspace-'))
      await rm(workspaceRoot, { recursive: true, force: true })
  })

  it('reads pages and blocks paths outside the workspace', async () => {
    const [read] = createWorkspaceTools({ workspaceRoot })
    const result = await executeTool(read, {
      file_path: 'src/sample.ts',
      offset: 2,
      limit: 1,
    }, { callId: 'read-page' })
    expect(result).toMatchObject({
      ok: true,
      value: {
        file_path: 'src/sample.ts',
        lines: [{ number: 2, text: 'beta alpha' }],
        truncated: true,
      },
    })
    const denied = await executeTool(read, { file_path: '../outside.txt' }, { callId: 'read-outside' })
    expect(denied).toMatchObject({ ok: false, error: { code: 'FS_PATH_OUTSIDE_WORKSPACE' } })
  })

  it('requires approval and a fresh read before overwrite', async () => {
    const [read, write] = createWorkspaceTools({ workspaceRoot })
    const blocked = await executeTool(write, {
      file_path: 'src/sample.ts',
      content: 'replacement',
    }, { callId: 'write-blocked' })
    expect(blocked).toMatchObject({ ok: false, attempts: 0, error: { code: 'TOOL_PERMISSION_DENIED' } })

    const unread = await executeTool(write, {
      file_path: 'src/sample.ts',
      content: 'replacement',
    }, approved('write-unread'))
    expect(unread).toMatchObject({ ok: false, error: { code: 'FS_NOT_OBSERVED' } })

    await executeTool(read, { file_path: 'src/sample.ts' }, { callId: 'read-first' })
    const written = await executeTool(write, {
      file_path: 'src/sample.ts',
      content: 'replacement',
    }, approved('write-fresh'))
    expect(written).toMatchObject({ ok: true, value: { created: false, bytes: 11 } })
  })

  it('rejects stale writes and ambiguous edits', async () => {
    const [read, write, edit] = createWorkspaceTools({ workspaceRoot })
    await executeTool(read, { file_path: 'src/sample.ts' }, { callId: 'read-stale' })
    await writeFile(path.join(workspaceRoot, 'src', 'sample.ts'), 'external change', 'utf8')
    const stale = await executeTool(write, {
      file_path: 'src/sample.ts',
      content: 'agent change',
    }, approved('write-stale'))
    expect(stale).toMatchObject({ ok: false, error: { code: 'FS_STALE_VERSION' } })

    await writeFile(path.join(workspaceRoot, 'src', 'new.txt'), 'one two two', 'utf8')
    await executeTool(read, { file_path: 'src/new.txt' }, { callId: 'read-edit' })
    const ambiguous = await executeTool(edit, {
      file_path: 'src/new.txt',
      old_string: 'two',
      new_string: 'three',
    }, approved('edit-ambiguous'))
    expect(ambiguous).toMatchObject({ ok: false, error: { code: 'FS_EDIT_AMBIGUOUS' } })
  })

  it('searches files and content with bundled ripgrep', async () => {
    const [, , , glob, grep] = createWorkspaceTools({ workspaceRoot })
    const files = await executeTool(glob, { pattern: '**/*.ts' }, { callId: 'glob' })
    expect(files).toMatchObject({ ok: true, value: { paths: ['src/sample.ts'], truncated: false } })
    const matches = await executeTool(grep, { pattern: 'alpha', include: '*.ts' }, { callId: 'grep' })
    expect(matches).toMatchObject({
      ok: true,
      value: {
        matches: [
          { file_path: 'src/sample.ts', line_number: 1, text: 'alpha' },
          { file_path: 'src/sample.ts', line_number: 2, text: 'beta alpha' },
        ],
      },
    })
  })

  it('runs a one-shot terminal only after approval', async () => {
    const terminal = createWorkspaceTools({ workspaceRoot }).at(-1)!
    const blocked = await executeTool(terminal, {
      command: 'node --version',
      description: '检查 Node.js 版本',
    }, { callId: 'terminal-blocked' })
    expect(blocked).toMatchObject({ ok: false, attempts: 0 })
    const result = await executeTool(terminal, {
      command: 'node --version',
      description: '检查 Node.js 版本',
    }, approved('terminal-approved'))
    expect(result).toMatchObject({ ok: true, value: { exit_code: 0, truncated: false } })
    expect(result.ok && result.value.stdout).toMatch(/^v\d+/)
  })
})

function approved(callId: string) {
  return { callId, requestApproval: () => 'allowed-once' as const }
}
