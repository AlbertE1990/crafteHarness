// @vitest-environment node

import type { AgentEvent } from 'craft-harness'
import type { MySqlConnection, MySqlPool } from '../src/server/database/mysql'
import { describe, expect, it, vi } from 'vitest'
import { MySqlTrajectoryStore } from '../src/server/stores/mysql-trajectory-store'

function event(
  value: Partial<AgentEvent> & Pick<AgentEvent, 'type'>,
): AgentEvent {
  return {
    runId: 'run-trace',
    turnId: 'turn-trace',
    sessionId: 'session-trace',
    timestamp: '2026-09-13T04:00:00.000Z',
    ...value,
  } as AgentEvent
}

describe('mysql trajectory store', () => {
  it('flushes a terminal run in one transaction and keeps only the first chunk per step', async () => {
    const clientQuery = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }))
    const client = {
      query: clientQuery,
      release: vi.fn(),
    } as unknown as MySqlConnection
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as MySqlPool
    const store = new MySqlTrajectoryStore(pool)

    await store.bindSession('scope-trace', 'session-trace')
    await store.record(event({
      type: 'agent.run.started',
      provider: 'scripted',
      model: 'scripted-model',
      modelExecution: { id: 'scripted-model', stream: true },
      limits: { maxModelSteps: 5, maxToolCalls: 16 },
    }))
    await store.record(event({
      type: 'agent.model.chunk',
      step: 1,
      chunk: {
        id: 'chunk-1',
        choices: [{ index: 0, finish_reason: null, delta: { content: '首' } }],
        created: 1,
        model: 'scripted-model',
        object: 'chat.completion.chunk',
      },
    }))
    await store.record(event({
      type: 'agent.model.chunk',
      step: 1,
      chunk: {
        id: 'chunk-2',
        choices: [{ index: 0, finish_reason: null, delta: { content: '后续' } }],
        created: 1,
        model: 'scripted-model',
        object: 'chat.completion.chunk',
      },
    }))
    await store.record(event({
      type: 'agent.run.completed',
      result: {
        status: 'completed',
        stopReason: 'completed',
        runId: 'run-trace',
        turnId: 'turn-trace',
        sessionId: 'session-trace',
        content: '完成',
        reasoning: '',
        steps: 1,
        toolCalls: 0,
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        sessionVersion: 3,
      },
    }))

    const inserts = clientQuery.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO craft_agent_trace_events'))
    expect(inserts).toHaveLength(3)
    expect(inserts.map(([, parameters]) => (parameters as unknown[])[4])).toEqual([
      'agent.run.started',
      'agent.model.chunk',
      'agent.run.completed',
    ])
    expect(clientQuery.mock.calls[0]?.[0]).toBe('BEGIN')
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('buffers an unbound non-stream run until the HTTP layer supplies its scope', async () => {
    const clientQuery = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] }))
    const client = {
      query: clientQuery,
      release: vi.fn(),
    } as unknown as MySqlConnection
    const pool = {
      connect: vi.fn(async () => client),
    } as unknown as MySqlPool
    const store = new MySqlTrajectoryStore(pool)

    await store.record(event({
      type: 'agent.run.failed',
      result: {
        status: 'failed',
        stopReason: 'model_error',
        runId: 'run-trace',
        turnId: 'turn-trace',
        sessionId: 'session-trace',
        content: '',
        reasoning: '',
        steps: 1,
        toolCalls: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        sessionVersion: 2,
        error: { code: 'MODEL_ERROR', message: '失败' },
      },
    }))
    expect(pool.connect).not.toHaveBeenCalled()

    await store.bindSession('scope-trace', 'session-trace')
    expect(pool.connect).toHaveBeenCalledOnce()
    const insert = clientQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO craft_agent_trace_events'))
    expect((insert?.[1] as unknown[])[0]).toBe('scope-trace')
  })
})
