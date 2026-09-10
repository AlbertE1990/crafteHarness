import type { ToolApprovalRequest } from '../src/craft-agent'
import { describe, expect, it, vi } from 'vitest'
import { ToolApprovalManager } from '../src/craft-agent/agent/tool-approval-manager'

/** 构造一次由 Harness 发起、并可被测试主动取消的审批请求。 */
function createApprovalRequest(signal: AbortSignal): ToolApprovalRequest {
  return {
    callId: 'call-write',
    runId: 'run-approval',
    sessionId: 'session-approval',
    toolName: 'manage_runtime_resource',
    input: { operation: 'write', resource: 'demo/greeting', content: 'hello' },
    security: {
      risk: 'destructive',
      capabilities: ['runtime-resource:manage'],
      idempotent: false,
    },
    reason: '工具将写入进程内资源 demo/greeting',
    title: '确认写入资源',
    details: { operation: 'write', resource: 'demo/greeting' },
    approvalTimeoutMs: 45_000,
    signal,
  }
}

describe('agent tool approval manager', () => {
  it('routes one user decision to the waiting Harness call and rejects duplicates', async () => {
    const events: unknown[] = []
    const manager = new ToolApprovalManager({
      createApprovalId: () => 'approval-1',
      now: () => new Date('2026-09-10T02:00:00.000Z'),
    })
    manager.observeRun('run-approval', event => events.push(event))

    const outcomePromise = manager.requestApproval(
      createApprovalRequest(new AbortController().signal),
    )
    await vi.waitFor(() => expect(manager.hasPending('approval-1')).toBe(true))

    expect(manager.resolve({ approvalId: 'approval-1', decision: 'allow' }))
      .toEqual({ accepted: true })
    await expect(outcomePromise).resolves.toBe('allowed-once')
    expect(manager.resolve({ approvalId: 'approval-1', decision: 'deny' }))
      .toEqual({ accepted: false, reason: 'not-found-or-settled' })
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.approval.requested',
        approvalId: 'approval-1',
        approvalTimeoutMs: 45_000,
        requestedAt: '2026-09-10T02:00:00.000Z',
        expiresAt: '2026-09-10T02:00:45.000Z',
      }),
      expect.objectContaining({
        type: 'tool.approval.resolved',
        approvalId: 'approval-1',
        outcome: 'allowed',
      }),
    ])
  })

  it('fails closed when the Run is aborted while awaiting a decision', async () => {
    const events: unknown[] = []
    const controller = new AbortController()
    const manager = new ToolApprovalManager({ createApprovalId: () => 'approval-abort' })
    manager.observeRun('run-approval', event => events.push(event))

    const outcomePromise = manager.requestApproval(createApprovalRequest(controller.signal))
    await vi.waitFor(() => expect(manager.hasPending('approval-abort')).toBe(true))
    controller.abort()

    await expect(outcomePromise).resolves.toBe('aborted')
    expect(manager.hasPending('approval-abort')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'tool.approval.resolved',
      outcome: 'aborted',
    })
  })

  it('expires an unanswered approval using the current-call timeout', async () => {
    vi.useFakeTimers()
    try {
      const events: unknown[] = []
      const manager = new ToolApprovalManager({
        defaultTimeoutMs: 120_000,
        createApprovalId: () => 'approval-expired',
        now: () => new Date('2026-09-10T02:00:00.000Z'),
      })
      manager.observeRun('run-approval', event => events.push(event))

      const outcomePromise = manager.requestApproval(
        createApprovalRequest(new AbortController().signal),
      )
      await vi.advanceTimersByTimeAsync(45_000)

      await expect(outcomePromise).resolves.toBe('unavailable')
      expect(manager.hasPending('approval-expired')).toBe(false)
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'tool.approval.requested',
          approvalTimeoutMs: 45_000,
          expiresAt: '2026-09-10T02:00:45.000Z',
        }),
        expect.objectContaining({
          type: 'tool.approval.resolved',
          outcome: 'expired',
        }),
      ]))
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('fails closed instead of waiting when the approval request cannot be delivered', async () => {
    const manager = new ToolApprovalManager({
      createApprovalId: () => 'approval-undeliverable',
    })
    manager.observeRun('run-approval', () => {
      throw new Error('approval output is unavailable')
    })

    await expect(manager.requestApproval(
      createApprovalRequest(new AbortController().signal),
    )).resolves.toBe('unavailable')
    expect(manager.hasPending('approval-undeliverable')).toBe(false)
  })
})
