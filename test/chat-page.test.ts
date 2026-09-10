import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPage from '../src/pages/index.vue'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function streamResponse(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      controller.close()
    },
  })

  return {
    ok: true,
    status: 200,
    body,
  } as Response
}

/** 创建可由测试逐步推进的 SSE，用于观察 Agent 等待审批时尚未结束的页面状态。 */
function controlledStreamResponse(initialEvents: unknown[]) {
  const encoder = new TextEncoder()
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      for (const event of initialEvents)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
  })

  return {
    response: { ok: true, status: 200, body } as Response,
    /** 推送一个完整 SSE 事件帧。 */
    push(event: unknown) {
      streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
    /** 模拟 Agent Run 正常关闭 SSE。 */
    close() {
      streamController?.close()
    },
  }
}

describe('chat page conversations', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('restores history and only sends conversationId for an existing conversation', async () => {
    const existingConversation = {
      id: 'chat-existing',
      name: '已有会话',
      createAt: String(Date.now()),
    }
    const existingConversationDetail = {
      ...existingConversation,
      history: [
        { role: 'user', content: '历史问题' },
        {
          role: 'assistant',
          content: '历史**回答**\n\n<img src=x onerror=alert(1)>',
          reasoning_content: '历史思考过程',
        },
        { role: 'tool', content: '{"ignored":true}' },
      ],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [existingConversation] }))
      .mockResolvedValueOnce(jsonResponse({ data: existingConversationDetail }))
      .mockResolvedValueOnce(streamResponse([
        { type: 'session.started', sessionId: 'chat-existing' },
        { type: 'message.delta', sessionId: 'chat-existing', channel: 'reasoning', delta: '先分析已有上下文' },
        { type: 'message.delta', sessionId: 'chat-existing', channel: 'content', delta: '继续' },
        { type: 'message.delta', sessionId: 'chat-existing', channel: 'content', delta: '回答' },
        {
          type: 'message.completed',
          content: '继续回答',
          reasoning: '先分析已有上下文',
          sessionId: 'chat-existing',
        },
      ]))
      .mockResolvedValueOnce(jsonResponse({ data: [existingConversation] }))
      .mockResolvedValueOnce(streamResponse([
        { type: 'session.started', sessionId: 'chat-new' },
        { type: 'message.delta', sessionId: 'chat-new', channel: 'content', delta: '新会话' },
        { type: 'message.delta', sessionId: 'chat-new', channel: 'content', delta: '回答' },
        { type: 'message.completed', sessionId: 'chat-new', content: '新会话回答', reasoning: '' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ data: [existingConversation] }))

    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.text()).toContain('历史问题')
    expect(wrapper.text()).toContain('历史回答')
    expect(wrapper.get('.markdown-body strong').text()).toBe('回答')
    expect(wrapper.find('.markdown-body img').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('历史思考过程')
    expect(wrapper.text()).not.toContain('{"ignored":true}')

    await wrapper.get('.reasoning-toggle').trigger('click')
    expect(wrapper.text()).toContain('历史思考过程')

    await wrapper.get('textarea').setValue('继续提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const existingRequest = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(existingRequest).toEqual({
      message: '继续提问',
      conversationId: 'chat-existing',
      model: {
        stream: true,
        reasoning: { enabled: true, effort: 'high' },
      },
    })
    expect(wrapper.text()).toContain('继续回答')

    const reasoningToggles = wrapper.findAll('.reasoning-toggle')
    await reasoningToggles.at(-1)!.trigger('click')
    expect(wrapper.text()).toContain('先分析已有上下文')

    await wrapper.get('.new-chat-button').trigger('click')
    await wrapper.get('textarea').setValue('创建新对话')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const newRequest = JSON.parse(String(fetchMock.mock.calls[4][1]?.body))
    expect(newRequest).toEqual({
      message: '创建新对话',
      model: {
        stream: true,
        reasoning: { enabled: true, effort: 'high' },
      },
    })
    expect(wrapper.text()).toContain('新会话回答')
  })

  it('uses ordinary JSON instead of reading SSE when streaming is disabled', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse({
        data: {
          status: 'completed',
          stopReason: 'completed',
          sessionId: 'chat-json',
          content: '一次性 **JSON** 回答',
          reasoning: '一次性思考',
        },
      }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const streamToggle = wrapper.findAll('.model-toggle input')[0]
    await streamToggle!.setValue(false)
    expect(wrapper.text()).toContain('普通 JSON')

    await wrapper.get('textarea').setValue('非流式提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      message: '非流式提问',
      model: {
        stream: false,
        reasoning: { enabled: true, effort: 'high' },
      },
    })
    expect(wrapper.get('.markdown-body strong').text()).toBe('JSON')
    await wrapper.get('.reasoning-toggle').trigger('click')
    expect(wrapper.text()).toContain('一次性思考')
    expect(wrapper.find('.typing-indicator').exists()).toBe(false)
  })

  it('replaces the composer with a confirmation card while a tool awaits approval', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-approval' },
      {
        type: 'tool.approval.requested',
        sessionId: 'chat-approval',
        runId: 'run-approval-ui',
        approvalId: 'approval-ui',
        callId: 'call-ui',
        toolName: 'manage_runtime_resource',
        reason: '工具将写入进程内资源 demo/ui',
        title: '确认写入资源',
        details: { operation: 'write', resource: 'demo/ui' },
        input: { operation: 'write', resource: 'demo/ui', content: 'hello' },
        risk: 'destructive',
        approvalTimeoutMs: 45_000,
        requestedAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    ])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(jsonResponse({ accepted: true }))
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    await wrapper.get('textarea').setValue('写入演示资源')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.get('.tool-confirm-card').text()).toContain('确认写入资源')
    expect(wrapper.get('.tool-confirm-card').text()).toContain('manage_runtime_resource')
    expect(wrapper.get('.tool-confirm-card').text()).toContain('剩余 00:')
    expect(wrapper.get('.tool-input-details').text()).toContain('查看调用参数')

    await wrapper.get('.tool-approve-button').trigger('click')
    await flushPromises()
    expect(fetchMock.mock.calls[2][0]).toBe('/api/tool-approvals/approval-ui')
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({ decision: 'allow' })

    stream.push({
      type: 'tool.approval.resolved',
      sessionId: 'chat-approval',
      runId: 'run-approval-ui',
      approvalId: 'approval-ui',
      callId: 'call-ui',
      toolName: 'manage_runtime_resource',
      outcome: 'allowed',
      resolvedAt: new Date().toISOString(),
    })
    stream.push({
      type: 'message.completed',
      sessionId: 'chat-approval',
      content: '已完成写入',
      reasoning: '',
    })
    stream.close()
    await flushPromises()

    expect(wrapper.text()).toContain('已完成写入')
    expect(wrapper.find('textarea').exists()).toBe(true)
  })

  it('shows an automatic ToolPolicy denial without asking for a decision', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-denied' },
      {
        type: 'tool.guard.denied',
        sessionId: 'chat-denied',
        runId: 'run-denied',
        callId: 'call-denied',
        toolName: 'manage_runtime_resource',
        reason: '受保护资源 protected/system 禁止删除',
      },
    ])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    await wrapper.get('textarea').setValue('删除受保护资源')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('.tool-confirm-card.denied').text()).toContain('工具已被策略拒绝')
    expect(wrapper.get('.tool-confirm-card.denied').text()).toContain('禁止删除')
    expect(wrapper.find('.tool-approve-button').exists()).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-denied',
      content: '该操作不能执行',
      reasoning: '',
    })
    stream.close()
    await flushPromises()

    expect(wrapper.text()).toContain('该操作不能执行')
  })

  it('shows a no-expiry label when Agent standard event uses timeout -1', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-no-expiry' },
      {
        type: 'tool.approval.requested',
        sessionId: 'chat-no-expiry',
        runId: 'run-no-expiry',
        approvalId: 'approval-no-expiry',
        callId: 'call-no-expiry',
        toolName: 'wait_for_confirmation',
        reason: '等待用户稍后确认',
        input: {},
        risk: 'write',
        approvalTimeoutMs: -1,
        requestedAt: new Date().toISOString(),
        expiresAt: null,
      },
    ])
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(stream.response)
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    await wrapper.get('textarea').setValue('等待确认')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('.tool-confirm-card').text()).toContain('无过期时间')

    stream.push({
      type: 'tool.approval.resolved',
      sessionId: 'chat-no-expiry',
      runId: 'run-no-expiry',
      approvalId: 'approval-no-expiry',
      callId: 'call-no-expiry',
      toolName: 'wait_for_confirmation',
      outcome: 'denied',
      resolvedAt: new Date().toISOString(),
    })
    stream.push({
      type: 'message.completed',
      sessionId: 'chat-no-expiry',
      content: '用户尚未允许',
      reasoning: '',
    })
    stream.close()
    await flushPromises()
  })
})
