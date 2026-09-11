import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ChatPage from '../src/pages/index.vue'

/**
 * GET /api/model 返回的部署词汇表。
 *
 * 推理等级的默认值来自服务端，因此这里显式给出确定值，
 * 否则请求体断言会依赖部署环境而不是测试本身。
 */
const modelInfo = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  reasoningEffort: 'high',
  reasoningEfforts: ['off', 'low', 'high', 'max'],
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
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

/** 页面会访问的每一个接口，都可以按 URL 单独配置响应。 */
interface FetchRoutes {
  /** GET /api/conversation/list 返回的会话摘要。 */
  conversations?: unknown[]
  /** GET /api/conversation/:id 返回的会话详情，按会话 ID 索引。 */
  conversationDetails?: Record<string, unknown>
  /** GET /api/model 返回的 data；显式传 null 表示该请求失败。 */
  model?: unknown
  /** 依次取给 POST /api/chat 的响应，流式与非流式都放在这里。 */
  chat?: Response[]
}

type FetchMock = ReturnType<typeof vi.fn>

/**
 * 按 URL 路由的 fetch mock。
 *
 * 页面挂载时会额外请求 GET /api/model，调用顺序和下标都不再稳定，
 * 因此断言一律通过 callsFor / chatRequestBody 这类按 URL 定位的辅助函数完成。
 */
function createFetchMock(routes: FetchRoutes = {}): FetchMock {
  const chatResponses = [...(routes.chat ?? [])]

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'

    if (method === 'GET' && url === '/api/model') {
      return routes.model === null
        ? errorResponse(500)
        : jsonResponse({ data: routes.model ?? modelInfo })
    }

    if (method === 'GET' && url === '/api/conversation/list')
      return jsonResponse({ data: routes.conversations ?? [] })

    if (method === 'GET' && url.startsWith('/api/conversation/')) {
      const id = decodeURIComponent(url.slice('/api/conversation/'.length))
      const detail = routes.conversationDetails?.[id]
      if (!detail)
        throw new Error(`测试未提供会话详情：${id}`)
      return jsonResponse({ data: detail })
    }

    if (method === 'POST' && url === '/api/chat') {
      const response = chatResponses.shift()
      if (!response)
        throw new Error('测试未提供足够的 /api/chat 响应')
      return response
    }

    if (method === 'POST' && url.startsWith('/api/tool-approvals/'))
      return jsonResponse({ accepted: true })

    throw new Error(`测试未路由的请求：${method} ${url}`)
  })
}

/** 按 URL 与方法筛选调用，不依赖调用顺序，也不使用魔法下标。 */
function callsFor(
  fetchMock: FetchMock,
  url: string,
  options: { method?: string, prefix?: boolean } = {},
) {
  const method = options.method ?? 'GET'
  return fetchMock.mock.calls.filter(([input, init]) => {
    const target = String(input)
    const matched = options.prefix ? target.startsWith(url) : target === url
    return matched && (init?.method ?? 'GET') === method
  })
}

/**
 * 取出第 index 个 POST /api/chat 的请求体。
 *
 * 同一 URL 会被多次调用（例如先问已有会话、再新建会话），因此这里保留序号，
 * 但序号只在 /api/chat 内部有意义，不会被其他接口的调用打乱。
 */
function chatRequestBody(fetchMock: FetchMock, index: number): Record<string, unknown> {
  const calls = callsFor(fetchMock, '/api/chat', { method: 'POST' })
  const call = calls[index]
  if (!call)
    throw new Error(`未找到第 ${index + 1} 个 POST /api/chat 请求`)
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>
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
    const fetchMock = createFetchMock({
      conversations: [existingConversation],
      conversationDetails: { 'chat-existing': existingConversationDetail },
      chat: [
        streamResponse([
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
        ]),
        streamResponse([
          { type: 'session.started', sessionId: 'chat-new' },
          { type: 'message.delta', sessionId: 'chat-new', channel: 'content', delta: '新会话' },
          { type: 'message.delta', sessionId: 'chat-new', channel: 'content', delta: '回答' },
          { type: 'message.completed', sessionId: 'chat-new', content: '新会话回答', reasoning: '' },
        ]),
      ],
    })

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

    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '继续提问',
      conversationId: 'chat-existing',
      stream: true,
      reasoningEffort: 'high',
    })
    expect(wrapper.text()).toContain('继续回答')

    const reasoningToggles = wrapper.findAll('.reasoning-toggle')
    await reasoningToggles.at(-1)!.trigger('click')
    expect(wrapper.text()).toContain('先分析已有上下文')

    await wrapper.get('.new-chat-button').trigger('click')
    await wrapper.get('textarea').setValue('创建新对话')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // 新会话刻意省略 conversationId，但不能省略用户选定的推理等级。
    expect(chatRequestBody(fetchMock, 1)).toEqual({
      message: '创建新对话',
      stream: true,
      reasoningEffort: 'high',
    })
    expect(wrapper.text()).toContain('新会话回答')
  })

  it('renders the reasoning control from the deployment vocabulary and sends off when disabled', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-reasoning' },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 硬编码的 datalist 已被删除：等级名只能来自 GET /api/model。
    expect(wrapper.find('#reasoning-effort-options').exists()).toBe(false)
    const select = wrapper.get('.reasoning-effort-control select')
    expect(select.findAll('option').map(option => option.text())).toEqual([
      '不推理（off）',
      'low',
      'high',
      'max',
    ])
    // 初始选中项是部署默认等级，而不是页面写死的值。
    expect((select.element as HTMLSelectElement).value).toBe('high')

    await select.setValue('off')
    await wrapper.get('textarea').setValue('关闭推理')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // 请求仍在进行时等级不可再改，避免改变正在执行的 Run。
    expect(wrapper.get('.reasoning-effort-control select').attributes('disabled')).toBeDefined()
    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '关闭推理',
      stream: true,
      reasoningEffort: 'off',
    })

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-reasoning',
      content: '已按不推理模式回答',
      reasoning: '',
    })
    stream.close()
    await flushPromises()

    expect(wrapper.text()).toContain('已按不推理模式回答')
  })

  it('falls back to a free-text level and omits the field when nothing is chosen', async () => {
    const fetchMock = createFetchMock({
      model: {
        provider: 'openai-compatible',
        model: 'local',
        reasoningEffort: null,
        reasoningEfforts: [],
      },
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-free-text' },
        { type: 'message.completed', sessionId: 'chat-free-text', content: '没有等级也能回答', reasoning: '' },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 词汇表为空时不能退化成“没有任何等级可选”，必须给出自由文本输入。
    expect(wrapper.find('.reasoning-effort-control select').exists()).toBe(false)
    const effortInput = wrapper.get('.reasoning-effort-control input')
    expect((effortInput.element as HTMLInputElement).value).toBe('')

    await wrapper.get('textarea').setValue('不指定等级')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const request = chatRequestBody(fetchMock, 0)
    expect(request).toEqual({ message: '不指定等级', stream: true })
    // 没有具体选择时必须整个省略字段，而不是发送空串让服务端改写语义。
    expect(request).not.toHaveProperty('reasoningEffort')
    expect(wrapper.text()).toContain('没有等级也能回答')
  })

  it('keeps chatting with a free-text level when /api/model fails', async () => {
    const fetchMock = createFetchMock({
      model: null,
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-model-error' },
        { type: 'message.completed', sessionId: 'chat-model-error', content: '词汇表失败仍可聊天', reasoning: '' },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 词汇表只是便利信息，加载失败不应弹出阻塞性错误。
    expect(wrapper.find('.error-banner').exists()).toBe(false)
    expect(wrapper.find('.reasoning-effort-control select').exists()).toBe(false)

    await wrapper.get('.reasoning-effort-control input').setValue('ultra')
    await wrapper.get('textarea').setValue('自定义等级提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '自定义等级提问',
      stream: true,
      reasoningEffort: 'ultra',
    })
    expect(wrapper.text()).toContain('词汇表失败仍可聊天')
  })

  it('uses ordinary JSON instead of reading SSE when streaming is disabled', async () => {
    const fetchMock = createFetchMock({
      chat: [jsonResponse({
        data: {
          status: 'completed',
          stopReason: 'completed',
          sessionId: 'chat-json',
          content: '一次性 **JSON** 回答',
          reasoning: '一次性思考',
        },
      })],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 流式开关必须是 .model-toggle 中的第一个，也是唯一一个复选框控件。
    const toggles = wrapper.findAll('.model-toggle input')
    expect(toggles).toHaveLength(1)
    const streamToggle = toggles[0]
    await streamToggle!.setValue(false)
    expect(wrapper.text()).toContain('普通 JSON')

    await wrapper.get('textarea').setValue('非流式提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '非流式提问',
      stream: false,
      reasoningEffort: 'high',
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
        toolMetadata: { risk: 'destructive' },
        approvalTimeoutMs: 45_000,
        requestedAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(Date.now() + 45_000).toISOString(),
      },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
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

    const approvalCalls = callsFor(fetchMock, '/api/tool-approvals/', { method: 'POST', prefix: true })
    expect(approvalCalls).toHaveLength(1)
    expect(approvalCalls[0]![0]).toBe('/api/tool-approvals/approval-ui')
    expect(JSON.parse(String(approvalCalls[0]![1]?.body))).toEqual({ decision: 'allow' })

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

  it('shows an automatic ToolGuard denial without asking for a decision', async () => {
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
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    await wrapper.get('textarea').setValue('删除受保护资源')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(wrapper.get('.tool-confirm-card.denied').text()).toContain('工具已被策略拒绝')
    expect(wrapper.get('.tool-confirm-card.denied').text()).toContain('禁止删除')
    expect(wrapper.find('.tool-approve-button').exists()).toBe(false)
    // 自动拒绝不产生审批 POST；除会话列表、模型词汇表和聊天之外不应有额外请求。
    expect(callsFor(fetchMock, '/api/tool-approvals/', { method: 'POST', prefix: true })).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)

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
        toolMetadata: { risk: 'write' },
        approvalTimeoutMs: -1,
        requestedAt: new Date().toISOString(),
        expiresAt: null,
      },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
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
