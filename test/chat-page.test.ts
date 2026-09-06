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
      history: [
        { role: 'user', content: '历史问题' },
        { role: 'assistant', content: '历史回答', reasoning_content: '历史思考过程' },
        { role: 'tool', content: '{"ignored":true}' },
      ],
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ data: [existingConversation] }))
      .mockResolvedValueOnce(streamResponse([
        { type: 'conversation', conversationId: 'chat-existing' },
        { type: 'message.delta', channel: 'reasoning', delta: '先分析已有上下文' },
        { type: 'message.delta', channel: 'content', delta: '继续' },
        { type: 'message.delta', channel: 'content', delta: '回答' },
        {
          type: 'message.completed',
          content: '继续回答',
          reasoning: '先分析已有上下文',
          conversationId: 'chat-existing',
        },
      ]))
      .mockResolvedValueOnce(jsonResponse({ data: [existingConversation] }))
      .mockResolvedValueOnce(streamResponse([
        { type: 'conversation', conversationId: 'chat-new' },
        { type: 'message.delta', channel: 'content', delta: '新会话' },
        { type: 'message.delta', channel: 'content', delta: '回答' },
        { type: 'message.completed', content: '新会话回答', conversationId: 'chat-new' },
      ]))
      .mockResolvedValueOnce(jsonResponse({ data: [existingConversation] }))

    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.text()).toContain('历史问题')
    expect(wrapper.text()).toContain('历史回答')
    expect(wrapper.text()).not.toContain('历史思考过程')
    expect(wrapper.text()).not.toContain('{"ignored":true}')

    await wrapper.get('.reasoning-toggle').trigger('click')
    expect(wrapper.text()).toContain('历史思考过程')

    await wrapper.get('textarea').setValue('继续提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const existingRequest = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(existingRequest).toEqual({
      message: '继续提问',
      conversationId: 'chat-existing',
    })
    expect(wrapper.text()).toContain('继续回答')

    const reasoningToggles = wrapper.findAll('.reasoning-toggle')
    await reasoningToggles.at(-1)!.trigger('click')
    expect(wrapper.text()).toContain('先分析已有上下文')

    await wrapper.get('.new-chat-button').trigger('click')
    await wrapper.get('textarea').setValue('创建新对话')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const newRequest = JSON.parse(String(fetchMock.mock.calls[3][1]?.body))
    expect(newRequest).toEqual({ message: '创建新对话' })
    expect(wrapper.text()).toContain('新会话回答')
  })
})
