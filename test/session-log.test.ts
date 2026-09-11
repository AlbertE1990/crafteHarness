import type {
  SessionEvent,
  SessionStore,
} from '../src'
import { describe, expect, it } from 'vitest'
import {
  deriveModelMessages,
  loadModelMessages,
  MemorySessionStore,
  readSessionSnapshot,
} from '../src'

const SCOPE_ID = 'scope-session-log'

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
      scopeId: SCOPE_ID,
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

    const messages = await loadModelMessages({ scopeId: SCOPE_ID, sessionId: 'session-1' }, store)
    expect(messages).toEqual([
      { role: 'system', content: '系统指令' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好，有什么可以帮你？' },
    ])
  })

  it('rejects stale expectedVersion without partially writing the batch', async () => {
    const store = createStore()
    await store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-conflict',
      expectedVersion: 0,
      events: [{ type: 'session.created' }],
    })

    await expect(store.append({
      scopeId: SCOPE_ID,
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

    const page = await store.read({ scopeId: SCOPE_ID, sessionId: 'session-conflict' })
    expect(page.latestVersion).toBe(1)
    expect(page.events).toHaveLength(1)
  })

  it('requires one session.created event at sequence one', async () => {
    const store = createStore()

    await expect(store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-invalid-start',
      expectedVersion: 0,
      events: [{
        type: 'message.appended',
        message: { role: 'user', content: '缺少创建事件' },
      }],
    })).rejects.toMatchObject({ code: 'SESSION_INVALID_EVENT_SEQUENCE' })

    await expect(store.append({
      scopeId: SCOPE_ID,
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
      scopeId: SCOPE_ID,
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
    expect(Object.isFrozen((result.events[0] as { metadata?: unknown })?.metadata)).toBe(true)
  })

  it('rejects non-serializable event data and leaves the Session empty', async () => {
    const store = createStore()
    const metadata: Record<string, unknown> = {}
    metadata.self = metadata

    await expect(store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-circular',
      expectedVersion: 0,
      events: [{
        type: 'session.created',
        metadata: metadata as never,
      }],
    })).rejects.toMatchObject({ code: 'SESSION_SERIALIZATION_FAILED' })

    const page = await store.read({ scopeId: SCOPE_ID, sessionId: 'session-circular' })
    expect(page.latestVersion).toBe(0)
    expect(page.events).toEqual([])
  })

  it('keeps a stable snapshot while later events are appended between pages', async () => {
    const store = createStore()
    await store.append({
      scopeId: SCOPE_ID,
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
      async read(request) {
        const page = await store.read(request)
        if (firstRead) {
          firstRead = false
          await store.append({
            scopeId: request.scopeId,
            sessionId: request.sessionId,
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

    const snapshot = await readSessionSnapshot({ scopeId: SCOPE_ID, sessionId: 'session-pages' }, interleavedStore, {
      pageSize: 2,
    })

    expect(snapshot.version).toBe(4)
    expect(snapshot.events).toHaveLength(4)
    expect((await store.read({ scopeId: SCOPE_ID, sessionId: 'session-pages' })).latestVersion).toBe(5)
  })

  it('rejects duplicate event IDs without committing either event in the batch', async () => {
    const store = new MemorySessionStore({
      createEventId: () => 'same-event-id',
      now: () => new Date('2026-09-08T01:00:00.000Z'),
    })

    await expect(store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-id-conflict',
      expectedVersion: 0,
      events: [
        { type: 'session.created' },
        { type: 'message.appended', message: { role: 'system', content: '系统' } },
      ],
    })).rejects.toMatchObject({ code: 'SESSION_EVENT_ID_CONFLICT' })

    expect((await store.read({ scopeId: SCOPE_ID, sessionId: 'session-id-conflict' })).latestVersion).toBe(0)
  })

  it('persists producer-provided eventId and occurrence timestamp', async () => {
    const store = createStore()
    const result = await store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-producer-identity',
      expectedVersion: 0,
      events: [
        {
          type: 'session.created',
          eventId: 'evt-created',
          timestamp: '2026-01-01T00:00:00.000Z',
        },
        {
          type: 'turn.started',
          turnId: 'turn-1',
          eventId: 'evt-turn-started',
          timestamp: '2026-01-01T00:00:05.500Z',
        },
      ],
    })

    expect(result.events.map(event => event.eventId)).toEqual(['evt-created', 'evt-turn-started'])
    expect(result.events.map(event => event.timestamp)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:05.500Z',
    ])
  })

  it('falls back to store-generated eventId and acceptance time when omitted', async () => {
    const store = createStore()
    const result = await store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-fallback',
      expectedVersion: 0,
      events: [{ type: 'session.created' }],
    })

    expect(result.events[0]?.eventId).toBe('event-1')
    expect(result.events[0]?.timestamp).toBe('2026-09-08T01:00:00.000Z')
  })

  it('rejects invalid producer eventId and timestamp without writing', async () => {
    const store = createStore()

    await expect(store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-bad-event-id',
      expectedVersion: 0,
      events: [{ type: 'session.created', eventId: '   ' }],
    })).rejects.toMatchObject({ code: 'SESSION_INVALID_ARGUMENT' })
    expect((await store.read({ scopeId: SCOPE_ID, sessionId: 'session-bad-event-id' })).latestVersion).toBe(0)

    await expect(store.append({
      scopeId: SCOPE_ID,
      sessionId: 'session-bad-timestamp',
      expectedVersion: 0,
      events: [{ type: 'session.created', timestamp: 'not-a-time' }],
    })).rejects.toMatchObject({ code: 'SESSION_INVALID_ARGUMENT' })
    expect((await store.read({ scopeId: SCOPE_ID, sessionId: 'session-bad-timestamp' })).latestVersion).toBe(0)
  })
})

describe('deriveModelMessages', () => {
  it('rejects mixed or discontinuous event histories instead of reordering them', () => {
    const events: SessionEvent[] = [
      {
        type: 'session.created',
        eventId: 'event-1',
        scopeId: SCOPE_ID,
        sessionId: 'session-a',
        sequence: 1,
        timestamp: '2026-09-08T01:00:00.000Z',
      },
      {
        type: 'message.appended',
        eventId: 'event-2',
        scopeId: SCOPE_ID,
        sessionId: 'session-b',
        sequence: 3,
        timestamp: '2026-09-08T01:00:01.000Z',
        message: { role: 'user', content: '坏序列' },
      },
    ]

    expect(() => deriveModelMessages(events)).toThrow('sequence 连续')
  })
})
