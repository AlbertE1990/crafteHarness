import type { ToolApprovalRequest } from '../src/craft-agent'
import { describe, expect, it, vi } from 'vitest'
import { ToolApprovalBroker } from '../src/server/tool-approval-broker'

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
    signal,
  }
}

describe('tool approval broker', () => {
  it('routes a one-time user approval back to the waiting Harness call', async () => {
    const events: unknown[] = []
    const broker = new ToolApprovalBroker({ createApprovalId: () => 'approval-1' })
    broker.observeRun('run-approval', event => events.push(event))

    const outcomePromise = broker.requestApproval(
      createApprovalRequest(new AbortController().signal),
    )
    await vi.waitFor(() => expect(broker.hasPending('approval-1')).toBe(true))

    expect(broker.decide('approval-1', 'approve')).toBe(true)
    await expect(outcomePromise).resolves.toBe('allowed-once')
    expect(broker.decide('approval-1', 'reject')).toBe(false)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'tool.approval.requested',
        approvalId: 'approval-1',
        toolName: 'manage_runtime_resource',
      }),
      expect.objectContaining({
        type: 'tool.approval.decided',
        approvalId: 'approval-1',
        outcome: 'allowed-once',
      }),
    ])
  })

  it('fails closed when the Run is aborted while awaiting a decision', async () => {
    const events: unknown[] = []
    const controller = new AbortController()
    const broker = new ToolApprovalBroker({ createApprovalId: () => 'approval-abort' })
    broker.observeRun('run-approval', event => events.push(event))

    const outcomePromise = broker.requestApproval(createApprovalRequest(controller.signal))
    await vi.waitFor(() => expect(broker.hasPending('approval-abort')).toBe(true))
    controller.abort()

    await expect(outcomePromise).resolves.toBe('aborted')
    expect(broker.hasPending('approval-abort')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      type: 'tool.approval.decided',
      outcome: 'aborted',
    })
  })
})
