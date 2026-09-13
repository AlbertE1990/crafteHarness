import type { DOMWrapper, VueWrapper } from '@vue/test-utils'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import {
  EMPTY_TURN_TITLE,
  resolveActiveTurnIndex,
  summarizeTurnTitle,
  TURN_TITLE_MAX_LENGTH,
} from '../src/components/ConversationView.vue'
import ChatPage from '../src/pages/index.vue'

/**
 * GET /api/model 返回的部署词汇表。
 *
 * 模型是对象数组：id 用于请求、label 用于展示，每个模型自带推理能力与默认等级。
 * 三个模型刻意覆盖三种情况——档位齐全、档位更少、完全没有推理控制，
 * 这样"切换模型后等级跟着变"能在测试里真正被验证，而不是依赖部署环境。
 */
const modelInfo = {
  provider: 'deepseek',
  defaultModel: 'deepseek-v4-flash',
  models: [
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek V4 Flash',
      reasoningEfforts: ['off', 'low', 'high', 'max'],
      defaultReasoningEffort: 'high',
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek V4 Pro',
      reasoningEfforts: ['off', 'high', 'max'],
      defaultReasoningEffort: 'high',
    },
    {
      id: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner',
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
  ],
}

/** 会话名称上限与服务端 400 的约束一致，测试里需要显式构造超长名称。 */
const MAX_CONVERSATION_NAME_LENGTH = 80

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
  /** PATCH /api/conversation/:id 的响应覆盖；缺省按请求体里的 name 返回 200 摘要。 */
  conversationPatches?: Record<string, Response>
  /** DELETE /api/conversation/:id 的响应覆盖；缺省返回 deleted: true。 */
  conversationDeletions?: Record<string, Response>
}

type FetchMock = ReturnType<typeof vi.fn>

/**
 * 按 URL 路由的 fetch mock。
 *
 * 页面挂载时会额外请求 GET /api/model，调用顺序和下标都不再稳定，
 * 因此断言一律通过 callsFor / chatRequestBody 这类按 URL 定位的辅助函数完成。
 *
 * PATCH / DELETE 与 GET 共用 /api/conversation/:id 这一条 URL 前缀，
 * 因此必须按 method 分流，不能让“读详情”的响应被写操作复用。
 */
function createFetchMock(routes: FetchRoutes = {}): FetchMock {
  const chatResponses = [...(routes.chat ?? [])]

  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const sessionId = url.startsWith('/api/conversation/')
      ? decodeURIComponent(url.slice('/api/conversation/'.length))
      : ''

    if (method === 'GET' && url === '/api/model') {
      return routes.model === null
        ? errorResponse(500)
        : jsonResponse({ data: routes.model ?? modelInfo })
    }

    if (method === 'GET' && url === '/api/conversation/list')
      return jsonResponse({ data: routes.conversations ?? [] })

    if (method === 'GET' && url.startsWith('/api/conversation/')) {
      const detail = routes.conversationDetails?.[sessionId]
      if (!detail)
        throw new Error(`测试未提供会话详情：${sessionId}`)
      return jsonResponse({ data: detail })
    }

    // 重命名：默认回显请求体里的 name，模拟服务端 PATCH 后的摘要。
    if (method === 'PATCH' && url.startsWith('/api/conversation/')) {
      const override = routes.conversationPatches?.[sessionId]
      if (override)
        return override
      const body = JSON.parse(String(init?.body ?? '{}')) as { name?: string }
      return jsonResponse({
        data: { id: sessionId, name: body.name, createAt: String(Date.now()) },
      })
    }

    if (method === 'DELETE' && url.startsWith('/api/conversation/')) {
      const override = routes.conversationDeletions?.[sessionId]
      if (override)
        return override
      return jsonResponse({ data: { id: sessionId, deleted: true } })
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

/** 统计某个会话详情的 GET 次数，用来验证缓存命中时不再请求网络。 */
function conversationDetailCalls(fetchMock: FetchMock, sessionId: string): number {
  return callsFor(fetchMock, `/api/conversation/${sessionId}`).length
}

/** 按会话名称定位列表项，不依赖列表渲染顺序。 */
function findConversationItem(wrapper: VueWrapper, name: string): DOMWrapper<Element> {
  const item = wrapper.findAll('.conversation-item').find(node => node.text().includes(name))
  if (!item)
    throw new Error(`未找到会话列表项：${name}`)
  return item
}

/**
 * 让 jsdom 的 textarea.scrollHeight 反映内容行数。
 *
 * jsdom 不做布局，scrollHeight 恒为 0，自增高逻辑会一直读到 0；
 * 这里按“行数 × 行高”给出确定值，使“随内容增高、到上限截断”可以被真实断言，
 * 而不是把断言放宽成“只要不报错”。
 */
function stubTextareaScrollHeight(lineHeight = 24): void {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return String(this.value).split('\n').length * lineHeight
    },
  })
}

/** 删除原型上的自有属性，回到 jsdom 默认的 scrollHeight 实现。 */
function restoreTextareaScrollHeight(): void {
  delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown }).scrollHeight
}

/**
 * 在把手元素上派发一个指针事件。
 *
 * jsdom 没有实现 setPointerCapture，而 VTU 的 trigger 无法给合成的 PointerEvent 赋 clientY，
 * 因此这里直接用 PointerEvent 构造函数造事件再 dispatch；拖动逻辑本身（记录起始 clientY、
 * 按位移换算高度、clamp、pointerup/pointercancel 收尾）是真跑的。
 */
function dispatchPointer(
  target: Element,
  type: string,
  options: { clientY: number, pointerId?: number },
): void {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: options.pointerId ?? 1,
    clientY: options.clientY,
    bubbles: true,
  }))
}

/**
 * jsdom 没有实现 scrollIntoView；装一个记录调用的桩，用来断言"导航定位到了哪一行"。
 *
 * 返回的 calls 里带上了 this（也就是被滚动的那个元素），这样"作用在该轮首行"可以精确断言。
 */
function stubScrollIntoView(): { calls: { element: Element, options?: ScrollIntoViewOptions }[] } {
  const calls: { element: Element, options?: ScrollIntoViewOptions }[] = []
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: Element, options?: ScrollIntoViewOptions) {
      calls.push({ element: this, options })
    },
  })
  return { calls }
}

/** 删除原型上的自有属性，回到 jsdom 默认（没有 scrollIntoView）。 */
function restoreScrollIntoView(): void {
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
}

/**
 * 给滚动容器实例装一个可读写的 scrollTop 和"真会生效"的 scrollTo。
 *
 * jsdom 不做布局：scrollTop 恒为 0 且赋值无效，scrollTo 也根本没实现。
 * 浏览器里 scrollTo 会把偏移写进 scrollTop，这里照做，测试才能断言真实数值，
 * 也才能区分"恢复到保存的位置"和"跟随到底"（后者的 top 是 scrollHeight，jsdom 里为 0）。
 */
function stubScrollContainer(element: HTMLElement, initialTop = 0): ReturnType<typeof vi.fn> {
  let scrollTop = initialTop
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value
    },
  })

  const scrollTo = vi.fn((options?: ScrollToOptions | number, y?: number) => {
    if (typeof options === 'object' && options !== null)
      scrollTop = options.top ?? scrollTop
    else if (typeof options === 'number')
      scrollTop = y ?? scrollTop
  })
  Object.defineProperty(element, 'scrollTo', { configurable: true, value: scrollTo })
  return scrollTo
}

/** 给某个元素一个确定的 offsetTop，供"当前轮次高亮"的计算使用。 */
function stubOffsetTop(element: Element, offsetTop: number): void {
  Object.defineProperty(element, 'offsetTop', { configurable: true, get: () => offsetTop })
}

/** 两轮对话的会话详情：导航相关用例共用。 */
const twoTurnDetail = {
  id: 'chat-turns',
  name: '两轮会话',
  createAt: String(Date.now()),
  history: [
    { role: 'user', content: '第一轮提问' },
    { role: 'assistant', content: '第一轮回答' },
    { role: 'user', content: '第二轮提问' },
    { role: 'assistant', content: '第二轮回答' },
  ],
}

describe('chat page conversations', () => {
  beforeEach(() => {
    window.localStorage.clear()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
  })

  afterEach(() => {
    restoreTextareaScrollHeight()
    restoreScrollIntoView()
    vi.unstubAllGlobals()
  })

  it('shows runnable examples and reuses one anonymous browser scope for private requests', async () => {
    const fetchMock = createFetchMock({
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-starter-weather' },
        {
          type: 'message.completed',
          sessionId: 'chat-starter-weather',
          content: '上海当前天气晴朗。',
          reasoning: '',
        },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.findAll('.starter-prompt')).toHaveLength(5)
    expect(wrapper.text()).toContain('查询实时天气')
    expect(wrapper.text()).toContain('测试资源写入')
    expect(wrapper.text()).toContain('读取演示资源')
    expect(wrapper.text()).toContain('计算与时间')
    expect(wrapper.text()).toContain('了解 Craft Harness')

    await wrapper.findAll('.starter-prompt')[0]!.trigger('click')
    await flushPromises()

    expect(chatRequestBody(fetchMock, 0).message).toBe(
      '查询当前天气，并告诉我体感温度、湿度和风力。',
    )
    const privateCalls = fetchMock.mock.calls.filter(([input]) => String(input) !== '/api/model')
    const scopeIds = privateCalls.map(([, init]) => new Headers(init?.headers).get('X-Craft-Scope-Id'))
    expect(scopeIds.length).toBeGreaterThan(0)
    expect(new Set(scopeIds).size).toBe(1)
    expect(scopeIds[0]).toMatch(
      /^browser-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )

    wrapper.unmount()
    const reloaded = mount(ChatPage)
    await flushPromises()
    const latestListCall = callsFor(fetchMock, '/api/conversation/list').at(-1)
    expect(new Headers(latestListCall?.[1]?.headers).get('X-Craft-Scope-Id')).toBe(scopeIds[0])
    reloaded.unmount()
  })

  it('restores history and only sends sessionId for an existing conversation', async () => {
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
      sessionId: 'chat-existing',
      stream: true,
      reasoningEffort: 'high',
      // 模型控件渲染自 GET /api/model 的 models，默认选中部署默认模型并随请求发送。
      model: 'deepseek-v4-flash',
    })
    expect(wrapper.text()).toContain('继续回答')

    const reasoningToggles = wrapper.findAll('.reasoning-toggle')
    await reasoningToggles.at(-1)!.trigger('click')
    expect(wrapper.text()).toContain('先分析已有上下文')

    await wrapper.get('.new-chat-button').trigger('click')
    await wrapper.get('textarea').setValue('创建新对话')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // 新会话刻意省略 sessionId，但不能省略用户选定的推理等级与模型。
    expect(chatRequestBody(fetchMock, 1)).toEqual({
      message: '创建新对话',
      stream: true,
      reasoningEffort: 'high',
      model: 'deepseek-v4-flash',
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
      model: 'deepseek-v4-flash',
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

  it('hides the reasoning chip for a model that declares no reasoning control', async () => {
    const fetchMock = createFetchMock({
      model: {
        provider: 'openai-compatible',
        defaultModel: 'local',
        models: [{ id: 'local', label: 'Local', reasoningEfforts: [], defaultReasoningEffort: null }],
      },
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-no-control' },
        { type: 'message.completed', sessionId: 'chat-no-control', content: '没有推理控制也能回答', reasoning: '' },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // reasoningEfforts 为空表示这个模型没有推理控制：chip 整体不渲染，也不给自由文本输入。
    expect(wrapper.find('.reasoning-effort-control').exists()).toBe(false)
    expect(wrapper.find('.reasoning-effort-control select').exists()).toBe(false)
    expect(wrapper.find('.reasoning-effort-control input').exists()).toBe(false)
    // 模型 chip 仍然在（服务端给出了可切换列表），展示 label、发送 id。
    expect((wrapper.get('.model-select').element as HTMLSelectElement).value).toBe('local')
    expect(wrapper.get('.model-select').findAll('option').map(option => option.text())).toEqual(['Local'])

    await wrapper.get('textarea').setValue('不指定等级')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const request = chatRequestBody(fetchMock, 0)
    expect(request).toEqual({ message: '不指定等级', stream: true, model: 'local' })
    // 该模型没有推理控制：必须整个省略字段，而不是发送空串。
    expect(request).not.toHaveProperty('reasoningEffort')
    expect(wrapper.text()).toContain('没有推理控制也能回答')
  })

  it('still chats with no model or reasoning chips when /api/model fails', async () => {
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
    // 词汇表整体不可用时两个 chip 都不渲染，页面退化为“部署默认模型 + 不指定等级”。
    expect(wrapper.find('.model-select').exists()).toBe(false)
    expect(wrapper.find('.reasoning-effort-control').exists()).toBe(false)
    // 控件行里不留空盒子，发送按钮仍然在位。
    expect(wrapper.find('.composer-controls').exists()).toBe(false)
    expect(wrapper.get('.composer-meta').findAll(':scope > *')).toHaveLength(1)
    expect(wrapper.find('.send-button').exists()).toBe(true)

    await wrapper.get('textarea').setValue('没有词汇表也能提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const request = chatRequestBody(fetchMock, 0)
    expect(request).toEqual({ message: '没有词汇表也能提问', stream: true })
    expect(request).not.toHaveProperty('model')
    expect(request).not.toHaveProperty('reasoningEffort')
    expect(wrapper.text()).toContain('词汇表失败仍可聊天')
  })

  it('always requests the streaming transport and parses SSE', async () => {
    const fetchMock = createFetchMock({
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-stream-only' },
        { type: 'message.delta', sessionId: 'chat-stream-only', channel: 'reasoning', delta: '流式思考' },
        { type: 'message.delta', sessionId: 'chat-stream-only', channel: 'content', delta: '流式' },
        { type: 'message.delta', sessionId: 'chat-stream-only', channel: 'content', delta: '回答' },
        {
          type: 'message.completed',
          sessionId: 'chat-stream-only',
          content: '流式回答',
          reasoning: '流式思考',
        },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 流式开关已被产品砍掉：页面上不该再有任何传输方式开关。
    expect(wrapper.find('.model-toggle').exists()).toBe(false)
    expect(wrapper.find('.model-controls').exists()).toBe(false)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)

    await wrapper.get('textarea').setValue('只要流式')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // 固定 stream: true —— 非流式 JSON 路径在前端已经不存在。
    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '只要流式',
      stream: true,
      reasoningEffort: 'high',
      model: 'deepseek-v4-flash',
    })
    // SSE 的增量与最终结果都被消费：加粗来自 markdown 渲染，思考内容在思考面板里。
    expect(wrapper.text()).toContain('流式回答')
    await wrapper.get('.reasoning-toggle').trigger('click')
    expect(wrapper.text()).toContain('流式思考')
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

  it('rerenders the reasoning levels when the model changes', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-model-efforts' },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // flash：4 档，默认 high。
    expect(wrapper.get('.reasoning-effort-control select').findAll('option').map(option => option.text()))
      .toEqual(['不推理（off）', 'low', 'high', 'max'])
    expect((wrapper.get('.reasoning-effort-control select').element as HTMLSelectElement).value).toBe('high')

    // 换成 pro：等级列表必须按新模型重新渲染（3 档，没有 low）。
    await wrapper.get('.model-select').setValue('deepseek-v4-pro')
    await flushPromises()

    const proOptions = wrapper.get('.reasoning-effort-control select').findAll('option')
    expect(proOptions.map(option => option.text())).toEqual(['不推理（off）', 'high', 'max'])
    expect(proOptions.map(option => option.attributes('value'))).toEqual(['off', 'high', 'max'])
    // 原等级 high 在新模型里仍然存在，因此保留 high（不会无谓地重置）。
    expect((wrapper.get('.reasoning-effort-control select').element as HTMLSelectElement).value).toBe('high')

    // 选一档新模型独有的等级，请求体里 model 与 reasoningEffort 都是新模型的值。
    await wrapper.get('.reasoning-effort-control select').setValue('max')
    await wrapper.get('textarea').setValue('用 pro 的最高档')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '用 pro 的最高档',
      stream: true,
      reasoningEffort: 'max',
      model: 'deepseek-v4-pro',
    })

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-model-efforts',
      content: '已用 pro 回答',
      reasoning: '',
    })
    stream.close()
    await flushPromises()
    expect(wrapper.text()).toContain('已用 pro 回答')
  })

  it('resets the reasoning level to the new model default when it is not supported', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-reset-effort' },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // flash 上选中 low —— pro 的列表里没有 low。
    await wrapper.get('.reasoning-effort-control select').setValue('low')
    expect((wrapper.get('.reasoning-effort-control select').element as HTMLSelectElement).value).toBe('low')

    await wrapper.get('.model-select').setValue('deepseek-v4-pro')
    await flushPromises()

    // 自动回到 pro 的 defaultReasoningEffort（high），而不是发一个它不支持的等级。
    expect((wrapper.get('.reasoning-effort-control select').element as HTMLSelectElement).value).toBe('high')

    // 再切回 flash：high 在 flash 里同样存在，因此保持 high。
    await wrapper.get('.model-select').setValue('deepseek-v4-flash')
    await flushPromises()
    expect((wrapper.get('.reasoning-effort-control select').element as HTMLSelectElement).value).toBe('high')

    await wrapper.get('textarea').setValue('回到 flash')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '回到 flash',
      stream: true,
      reasoningEffort: 'high',
      model: 'deepseek-v4-flash',
    })

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-reset-effort',
      content: '已回到 flash',
      reasoning: '',
    })
    stream.close()
    await flushPromises()
  })

  it('hides the reasoning chip when the model has no reasoning control', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-no-effort' },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.find('.reasoning-effort-control').exists()).toBe(true)

    // 切到 reasoningEfforts 为空的模型：chip 消失。
    await wrapper.get('.model-select').setValue('deepseek-reasoner')
    await flushPromises()
    expect(wrapper.find('.reasoning-effort-control').exists()).toBe(false)
    // 模型 chip 仍在，并显示它自己的 label。
    expect((wrapper.get('.model-select').element as HTMLSelectElement).value).toBe('deepseek-reasoner')
    expect(wrapper.get('.model-select-control').text()).toContain('DeepSeek Reasoner')

    await wrapper.get('textarea').setValue('纯推理模型')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    const request = chatRequestBody(fetchMock, 0)
    expect(request).toEqual({
      message: '纯推理模型',
      stream: true,
      model: 'deepseek-reasoner',
    })
    // 该模型没有推理控制：请求体里不能出现 reasoningEffort 键。
    expect(request).not.toHaveProperty('reasoningEffort')
    // 请求进行中控件是禁用的（不能改变正在执行的 Run）。
    expect(wrapper.get('.model-select').attributes('disabled')).toBeDefined()

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-no-effort',
      content: '纯推理模型也能回答',
      reasoning: '',
    })
    stream.close()
    await flushPromises()
    expect(wrapper.text()).toContain('纯推理模型也能回答')

    // 切回有推理能力的模型：chip 回来，并取该模型的默认等级。
    await wrapper.get('.model-select').setValue('deepseek-v4-flash')
    await flushPromises()
    expect(wrapper.find('.reasoning-effort-control').exists()).toBe(true)
    expect((wrapper.get('.reasoning-effort-control select').element as HTMLSelectElement).value).toBe('high')
  })

  it('renders the deployment models in the composer meta area and sends the chosen model', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-model' },
    ])
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 模型与推理等级都在输入内容下方的 .composer-meta 控件行里。
    const meta = wrapper.get('.composer .composer-meta')
    const modelSelect = meta.get('.model-select')
    expect(meta.find('.reasoning-effort-control').exists()).toBe(true)
    // 控件行里没有输入区本体，避免控件挤进文字输入区域。
    expect(meta.find('textarea').exists()).toBe(false)
    // 控件行是输入框的最后一个子节点：输入内容排在它之前。
    expect(wrapper.get('.composer').element.children[2]).toBe(meta.element)

    // 选项与顺序都来自 GET /api/model 的 models：展示 label，值仍是用于请求的 id。
    expect(modelSelect.findAll('option').map(option => option.text())).toEqual([
      'DeepSeek V4 Flash',
      'DeepSeek V4 Pro',
      'DeepSeek Reasoner',
    ])
    expect(modelSelect.findAll('option').map(option => option.attributes('value'))).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-reasoner',
    ])
    // 初始选中部署默认模型（GET /api/model 的 defaultModel）。
    expect((modelSelect.element as HTMLSelectElement).value).toBe('deepseek-v4-flash')

    // 换成一个同样支持推理的模型：请求体带新模型与新模型的默认等级。
    await modelSelect.setValue('deepseek-v4-pro')
    await wrapper.get('textarea').setValue('换个模型回答')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    expect(chatRequestBody(fetchMock, 0)).toEqual({
      message: '换个模型回答',
      stream: true,
      reasoningEffort: 'high',
      model: 'deepseek-v4-pro',
    })
    // 请求进行中不允许再切换模型，避免改变正在执行的 Run。
    expect(wrapper.get('.model-select').attributes('disabled')).toBeDefined()

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-model',
      content: '已换模型回答',
      reasoning: '',
    })
    stream.close()
    await flushPromises()

    expect(wrapper.text()).toContain('已换模型回答')
    expect(wrapper.get('.model-select').attributes('disabled')).toBeUndefined()
  })

  it('stacks the resize handle, textarea and control row vertically with an icon-only send button', async () => {
    const fetchMock = createFetchMock({})
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const composer = wrapper.get('.composer')
    const handle = composer.get('.composer-resize-handle')
    const textarea = composer.get('textarea')
    const meta = composer.get('.composer-meta')

    // 纵向堆叠：把手 → textarea → 控件行，三者顺序在 DOM 里固定。
    const children = Array.from(composer.element.children)
    expect(children).toHaveLength(3)
    expect(children[0]).toBe(handle.element)
    expect(children[1]).toBe(textarea.element)
    expect(children[2]).toBe(meta.element)

    // 把手与输入框都排在控件行之前（用文档位置再确认一次，而不只看数组下标）。
    const positionOfMeta = handle.element.compareDocumentPosition(meta.element)
    expect(positionOfMeta & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(textarea.element.compareDocumentPosition(meta.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // 控件行：左侧模型 / 推理等级药丸，右侧发送按钮（发送按钮用 margin-left: auto 贴右）。
    const controls = meta.get('.composer-controls')
    expect(controls.find('.model-select-control').exists()).toBe(true)
    expect(controls.find('.reasoning-effort-control').exists()).toBe(true)
    const metaChildren = Array.from(meta.element.children)
    expect(metaChildren).toHaveLength(2)
    expect(metaChildren[0]).toBe(controls.element)
    expect(metaChildren[1]).toBe(meta.get('.send-button').element)
    expect(controls.element.nextElementSibling).toBe(meta.get('.send-button').element)

    // 发送按钮只有一颗图标、没有文字；图标按 UnoCSS attributify 写法渲染成属性。
    const sendButton = meta.get('.send-button')
    expect(sendButton.text()).toBe('')
    expect(sendButton.element.children).toHaveLength(1)
    const sendIcon = sendButton.element.children[0]!
    expect(sendIcon.textContent).toBe('')
    expect(sendIcon.getAttributeNames().some(name => name.startsWith('i-carbon-'))).toBe(true)

    // 模型 / 推理等级只出现在输入框下方的这一行里；输入框上方不再有任何开关。
    expect(wrapper.find('.model-controls').exists()).toBe(false)
    expect(wrapper.find('.model-toggle').exists()).toBe(false)
    expect(wrapper.get('.composer-content').findAll('.model-select-control')).toHaveLength(1)
    expect(wrapper.get('.composer-content').findAll('.reasoning-effort-control')).toHaveLength(1)
  })

  it('collapses and expands the conversation sidebar while keeping the chat panel', async () => {
    const conversation = { id: 'chat-collapse', name: '可收缩会话', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [conversation],
      conversationDetails: {
        'chat-collapse': {
          ...conversation,
          history: [{ role: 'user', content: '收缩前加载的历史' }],
        },
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.get('.workspace-shell').classes()).not.toContain('sidebar-collapsed')
    expect(wrapper.get('.conversation-sidebar').classes()).not.toContain('collapsed')

    await wrapper.get('.sidebar-collapse-button').trigger('click')

    // 收缩状态由类切换表达：shell 让出侧边栏列宽，侧边栏自身进入 collapsed。
    expect(wrapper.get('.workspace-shell').classes()).toContain('sidebar-collapsed')
    expect(wrapper.get('.conversation-sidebar').classes()).toContain('collapsed')
    // 收缩只是收起，不卸载：会话列表仍在 DOM 里，对话区与消息区也完整保留。
    expect(wrapper.find('.conversation-sidebar').exists()).toBe(true)
    expect(wrapper.find('.conversation-sidebar').find('.conversation-item').exists()).toBe(true)
    expect(wrapper.find('.chat-panel').exists()).toBe(true)
    expect(wrapper.find('.message-list').exists()).toBe(true)
    expect(wrapper.text()).toContain('收缩前加载的历史')

    await wrapper.get('.sidebar-expand-button').trigger('click')

    expect(wrapper.get('.workspace-shell').classes()).not.toContain('sidebar-collapsed')
    expect(wrapper.get('.conversation-sidebar').classes()).not.toContain('collapsed')
    expect(wrapper.get('.conversation-sidebar').find('.conversation-item').exists()).toBe(true)
    // 展开按钮只在收起状态存在，展开后不再占位。
    expect(wrapper.find('.sidebar-expand-button').exists()).toBe(false)
  })

  it('reuses the cached conversation detail instead of refetching when switching back', async () => {
    const older = { id: 'chat-older', name: '较早会话', createAt: String(Date.now() - 60_000) }
    const newer = { id: 'chat-newer', name: '最近会话', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [older, newer],
      conversationDetails: {
        'chat-older': { ...older, history: [{ role: 'user', content: '较早的问题' }] },
        'chat-newer': { ...newer, history: [{ role: 'user', content: '最近的问题' }] },
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 挂载时自动打开最近一条会话：这是 chat-newer 唯一的一次详情请求。
    expect(wrapper.text()).toContain('最近的问题')
    expect(conversationDetailCalls(fetchMock, 'chat-newer')).toBe(1)

    await findConversationItem(wrapper, '较早会话').get('.conversation-select').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('较早的问题')
    expect(conversationDetailCalls(fetchMock, 'chat-older')).toBe(1)

    await findConversationItem(wrapper, '最近会话').get('.conversation-select').trigger('click')
    await flushPromises()
    // 切回来命中内存缓存：内容正确，且没有第二次详情请求。
    expect(wrapper.text()).toContain('最近的问题')
    expect(conversationDetailCalls(fetchMock, 'chat-newer')).toBe(1)

    await findConversationItem(wrapper, '较早会话').get('.conversation-select').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('较早的问题')
    expect(conversationDetailCalls(fetchMock, 'chat-older')).toBe(1)

    // 两次往返切换后，详情请求总数仍等于“每个会话各加载一次”。
    expect(callsFor(fetchMock, '/api/conversation/chat-', { prefix: true })).toHaveLength(2)
    expect(callsFor(fetchMock, '/api/conversation/list')).toHaveLength(1)
  })

  it('refreshes the active conversation from the server without reloading the catalog', async () => {
    const conversation = { id: 'chat-refresh', name: '可刷新会话', createAt: String(Date.now()) }
    const conversationDetails: Record<string, unknown> = {
      'chat-refresh': {
        ...conversation,
        history: [{ role: 'user', content: '刷新前内容' }],
      },
    }
    const fetchMock = createFetchMock({ conversations: [conversation], conversationDetails })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.text()).toContain('刷新前内容')
    expect(conversationDetailCalls(fetchMock, conversation.id)).toBe(1)
    expect(wrapper.get('.conversation-refresh-button').attributes('aria-label'))
      .toBe('刷新当前会话内容')

    conversationDetails[conversation.id] = {
      ...conversation,
      history: [
        { role: 'user', content: '刷新前内容' },
        { role: 'assistant', content: '服务端新增内容' },
      ],
    }
    await wrapper.get('.conversation-refresh-button').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('服务端新增内容')
    expect(wrapper.get('.message-count').text()).toBe('2 条消息')
    expect(conversationDetailCalls(fetchMock, conversation.id)).toBe(2)
    // 只刷新当前详情，不额外重载侧栏目录。
    expect(callsFor(fetchMock, '/api/conversation/list')).toHaveLength(1)
  })

  it('renames a conversation through PATCH and blocks invalid names locally', async () => {
    const conversation = { id: 'chat-rename', name: '待重命名', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [conversation],
      conversationDetails: {
        'chat-rename': {
          ...conversation,
          history: [{ role: 'user', content: '需要重命名的会话' }],
        },
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 重命名入口收敛到左侧 kebab 菜单里，列表项右侧不再有常驻按钮。
    const item = findConversationItem(wrapper, '待重命名')
    expect(item.find('.conversation-actions').exists()).toBe(false)
    await item.get('.conversation-menu-button').trigger('click')
    await item.get('.conversation-menu-rename').trigger('click')

    const renameInput = wrapper.get('.conversation-rename-input')
    // 进入编辑态时带上当前名称，避免用户从空白开始重打。
    expect((renameInput.element as HTMLInputElement).value).toBe('待重命名')
    // 选中菜单项后菜单关闭，不会和编辑态叠在一起。
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)

    // 纯空白名称在前端被拦下：不发 PATCH，只在行内提示。
    await renameInput.setValue('   ')
    await wrapper.get('.conversation-rename-confirm').trigger('click')
    await flushPromises()
    expect(callsFor(fetchMock, '/api/conversation/chat-rename', { method: 'PATCH' })).toHaveLength(0)
    expect(wrapper.get('.conversation-rename-error').text()).toContain('不能为空')

    // 超过 80 字符同样本地拦下，不需要服务端返回 400。
    await renameInput.setValue('长'.repeat(MAX_CONVERSATION_NAME_LENGTH + 1))
    await wrapper.get('.conversation-rename-confirm').trigger('click')
    await flushPromises()
    expect(callsFor(fetchMock, '/api/conversation/chat-rename', { method: 'PATCH' })).toHaveLength(0)
    expect(wrapper.get('.conversation-rename-error').text()).toContain('80')

    await renameInput.setValue('  重命名后的会话  ')
    await wrapper.get('.conversation-rename-confirm').trigger('click')
    await flushPromises()

    const patchCalls = callsFor(fetchMock, '/api/conversation/chat-rename', { method: 'PATCH' })
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0]![0]).toBe('/api/conversation/chat-rename')
    // 只提交 PATCH /api/conversation/:id，且请求体是 trim 之后的名称。
    expect(JSON.parse(String(patchCalls[0]![1]?.body))).toEqual({ name: '重命名后的会话' })
    // 成功后列表项文案与页面标题同步更新（该会话正是当前激活会话）。
    expect(wrapper.get('.conversation-item .conversation-name').text()).toBe('重命名后的会话')
    expect(wrapper.get('.chat-header h1').text()).toBe('重命名后的会话')
    // 编辑态收回到普通列表项。
    expect(wrapper.find('.conversation-rename-input').exists()).toBe(false)
  })

  it('deletes a conversation through DELETE and returns to the new-chat state', async () => {
    const conversation = { id: 'chat-delete', name: '待删除会话', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [conversation],
      conversationDetails: {
        'chat-delete': {
          ...conversation,
          history: [{ role: 'user', content: '即将被删掉的历史' }],
        },
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.text()).toContain('即将被删掉的历史')

    // 破坏性操作先二次确认：此时还没有发出 DELETE。
    await findConversationItem(wrapper, '待删除会话').get('.conversation-menu-button').trigger('click')
    await wrapper.get('.conversation-menu-delete').trigger('click')
    expect(callsFor(fetchMock, '/api/conversation/chat-delete', { method: 'DELETE' })).toHaveLength(0)
    const popconfirm = wrapper.get('.conversation-delete-popconfirm')
    expect(popconfirm.attributes('role')).toBe('alertdialog')
    expect(popconfirm.text()).toContain('删除这个会话？')
    expect(popconfirm.text()).toContain('此操作无法撤销')
    expect(popconfirm.get('.conversation-delete-confirm').text()).toBe('确认删除')
    // 选中“删除会话”后菜单收起，确认浮层锚定显示，不再挤压列表项。
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)
    expect(findConversationItem(wrapper, '待删除会话').find('.conversation-delete-popconfirm').exists())
      .toBe(false)

    // 取消只关闭 Popconfirm，不产生破坏性请求；随后仍可再次打开并确认。
    await popconfirm.get('.conversation-delete-cancel').trigger('click')
    expect(wrapper.find('.conversation-delete-popconfirm').exists()).toBe(false)
    expect(callsFor(fetchMock, '/api/conversation/chat-delete', { method: 'DELETE' })).toHaveLength(0)
    await findConversationItem(wrapper, '待删除会话').get('.conversation-menu-button').trigger('click')
    await wrapper.get('.conversation-menu-delete').trigger('click')

    await wrapper.get('.conversation-delete-confirm').trigger('click')
    await flushPromises()

    const deleteCalls = callsFor(fetchMock, '/api/conversation/chat-delete', { method: 'DELETE' })
    expect(deleteCalls).toHaveLength(1)
    expect(deleteCalls[0]![0]).toBe('/api/conversation/chat-delete')

    // 会话从列表移除，侧边栏回到空态。
    expect(wrapper.find('.conversation-item').exists()).toBe(false)
    expect(wrapper.text()).toContain('还没有历史对话')

    // 删除的是当前激活会话：对话区回到“新对话”空态，输入框仍然可用。
    expect(wrapper.get('.chat-header h1').text()).toBe('新对话')
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('即将被删掉的历史')
    expect(wrapper.find('textarea').exists()).toBe(true)
    // 删除不触发额外的列表请求；已被删除的会话也不会因为缓存而复活。
    expect(callsFor(fetchMock, '/api/conversation/list')).toHaveLength(1)
  })

  it('grows the composer textarea with its content and stops at the maximum height', async () => {
    stubTextareaScrollHeight()
    const fetchMock = createFetchMock({
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-grow' },
        { type: 'message.completed', sessionId: 'chat-grow', content: '收到', reasoning: '' },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const textarea = wrapper.get('textarea')
    const element = textarea.element as HTMLTextAreaElement

    // 上下限由组件常量通过内联 max-height / resizeComposer 的 clamp 共同声明，两者同一来源。
    expect(element.style.maxHeight).toBe('320px')

    // 单行内容高度 24px 会被下限 56px 抬起：输入框永远不会矮于一行可读高度。
    await textarea.setValue('第一行')
    expect(element.style.height).toBe('56px')

    // 多行：超过下限后高度随内容向上增长。
    await textarea.setValue(Array.from({ length: 3 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
    expect(element.style.height).toBe('72px')

    // 12 行（288px）仍在区间内，继续随内容增长。
    await textarea.setValue(Array.from({ length: 12 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
    expect(element.style.height).toBe('288px')
    expect(element.style.overflowY).toBe('hidden')

    // 内容超过 320px 上限：高度被截断，改由输入框内部滚动。
    await textarea.setValue(Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
    expect(element.style.height).toBe('320px')
    expect(element.style.overflowY).toBe('auto')

    // 即使内容再多也不会超过上限。
    await textarea.setValue(Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
    expect(element.style.height).toBe('320px')
    expect(element.style.overflowY).toBe('auto')

    // 重新渲染（这里用切换模型触发）不能把算好的高度重置掉：内联 max-height 与
    // resizeComposer 写入的 height 是两个互不覆盖的属性。
    await wrapper.get('.model-select').setValue('deepseek-v4-pro')
    expect(element.style.height).toBe('320px')
    expect(element.style.maxHeight).toBe('320px')

    // 发送后内容清空，高度收回下限，不会留下一个撑开的大输入框。
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(element.style.height).toBe('56px')
    expect(element.style.overflowY).toBe('hidden')
    expect(wrapper.text()).toContain('收到')
  })

  it('resizes the composer with the keyboard handle and clamps between the height limits', async () => {
    stubTextareaScrollHeight()
    const fetchMock = createFetchMock({})
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const handle = wrapper.get('.composer-resize-handle')
    const element = wrapper.get('textarea').element as HTMLTextAreaElement

    // 把手是“调整相邻区域高度”的语义，而不是一个按钮。
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('aria-orientation')).toBe('horizontal')
    expect(handle.attributes('aria-label')).toBe('调整输入框高度')
    expect(handle.attributes('tabindex')).toBe('0')
    // 把手在输入框顶部（排在最前），拖动的是一条不显眼的抓取条。
    expect(wrapper.get('.composer').element.children[0]).toBe(handle.element)
    expect(handle.find('.composer-resize-grip').exists()).toBe(true)

    // 初始高度：单行内容 24px 被下限抬到 56px。
    expect(element.style.height).toBe('56px')

    // ArrowUp 增高 24px，ArrowDown 降低 24px。
    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(element.style.height).toBe('80px')
    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(element.style.height).toBe('104px')
    await handle.trigger('keydown', { key: 'ArrowDown' })
    expect(element.style.height).toBe('80px')

    // 连续按到边界：不会低于 56px。
    for (let index = 0; index < 12; index += 1)
      await handle.trigger('keydown', { key: 'ArrowDown' })
    expect(element.style.height).toBe('56px')

    // 连续按到边界：不会高于 320px。
    for (let index = 0; index < 20; index += 1)
      await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(element.style.height).toBe('320px')
    expect(element.style.maxHeight).toBe('320px')

    // 手动设定后它成为权威值：内容再多也不会把它顶高，改为在框内滚动。
    await wrapper.get('textarea').setValue(Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行`).join('\n'))
    expect(element.style.height).toBe('320px')
    expect(element.style.overflowY).toBe('auto')
    // 能向下拖矮——这正是"拖动设下限"实现里做不到的动作。
    await handle.trigger('keydown', { key: 'ArrowDown' })
    expect(element.style.height).toBe('296px')
    expect(element.style.overflowY).toBe('auto')
    // 内容变少时保持用户设定的高度，不回到单行。
    await wrapper.get('textarea').setValue('只剩一行')
    expect(element.style.height).toBe('296px')
    expect(element.style.overflowY).toBe('hidden')
  })

  it('keeps the height set by the resize handle after sending a message', async () => {
    stubTextareaScrollHeight()
    const fetchMock = createFetchMock({
      chat: [streamResponse([
        { type: 'session.started', sessionId: 'chat-manual-height' },
        { type: 'message.completed', sessionId: 'chat-manual-height', content: '已收到', reasoning: '' },
      ])],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const handle = wrapper.get('.composer-resize-handle')
    const element = wrapper.get('textarea').element as HTMLTextAreaElement

    // 用户用把手把输入框拖高一档：56 → 80 → 104。
    await handle.trigger('keydown', { key: 'ArrowUp' })
    await handle.trigger('keydown', { key: 'ArrowUp' })
    expect(element.style.height).toBe('104px')

    await wrapper.get('textarea').setValue('发送后要保留手动高度')
    expect(element.style.height).toBe('104px')

    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // 发送后只重置内容驱动的部分：用户手动调过的尺寸必须保留，而不是回到单行高度。
    expect(element.style.height).toBe('104px')
    expect(element.style.height).not.toBe('56px')
    expect(wrapper.text()).toContain('已收到')
  })

  it('drags the composer height from the top handle with pointer events', async () => {
    stubTextareaScrollHeight()
    const fetchMock = createFetchMock({})
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const handle = wrapper.get('.composer-resize-handle')
    const element = wrapper.get('textarea').element as HTMLTextAreaElement

    // 起始高度：单行内容 24px 被下限抬到 56px。
    expect(element.style.height).toBe('56px')

    // 向上拖 100px：新高度 = 起始高度 - (clientY 差) = 56 + 100。
    dispatchPointer(handle.element, 'pointerdown', { clientY: 300 })
    dispatchPointer(handle.element, 'pointermove', { clientY: 200 })
    expect(element.style.height).toBe('156px')

    // 继续向上拖超过上限：被 clamp 在 320px。
    dispatchPointer(handle.element, 'pointermove', { clientY: 0 })
    expect(element.style.height).toBe('320px')

    // 向下拖到底：被 clamp 在 56px，不会拖成负高度。
    dispatchPointer(handle.element, 'pointermove', { clientY: 600 })
    expect(element.style.height).toBe('56px')

    // pointerup 结束拖动后，同一次拖动的后续 pointermove 不再改变高度。
    dispatchPointer(handle.element, 'pointerup', { clientY: 600 })
    dispatchPointer(handle.element, 'pointermove', { clientY: 100 })
    expect(element.style.height).toBe('56px')

    // pointercancel 同样结束拖动；结束后新的拖动重新以当前高度为起点。
    dispatchPointer(handle.element, 'pointerdown', { clientY: 300 })
    dispatchPointer(handle.element, 'pointercancel', { clientY: 300 })
    dispatchPointer(handle.element, 'pointermove', { clientY: 100 })
    expect(element.style.height).toBe('56px')

    dispatchPointer(handle.element, 'pointerdown', { clientY: 300, pointerId: 2 })
    dispatchPointer(handle.element, 'pointermove', { clientY: 260, pointerId: 2 })
    expect(element.style.height).toBe('96px')
  })

  it('opens the conversation kebab menu, keeps one open at a time, and closes it on outside click or Escape', async () => {
    const first = { id: 'chat-menu-a', name: '菜单会话甲', createAt: String(Date.now()) }
    const second = { id: 'chat-menu-b', name: '菜单会话乙', createAt: String(Date.now() - 60_000) }
    const fetchMock = createFetchMock({
      conversations: [second, first],
      conversationDetails: {
        'chat-menu-a': { ...first, history: [{ role: 'user', content: '甲的历史' }] },
        'chat-menu-b': { ...second, history: [{ role: 'user', content: '乙的历史' }] },
      },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 挂载时自动打开最近一条（菜单会话甲）。
    expect(wrapper.text()).toContain('甲的历史')
    const itemA = findConversationItem(wrapper, '菜单会话甲')
    const kebabA = itemA.get('.conversation-menu-button')

    // kebab 在列表项右侧，是 .conversation-select 之后的操作入口；初始没有菜单。
    expect(itemA.find('.conversation-select').element.compareDocumentPosition(kebabA.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(itemA.element.children).toContain(kebabA.element)
    expect(kebabA.attributes('aria-label')).toBe('会话操作')
    expect(kebabA.attributes('aria-haspopup')).toBe('menu')
    expect(kebabA.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)

    await kebabA.trigger('click')

    const menu = wrapper.get('.conversation-menu')
    expect(menu.attributes('role')).toBe('menu')
    expect(kebabA.attributes('aria-expanded')).toBe('true')
    expect(itemA.classes()).toContain('menu-open')
    expect(menu.get('.conversation-menu-rename').text()).toBe('重命名会话')
    expect(menu.get('.conversation-menu-delete').text()).toBe('删除会话')
    expect(menu.get('.conversation-menu-rename').attributes('role')).toBe('menuitem')
    expect(menu.get('.conversation-menu-delete').attributes('role')).toBe('menuitem')
    // 点击 kebab 只开菜单，不会顺带切换会话。
    expect(wrapper.get('.chat-header h1').text()).toBe('菜单会话甲')
    expect(wrapper.text()).toContain('甲的历史')

    // 同一时间只允许一个菜单展开：打开乙的菜单后，甲的菜单关闭。
    await findConversationItem(wrapper, '菜单会话乙').get('.conversation-menu-button').trigger('click')
    expect(wrapper.findAll('.conversation-menu')).toHaveLength(1)
    expect(findConversationItem(wrapper, '菜单会话甲').find('.conversation-menu').exists()).toBe(false)
    expect(
      findConversationItem(wrapper, '菜单会话乙').find('.conversation-menu').exists(),
    ).toBe(true)

    // 点击菜单外部关闭。
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)

    // Esc 关闭。
    await kebabA.trigger('click')
    expect(wrapper.find('.conversation-menu').exists()).toBe(true)
    await itemA.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)

    // 再次打开后点击菜单项会关闭菜单（行为分别由重命名 / 删除用例覆盖）。
    await kebabA.trigger('click')
    await wrapper.get('.conversation-menu-rename').trigger('click')
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)
    expect(wrapper.find('.conversation-rename-input').exists()).toBe(true)
  })

  it('positions the kebab menu as a fixed layer and closes it on list scroll or resize', async () => {
    const conversation = { id: 'chat-menu-fixed', name: '固定菜单会话', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [conversation],
      conversationDetails: { 'chat-menu-fixed': { ...conversation, history: [] } },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const kebab = findConversationItem(wrapper, '固定菜单会话').get('.conversation-menu-button')
    await kebab.trigger('click')

    const menu = wrapper.get('.conversation-menu')
    const menuElement = menu.element as HTMLElement
    // fixed 定位才能脱离 .conversation-list / .conversation-sidebar 的 overflow 裁剪。
    expect(menuElement.style.position).toBe('fixed')
    // jsdom 的 rect 全为 0、视口固定 1024×768：
    // top = rect.bottom + 6 = 6；left = rect.right - 168 = -168，被左边界 8 夹住。
    expect(window.innerWidth).toBe(1024)
    expect(window.innerHeight).toBe(768)
    expect((kebab.element as HTMLElement).getBoundingClientRect().top).toBe(0)
    expect(menuElement.style.top).toBe('6px')
    expect(menuElement.style.left).toBe('8px')
    // 不再依赖旧的 right 偏移。
    expect(menuElement.style.right).toBe('')

    // fixed 菜单不会跟着列表滚动，因此列表一滚动就收起。
    await wrapper.get('.conversation-list').trigger('scroll')
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)
    // 关闭后坐标也要清空，避免下次打开先闪一下旧位置。
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)

    // 窗口尺寸变化同样收起菜单。
    await kebab.trigger('click')
    expect(wrapper.find('.conversation-menu').exists()).toBe(true)
    window.dispatchEvent(new Event('resize'))
    await nextTick()
    expect(wrapper.find('.conversation-menu').exists()).toBe(false)
  })

  it('restores the scroll position of a conversation when switching back to it', async () => {
    const older = { id: 'chat-scroll-older', name: '滚动会话甲', createAt: String(Date.now() - 60_000) }
    const newer = { id: 'chat-scroll-newer', name: '滚动会话乙', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [older, newer],
      conversationDetails: {
        'chat-scroll-older': {
          ...older,
          history: Array.from({ length: 6 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `甲的第 ${index + 1} 条`,
          })),
        },
        'chat-scroll-newer': { ...newer, history: [{ role: 'user', content: '乙的消息' }] },
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(ChatPage)
    await flushPromises()

    // 打开甲会话，然后按浏览器的做法给它装一个会真正生效的滚动位置。
    await findConversationItem(wrapper, '滚动会话甲').get('.conversation-select').trigger('click')
    await flushPromises()
    const listA = wrapper.get('.message-list').element as HTMLElement
    const scrollToA = stubScrollContainer(listA)

    // 用户滚到 120：scroll 事件让组件记住这个位置。
    listA.scrollTop = 120
    listA.dispatchEvent(new Event('scroll'))
    await nextTick()

    scrollToA.mockClear()

    // 切到乙再切回甲。
    await findConversationItem(wrapper, '滚动会话乙').get('.conversation-select').trigger('click')
    await flushPromises()
    await findConversationItem(wrapper, '滚动会话甲').get('.conversation-select').trigger('click')
    await flushPromises()

    // 关键断言：位置被显式恢复成离开时的像素值。
    expect(wrapper.get('.message-list').element).toBe(listA)
    expect(listA.scrollTop).toBe(120)
    // 而且这次激活里只发生了一次滚动——恢复位置；没有"跟随到底"
    // （跟到底会把 top 写成 scrollHeight，jsdom 里是 0，数值断言就会变成 0）。
    expect(scrollToA).toHaveBeenCalledTimes(1)
    expect(scrollToA).toHaveBeenCalledWith({ top: 120, behavior: 'auto' })

    // 贴底离开的情况：保存的就是底部像素值，恢复后仍然贴底。
    listA.scrollTop = 860
    listA.dispatchEvent(new Event('scroll'))
    await nextTick()
    await findConversationItem(wrapper, '滚动会话乙').get('.conversation-select').trigger('click')
    await flushPromises()
    await findConversationItem(wrapper, '滚动会话甲').get('.conversation-select').trigger('click')
    await flushPromises()
    expect(listA.scrollTop).toBe(860)
  })

  it('keeps the conversation view alive across switches without following to the bottom', async () => {
    const older = { id: 'chat-keep-older', name: '缓存会话甲', createAt: String(Date.now() - 60_000) }
    const newer = { id: 'chat-keep-newer', name: '缓存会话乙', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [older, newer],
      conversationDetails: {
        'chat-keep-older': {
          ...older,
          history: [
            { role: 'user', content: '甲的旧消息' },
            { role: 'assistant', content: '甲的回答', reasoning_content: '甲的思考过程' },
          ],
        },
        'chat-keep-newer': { ...newer, history: [{ role: 'user', content: '乙的旧消息' }] },
      },
    })
    vi.stubGlobal('fetch', fetchMock)

    const wrapper = mount(ChatPage)
    await flushPromises()
    // 挂载时自动打开最近一条（缓存会话乙），首次挂载会落到最新一条消息。
    expect(wrapper.text()).toContain('乙的旧消息')

    // 先各自打开一次，让两个会话都完成首次挂载。
    await findConversationItem(wrapper, '缓存会话甲').get('.conversation-select').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('甲的旧消息')

    // 展开甲会话里的思考面板：这个展开状态属于消息对象，切换会话后应当仍在。
    expect(wrapper.text()).not.toContain('甲的思考过程')
    await wrapper.get('.reasoning-toggle').trigger('click')
    expect(wrapper.text()).toContain('甲的思考过程')

    // 甲滚到 120（会生效的桩），随后清空记录进入"来回切换"阶段。
    const listA = wrapper.get('.message-list').element as HTMLElement
    const scrollToA = stubScrollContainer(listA)
    listA.scrollTop = 120
    listA.dispatchEvent(new Event('scroll'))
    await nextTick()

    const rowA = wrapper.get('.message-row').element
    const contentA = wrapper.get('.message-content').element
    scrollToA.mockClear()

    await findConversationItem(wrapper, '缓存会话乙').get('.conversation-select').trigger('click')
    await flushPromises()
    await findConversationItem(wrapper, '缓存会话甲').get('.conversation-select').trigger('click')
    await flushPromises()
    await findConversationItem(wrapper, '缓存会话乙').get('.conversation-select').trigger('click')
    await flushPromises()
    await findConversationItem(wrapper, '缓存会话甲').get('.conversation-select').trigger('click')
    await flushPromises()

    // 切回旧会话：实例与 DOM 都是原来那一个，消息行也没被重建。
    expect(wrapper.text()).toContain('甲的旧消息')
    expect(wrapper.get('.message-list').element).toBe(listA)
    expect(wrapper.get('.message-content').element).toBe(contentA)
    expect(wrapper.get('.message-row').element).toBe(rowA)
    // 消息对象被复用，思考面板的展开状态因此没丢。
    expect(wrapper.text()).toContain('甲的思考过程')

    // 两次切回甲各自恢复一次位置，值始终是 120：没有任何一次是"跟随到底"
    // （跟到底会调用 scrollTo({ top: scrollHeight })，jsdom 里 scrollHeight 为 0）。
    expect(scrollToA).toHaveBeenCalledTimes(2)
    expect(scrollToA.mock.calls.every(call => call[0]?.top === 120)).toBe(true)
    expect(listA.scrollTop).toBe(120)

    // 切换过程中被替换掉的另一个会话的 DOM 不在当前树里（KeepAlive 把它移出去了）。
    expect(wrapper.findAll('.message-list')).toHaveLength(1)
  })

  it('shows the first message of a draft conversation before it has a session id', async () => {
    const stream = controlledStreamResponse([])
    const fetchMock = createFetchMock({ chat: [stream.response] })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 还没有任何会话：空状态由页面渲染。
    expect(wrapper.find('.empty-state').exists()).toBe(true)
    expect(wrapper.find('.message-list').exists()).toBe(false)

    await wrapper.get('textarea').setValue('第一条消息')
    await wrapper.get('form').trigger('submit')
    await flushPromises()

    // 服务端还没给出 sessionId，但用户自己的消息必须立刻可见（草稿会话）。
    expect(wrapper.get('.message-list').text()).toContain('第一条消息')
    expect(wrapper.find('.empty-state').exists()).toBe(false)

    stream.push({ type: 'session.started', sessionId: 'chat-draft' })
    stream.push({
      type: 'message.completed',
      sessionId: 'chat-draft',
      content: '草稿会话的回答',
      reasoning: '',
    })
    stream.close()
    await flushPromises()

    expect(wrapper.text()).toContain('第一条消息')
    expect(wrapper.text()).toContain('草稿会话的回答')
    // 会话建立后消息区仍然只有一个实例。
    expect(wrapper.findAll('.message-list')).toHaveLength(1)
  })

  it('still follows the latest message when the conversation content grows', async () => {
    const conversation = { id: 'chat-follow', name: '跟随会话', createAt: String(Date.now()) }
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: 'chat-follow' },
    ])
    const fetchMock = createFetchMock({
      conversations: [conversation],
      conversationDetails: { 'chat-follow': { ...conversation, history: [{ role: 'user', content: '已有历史' }] } },
      chat: [stream.response],
    })
    vi.stubGlobal('fetch', fetchMock)

    const scrollToSpy = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollToSpy,
    })

    const wrapper = mount(ChatPage)
    await flushPromises()
    scrollToSpy.mockClear()

    // 新消息：用户消息入列即跟随到底。
    await wrapper.get('textarea').setValue('新增一条提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(scrollToSpy).toHaveBeenCalledTimes(1)

    // 流式增量：同一条助手消息内容增长也要跟随到底。
    scrollToSpy.mockClear()
    stream.push({
      type: 'message.delta',
      sessionId: 'chat-follow',
      channel: 'content',
      delta: '第一段',
    })
    await flushPromises()
    expect(scrollToSpy).toHaveBeenCalledTimes(1)

    scrollToSpy.mockClear()
    stream.push({
      type: 'message.delta',
      sessionId: 'chat-follow',
      channel: 'content',
      delta: '第二段',
    })
    await flushPromises()
    expect(scrollToSpy).toHaveBeenCalledTimes(1)

    stream.push({
      type: 'message.completed',
      sessionId: 'chat-follow',
      content: '第一段第二段',
      reasoning: '',
    })
    stream.close()
    await flushPromises()
    expect(wrapper.text()).toContain('第一段第二段')
  })

  it('renders one navigation bar per turn and not for a single-turn conversation', async () => {
    // 单轮的会话：导航不渲染。
    const single = { id: 'chat-one-turn', name: '单轮会话', createAt: String(Date.now()) }
    const oneTurnMock = createFetchMock({
      conversations: [single],
      conversationDetails: {
        'chat-one-turn': {
          ...single,
          history: [
            { role: 'user', content: '只问一次' },
            { role: 'assistant', content: '只答一次' },
          ],
        },
      },
    })
    vi.stubGlobal('fetch', oneTurnMock)
    const singleWrapper = mount(ChatPage)
    await flushPromises()
    expect(singleWrapper.text()).toContain('只问一次')
    expect(singleWrapper.find('.turn-nav').exists()).toBe(false)
    expect(singleWrapper.findAll('.turn-nav-item')).toHaveLength(0)

    // 两轮的会话：两条导航，文案与轮次标题一致。
    const fetchMock = createFetchMock({
      conversations: [{ id: twoTurnDetail.id, name: twoTurnDetail.name, createAt: twoTurnDetail.createAt }],
      conversationDetails: { [twoTurnDetail.id]: twoTurnDetail },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const nav = wrapper.get('.turn-nav')
    expect(nav.attributes('aria-label')).toBe('对话导航')
    const items = wrapper.findAll('.turn-nav-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.attributes('aria-label')).toBe('第一轮提问')
    expect(items[1]!.attributes('aria-label')).toBe('第二轮提问')
    // 每条内部都是一个小条。
    expect(items[0]!.find('.turn-nav-bar').exists()).toBe(true)
  })

  it('keeps one navigation bar per turn while the current turn streams', async () => {
    const stream = controlledStreamResponse([
      { type: 'session.started', sessionId: twoTurnDetail.id },
    ])
    const fetchMock = createFetchMock({
      conversations: [{ id: twoTurnDetail.id, name: twoTurnDetail.name, createAt: twoTurnDetail.createAt }],
      conversationDetails: { [twoTurnDetail.id]: twoTurnDetail },
      chat: [stream.response],
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    expect(wrapper.findAll('.turn-nav-item')).toHaveLength(2)

    // 发第三轮：用户消息一入列就多出第三条，流式回答不会再多加。
    await wrapper.get('textarea').setValue('第三轮提问')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(wrapper.findAll('.turn-nav-item')).toHaveLength(3)
    expect(wrapper.findAll('.turn-nav-item')[2]!.attributes('aria-label')).toBe('第三轮提问')

    stream.push({
      type: 'message.delta',
      sessionId: twoTurnDetail.id,
      channel: 'content',
      delta: '第三轮',
    })
    await flushPromises()
    expect(wrapper.findAll('.turn-nav-item')).toHaveLength(3)

    stream.push({
      type: 'message.completed',
      sessionId: twoTurnDetail.id,
      content: '第三轮回答',
      reasoning: '',
    })
    stream.close()
    await flushPromises()
    // 助手回答属于当前轮，不会新增导航条。
    expect(wrapper.findAll('.turn-nav-item')).toHaveLength(3)
  })

  it('scrolls to the first row of a turn when its navigation bar is clicked', async () => {
    const fetchMock = createFetchMock({
      conversations: [{ id: twoTurnDetail.id, name: twoTurnDetail.name, createAt: twoTurnDetail.createAt }],
      conversationDetails: { [twoTurnDetail.id]: twoTurnDetail },
    })
    vi.stubGlobal('fetch', fetchMock)
    const scrollIntoView = stubScrollIntoView()
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 四行消息：两轮的 user + agent 各一行；第二轮的首行是下标 2。
    const rows = wrapper.findAll('.message-row')
    expect(rows).toHaveLength(4)
    expect(rows[2]!.text()).toContain('第二轮提问')

    const items = wrapper.findAll('.turn-nav-item')
    await items[1]!.trigger('click')

    expect(scrollIntoView.calls).toHaveLength(1)
    expect(scrollIntoView.calls[0]!.element).toBe(rows[2]!.element)
    // 即时定位（behavior: 'auto'），不做平滑滚动。
    expect(scrollIntoView.calls[0]!.options).toEqual({ block: 'start', behavior: 'auto' })

    // 点击第一轮则定位到第一行。
    await items[0]!.trigger('click')
    expect(scrollIntoView.calls).toHaveLength(2)
    expect(scrollIntoView.calls[1]!.element).toBe(rows[0]!.element)
  })

  it('shows the turn title while hovering a navigation bar', async () => {
    const fetchMock = createFetchMock({
      conversations: [{ id: twoTurnDetail.id, name: twoTurnDetail.name, createAt: twoTurnDetail.createAt }],
      conversationDetails: { [twoTurnDetail.id]: twoTurnDetail },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 初始不渲染任何标题（只渲染小条）。
    expect(wrapper.find('.turn-nav-label').exists()).toBe(false)

    const items = wrapper.findAll('.turn-nav-item')
    await items[1]!.trigger('mouseenter')
    expect(wrapper.findAll('.turn-nav-label')).toHaveLength(1)
    expect(items[1]!.get('.turn-nav-label').text()).toBe('第二轮提问')
    // 第一条没有标题，说明标题属于被悬浮的那一条。
    expect(items[0]!.find('.turn-nav-label').exists()).toBe(false)

    await items[1]!.trigger('mouseleave')
    expect(wrapper.find('.turn-nav-label').exists()).toBe(false)

    // 键盘聚焦同样能看到标题。
    await items[0]!.trigger('focus')
    expect(items[0]!.get('.turn-nav-label').text()).toBe('第一轮提问')
    await items[0]!.trigger('blur')
    expect(wrapper.find('.turn-nav-label').exists()).toBe(false)
  })

  it('highlights the turn that occupies the top of the viewport while scrolling', async () => {
    const fetchMock = createFetchMock({
      conversations: [{ id: twoTurnDetail.id, name: twoTurnDetail.name, createAt: twoTurnDetail.createAt }],
      conversationDetails: { [twoTurnDetail.id]: twoTurnDetail },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    const list = wrapper.get('.message-list').element as HTMLElement
    stubScrollContainer(list)
    const rows = wrapper.findAll('.message-row')
    // 给每一轮的首行一个确定的 offsetTop（jsdom 没有布局，默认全是 0）。
    stubOffsetTop(rows[0]!.element, 0)
    stubOffsetTop(rows[2]!.element, 300)

    const items = wrapper.findAll('.turn-nav-item')
    // 滚到顶部：第一轮高亮（高亮由滚动事件驱动，所以显式派发一次）。
    list.scrollTop = 0
    list.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(items[0]!.classes()).toContain('active')
    expect(items[1]!.classes()).not.toContain('active')

    // 滚到 320：第二轮的首行（300）已经越过视口顶部。
    list.scrollTop = 320
    list.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(items[1]!.classes()).toContain('active')
    expect(items[0]!.classes()).not.toContain('active')
    expect(items[1]!.attributes('aria-current')).toBe('true')

    // 滚回 10：又回到第一轮。
    list.scrollTop = 10
    list.dispatchEvent(new Event('scroll'))
    await nextTick()
    expect(items[0]!.classes()).toContain('active')
    expect(items[1]!.classes()).not.toContain('active')
    expect(items[1]!.attributes('aria-current')).toBeUndefined()
  })

  it('does not render the navigation for a conversation without messages', async () => {
    const empty = { id: 'chat-empty-history', name: '空会话', createAt: String(Date.now()) }
    const fetchMock = createFetchMock({
      conversations: [empty],
      conversationDetails: { 'chat-empty-history': { ...empty, history: [] } },
    })
    vi.stubGlobal('fetch', fetchMock)
    const wrapper = mount(ChatPage)
    await flushPromises()

    // 会话已激活（组件渲染空状态），但没有任何消息 → 没有可导航的轮次。
    expect(wrapper.find('.message-list').exists()).toBe(true)
    expect(wrapper.find('.turn-nav').exists()).toBe(false)
  })
})

describe('conversation turn helpers', () => {
  it('resolves the active turn from row offsets and the current scroll offset', () => {
    // 没有任何轮次时固定返回 0，避免导航高亮越界。
    expect(resolveActiveTurnIndex([], 0)).toBe(0)
    expect(resolveActiveTurnIndex([], 500)).toBe(0)
    // 第一个 offsetTop 就是 0：还没滚动时属于第一轮。
    expect(resolveActiveTurnIndex([0, 300, 640], 0)).toBe(0)
    expect(resolveActiveTurnIndex([0, 300, 640], 299)).toBe(0)
    // 到达某一轮首行的位置就算进入那一轮。
    expect(resolveActiveTurnIndex([0, 300, 640], 300)).toBe(1)
    expect(resolveActiveTurnIndex([0, 300, 640], 639)).toBe(1)
    expect(resolveActiveTurnIndex([0, 300, 640], 640)).toBe(2)
    // 滚到底时仍然是最后一轮。
    expect(resolveActiveTurnIndex([0, 300, 640], 99_999)).toBe(2)
  })

  it('summarizes a turn title by folding whitespace and truncating long text', () => {
    expect(summarizeTurnTitle('  第一行\n第二行  ')).toBe('第一行 第二行')
    expect(summarizeTurnTitle('短问题')).toBe('短问题')
    expect(summarizeTurnTitle('   ')).toBe(EMPTY_TURN_TITLE)

    const long = '这是一个很长的提问'.repeat(10)
    const title = summarizeTurnTitle(long)
    // 截断到上限并带上省略号。
    expect(title).toHaveLength(TURN_TITLE_MAX_LENGTH + 1)
    expect(title.endsWith('…')).toBe(true)
    expect(long.startsWith(title.slice(0, -1))).toBe(true)
  })
})
