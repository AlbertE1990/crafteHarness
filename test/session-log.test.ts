import type {
  SessionEvent,
  SessionStore,
} from '../src/common-agent'
import { describe, expect, it } from 'vitest'
import {
  deriveModelMessages,
  loadModelMessages,
  MemorySessionStore,
  readSessionSnapshot,
} from '../src/common-agent'

/** 创建 ID 和时间稳定的内存 Store，避免测试依赖真实时钟与 UUID。 */
function createStore() {
  let eventNumber = 0
  return new MemorySessionStore({
    createEventId: () => `event-${++eventNumber}`,
    now: () => new Date('2026-09-08T01:00:00.000Z'),
  })
}

describe('memorySessionStore', () => {
  it('appends facts atomically and derives only model-visible messages', async () => {
    const store = createStore()
    const result = await store.append({
      sessionId: 'session-1',
      expectedVersion: 0,
      events: [
        { type: 'session.created', metadata: { source: 'test' } },
        { type: 'message.appended', message: { role: 'system', content: '系统指令' } },
        { type: 'turn.started', runId: 'run-1', turnId: 'turn-1' },
        {
          type: 'message.appended',
          runId: 'run-1',
          turnId: 'turn-1',
          message: { role: 'user', content: '你好' },
        },
        {
          type: 'message.appended',
          runId: 'run-1',
          turnId: 'turn-1',
          message: { role: 'assistant', content: '你好，有什么可以帮你？' },
        },
        { type: 'turn.completed', runId: 'run-1', turnId: 'turn-1' },
      ],
    })

    expect(result).toMatchObject({
      previousVersion: 0,
      version: 6,
    })
    expect(result.events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.events.every(event => event.timestamp === '2026-09-08T01:00:00.000Z'))
      .toBe(true)

    const messages = await loadModelMessages('session-1', store)
    expect(messages).toEqual([
      { role: 'system', content: '系统指令' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ])
  })

  it('rejects stale expectedVersion without partially writing the batch', async () => {
    const store = createStore()
    await store.append({
      sessionId: 'session-conflict',
      expectedVersion: 0,
      events: [{ type: 'session.created' }],
    })

    await expect(store.append({
      sessionId: 'session-conflict',
      expectedVersion: 0,
      events: [{
        type: 'message.appended',
        message: { role: 'user', content: '不应写入' },
      }],
    })).rejects.toMatchObject({
      code: 'SESSION_VERSION_CONFLICT',
      expectedVersion: 0,
      actualVersion: 1,
    })

    const page = await store.read('session-conflict')
    expect(page.latestVersion).toBe(1)
    expect(page.events).toHaveLength(1)
  })

  it('requires one session.created event at sequence one', async () => {
    const store = createStore()

    await expect(store.append({
      sessionId: 'session-invalid-start',
      expectedVersion: 0,
      events: [{
        type: 'message.appended',
        message: { role: 'user', content: '缺少创建事件' },
      }],
    })).rejects.toMatchObject({ code: 'SESSION_INVALID_EVENT_SEQUENCE' })

    await expect(store.append({
      sessionId: 'session-duplicate-create',
      expectedVersion: 0,
      events: [
        { type: 'session.created' },
        { type: 'session.created' },
      ],
    })).rejects.toMatchObject({ code: 'SESSION_INVALID_EVENT_SEQUENCE' })
  })

  it('copies and freezes appended facts so callers cannot rewrite history', async () => {
    const store = createStore()
    const metadata = { owner: 'before' }
    const result = await store.append({
      sessionId: 'session-immutable',
      expectedVersion: 0,
      events: [{ type: 'session.created', metadata }],
    })
    metadata.owner = 'after'

    expect(result.events[0]).toMatchObject({
      type: 'session.created',
      metadata: { owner: 'before' },
    })
    expect(Object.isFrozen(result.events[0])).toBe(true)
    expect(Object.isFrozen(result.events[0]?.metadata)).toBe(true)
  })

  it('rejects non-serializable event data and leaves the Session empty', async () => {
    const store = createStore()
    const metadata: Record<string, unknown> = {}
    metadata.self = metadata

    await expect(store.append({
      sessionId: 'session-circular',
      expectedVersion: 0,
      events: [{
        type: 'session.created',
        metadata: metadata as never,
      }],
    })).rejects.toMatchObject({ code: 'SESSION_SERIALIZATION_FAILED' })

    const page = await store.read('session-circular')
    expect(page.latestVersion).toBe(0)
    expect(page.events).toEqual([])
  })

  it('keeps a stable snapshot while later events are appended between pages', async () => {
    const store = createStore()
    await store.append({
      sessionId: 'session-pages',
      expectedVersion: 0,
      events: [
        { type: 'session.created' },
        { type: 'message.appended', message: { role: 'system', content: '系统' } },
        { type: 'turn.started', turnId: 'turn-1' },
        { type: 'message.appended', turnId: 'turn-1', message: { role: 'user', content: '第一轮' } },
      ],
    })

    let firstRead = true
    const interleavedStore: SessionStore = {
      append: request => store.append(request),
      async read(sessionId, options) {
        const page = await store.read(sessionId, options)
        if (firstRead) {
          firstRead = false
          await store.append({
            sessionId,
            expectedVersion: 4,
            events: [{
              type: 'message.appended',
              turnId: 'turn-1',
              message: { role: 'assistant', content: '稍后追加' },
            }],
          })
        }
        return page
      },
    }

    const snapshot = await readSessionSnapshot('session-pages', interleavedStore, {
      pageSize: 2,
    })

    expect(snapshot.version).toBe(4)
    expect(snapshot.events).toHaveLength(4)
    expect((await store.read('session-pages')).latestVersion).toBe(5)
  })

  it('rejects duplicate event IDs without committing either event in the batch', async () => {
    const store = new MemorySessionStore({
      createEventId: () => 'same-event-id',
      now: () => new Date('2026-09-08T01:00:00.000Z'),
    })

    await expect(store.append({
      sessionId: 'session-id-conflict',
      expectedVersion: 0,
      events: [
        { type: 'session.created' },
        { type: 'message.appended', message: { role: 'system', content: '系统' } },
      ],
    })).rejects.toMatchObject({ code: 'SESSION_EVENT_ID_CONFLICT' })

    expect((await store.read('session-id-conflict')).latestVersion).toBe(0)
  })
})

describe('deriveModelMessages', () => {
  it('rejects mixed or discontinuous event histories instead of reordering them', () => {
    const events: SessionEvent[] = [
      {
        type: 'session.created',
        eventId: 'event-1',
        sessionId: 'session-a',
        sequence: 1,
        timestamp: '2026-09-08T01:00:00.000Z',
      },
      {
        type: 'message.appended',
        eventId: 'event-2',
        sessionId: 'session-b',
        sequence: 3,
        timestamp: '2026-09-08T01:00:01.000Z',
        message: { role: 'user', content: '坏序列' },
      },
    ]

    expect(() => deriveModelMessages(events)).toThrow('sequence 连续')
  })
})
