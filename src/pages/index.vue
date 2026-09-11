<script setup lang="ts">
import type { AgentOutputEvent, AgentRunResult } from '../craft-agent'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineOptions({ name: 'IndexPage' })

interface Message {
  id: number
  role: 'user' | 'agent'
  content: string
  reasoning?: string
  isReasoningOpen?: boolean
  isStreaming?: boolean
}

interface HistoryMessage {
  role: string
  content?: unknown
  reasoning_content?: unknown
}

interface ConversationSummary {
  id: string
  name: string
  createAt: string
}

interface ConversationDetail extends ConversationSummary {
  history: HistoryMessage[]
  displayHistory?: HistoryMessage[]
}

/**
 * 聊天页面消费 CraftAgent 标准 AgentOutputEvent，以及 Server 自身的传输错误。
 *
 * Server 默认直接输出这些事件；页面不消费完整 AgentEvent，避免与调试轨迹和 Agent 内部
 * ApprovalManager 耦合。
 */
type ChatStreamEvent
  = AgentOutputEvent
    | { type: 'server.error', message: string }

/** 当前 Composer 展示的工具权限交互；每个 Agent Run 同一时间只会等待一个工具。 */
interface ToolInteraction {
  kind: 'approval' | 'denied'
  approvalId?: string
  callId: string
  toolName: string
  reason: string
  title?: string
  details?: Record<string, unknown>
  input?: unknown
  risk?: 'safe' | 'read' | 'write' | 'destructive'
  expiresAt?: string | null
  status: 'pending' | 'submitting' | 'allowed' | 'denied' | 'expired' | 'aborted' | 'policy-denied'
}

interface ConversationListResponse {
  data: ConversationSummary[]
}

interface ConversationDetailResponse {
  data: ConversationDetail
}

/**
 * 页面真正消费的模型词汇表，来自 GET /api/model。
 *
 * 等级名由部署决定，不同模型适配器的取值并不一致，因此页面只消费服务端给出的列表，
 * 不再硬编码任何一家的等级集合。
 */
interface ModelVocabulary {
  /** 部署默认推理等级；服务端未设置时为空串，表示不表达偏好。 */
  defaultEffort: string
  /** 部署允许的推理等级；为空表示词汇表不可用，控件退化为自由文本。 */
  efforts: string[]
}

/** 非流式 /api/chat 的普通 JSON 响应。 */
interface ChatJsonResponse {
  data: AgentRunResult
}

const messages = ref<Message[]>([])
const conversations = ref<ConversationSummary[]>([])
const input = ref('')
const conversationId = ref('')
const isSending = ref(false)
const isAwaitingFirstToken = ref(false)
const isLoadingConversations = ref(false)
const isSidebarOpen = ref(false)
const errorMessage = ref('')
const conversationError = ref('')
const failedPrompt = ref('')
// 模型选项由用户显式控制，并随每次 Agent 请求发送，不会通过自然语言推断。
const useStreaming = ref(true)
// 推理等级是单个字符串：'off' 表示显式关闭，其余值是部署自定义等级；空串表示省略该字段，
// 交由部署默认决定。请求体不再有 model 对象，也不再有独立的“启用思考”开关。
const reasoningEffort = ref('')
// 部署允许的推理等级，挂载时从 GET /api/model 读取；空列表表示词汇表不可用，控件退化为自由文本。
const reasoningEfforts = ref<string[]>([])
// undefined 表示普通 Composer；有值时由状态决定展示审批卡片或自动拒绝卡片。
const toolInteraction = ref<ToolInteraction>()
// 审批 POST 失败只影响卡片提交，可恢复 pending 后重试，不应中断原聊天 SSE。
const approvalError = ref('')
const approvalRemainingSeconds = ref<number>()
const messageList = ref<HTMLElement>()
let nextMessageId = 1
let approvalCountdown: ReturnType<typeof setInterval> | undefined

// 模型输出是不可信文本：关闭原始 HTML，只允许 markdown-it 生成受控标签。
const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
})

/** 将助手回复转换为 HTML；原始 HTML 会被转义，不会作为页面节点执行。 */
function renderMarkdown(content: string): string {
  return markdown.render(content)
}

const displayedConversations = computed(() => [...conversations.value].reverse())
const activeConversation = computed(() => (
  conversations.value.find(conversation => conversation.id === conversationId.value)
))
const pageTitle = computed(() => activeConversation.value?.name?.trim() || '新对话')

/** 兼容字符串和 OpenAI 内容分片数组，只提取可展示的文本部分。 */
function getContentText(content: unknown): string {
  if (typeof content === 'string')
    return content

  if (!Array.isArray(content))
    return ''

  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null || !('text' in part))
        return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/** 将服务端历史记录转换为页面消息，并过滤 system/tool 等内部上下文。 */
function historyToMessages(history: HistoryMessage[]): Message[] {
  return history.flatMap((item) => {
    if (item.role !== 'user' && item.role !== 'assistant')
      return []

    const content = getContentText(item.content).trim()
    const reasoning = typeof item.reasoning_content === 'string'
      ? item.reasoning_content.trim()
      : ''
    if (!content)
      return []

    return [{
      id: nextMessageId++,
      role: item.role === 'user' ? 'user' : 'agent',
      content,
      ...(item.role === 'assistant' && reasoning
        ? { reasoning, isReasoningOpen: false }
        : {}),
    } satisfies Message]
  })
}

/** 校验会话目录项；列表接口不要求携带完整历史。 */
function isConversationSummary(value: unknown): value is ConversationSummary {
  if (typeof value !== 'object' || value === null)
    return false

  const item = value as Partial<ConversationSummary>
  return typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.createAt === 'string'
}

/** 校验按需读取的会话详情，避免异常历史破坏页面状态。 */
function isConversationDetail(value: unknown): value is ConversationDetail {
  return isConversationSummary(value)
    && Array.isArray((value as Partial<ConversationDetail>).history)
}

/** 兼容 ISO 时间和旧版逗号分隔时间戳，并格式化为列表中的简短时间。 */
function formatConversationDate(value: string): string {
  const numericTimestamp = Number(value.replaceAll(',', ''))
  const date = Number.isFinite(numericTimestamp) && numericTimestamp > 1_000_000_000_000
    ? new Date(numericTimestamp)
    : new Date(value)

  if (Number.isNaN(date.getTime()))
    return value

  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/**
 * 从 GET /api/model 的未知 JSON 中提取词汇表。
 *
 * 任一字段缺失或类型不符都退化为空值，而不是抛错：词汇表只是便利信息，
 * 服务端多返回或少返回字段都不应该让页面进入不可用状态。
 */
function readModelVocabulary(value: unknown): ModelVocabulary {
  if (typeof value !== 'object' || value === null)
    return { defaultEffort: '', efforts: [] }

  const data = value as { reasoningEffort?: unknown, reasoningEfforts?: unknown }
  const defaultEffort = typeof data.reasoningEffort === 'string'
    ? data.reasoningEffort.trim()
    : ''
  const efforts = Array.isArray(data.reasoningEfforts)
    ? (data.reasoningEfforts as unknown[])
        .filter((level): level is string => typeof level === 'string' && level.trim() !== '')
        .map(level => level.trim())
    : []

  // 部署默认必须始终可选：服务端是最终权威，UI 不能因为词汇表缺项就悄悄改写它的默认值。
  if (defaultEffort && !efforts.includes(defaultEffort))
    efforts.unshift(defaultEffort)

  return { defaultEffort, efforts }
}

/** 'off' 是协议保留值，裸英文对用户不友好；其余等级名由部署定义，原样展示。 */
function formatReasoningEffort(level: string): string {
  return level === 'off' ? '不推理（off）' : level
}

/** 等待 DOM 更新后滚动到底部，确保新消息已参与高度计算。 */
async function scrollToLatest(behavior: ScrollBehavior = 'smooth') {
  await nextTick()
  messageList.value?.scrollTo({
    top: messageList.value.scrollHeight,
    behavior,
  })
}

/** 切换会话时按 ID 加载详情，避免列表请求一次读取所有历史。 */
async function selectConversation(conversation: ConversationSummary) {
  if (isSending.value)
    return

  try {
    const response = await fetch(`/api/conversation/${encodeURIComponent(conversation.id)}`)
    if (!response.ok)
      throw new Error(`会话详情加载失败（${response.status}）`)

    const result = await response.json() as Partial<ConversationDetailResponse>
    if (!isConversationDetail(result.data))
      throw new TypeError('会话详情返回格式不正确')

    conversationId.value = conversation.id
    messages.value = historyToMessages(result.data.displayHistory ?? result.data.history)
    input.value = ''
    errorMessage.value = ''
    failedPrompt.value = ''
    isSidebarOpen.value = false
    void scrollToLatest('auto')
  }
  catch (error) {
    conversationError.value = error instanceof Error ? error.message : '会话详情加载失败'
  }
}

/** 清空当前上下文；下一次发送时不携带 ID，由后端创建新会话。 */
function startNewConversation() {
  if (isSending.value)
    return

  conversationId.value = ''
  messages.value = []
  input.value = ''
  errorMessage.value = ''
  failedPrompt.value = ''
  isSidebarOpen.value = false
}

/** 刷新会话列表；首次进入页面时默认打开最近一条会话。 */
async function loadConversations(selectInitial = false) {
  isLoadingConversations.value = true
  conversationError.value = ''

  try {
    const response = await fetch('/api/conversation/list')
    if (!response.ok)
      throw new Error(`会话列表加载失败（${response.status}）`)

    const result = await response.json() as Partial<ConversationListResponse>
    if (!Array.isArray(result.data))
      throw new TypeError('会话列表返回格式不正确')

    conversations.value = result.data.filter(isConversationSummary)

    if (selectInitial && !conversationId.value && displayedConversations.value[0])
      await selectConversation(displayedConversations.value[0])
  }
  catch (error) {
    conversationError.value = error instanceof Error ? error.message : '会话列表加载失败'
  }
  finally {
    isLoadingConversations.value = false
  }
}

/**
 * 读取部署的模型词汇表，用它渲染推理等级控件。
 *
 * 等级名因部署而异，所以控件选项只能来自服务端；加载失败时保持空列表并由自由文本输入兜底，
 * 不展示阻塞性错误，因为词汇表只是便利信息，不是发消息的前提。
 */
async function loadModelVocabulary() {
  try {
    const response = await fetch('/api/model')
    if (!response.ok)
      return

    const payload: unknown = await response.json()
    const data = typeof payload === 'object' && payload !== null && 'data' in payload
      ? (payload as { data?: unknown }).data
      : undefined
    const vocabulary = readModelVocabulary(data)

    reasoningEfforts.value = vocabulary.efforts
    reasoningEffort.value = vocabulary.defaultEffort
  }
  catch {
    // 词汇表请求失败：保持空列表，用户仍可用自由文本输入任意等级，页面继续正常工作。
    reasoningEfforts.value = []
  }
}

/** 校验从 SSE 解析出的未知 JSON，收窄为页面支持的事件联合类型。 */
function isChatStreamEvent(value: unknown): value is ChatStreamEvent {
  if (typeof value !== 'object' || value === null || !('type' in value))
    return false

  const event = value as Record<string, unknown>
  if (event.type === 'session.started')
    return typeof event.sessionId === 'string'
  if (event.type === 'message.delta') {
    return typeof event.sessionId === 'string'
      && (event.channel === 'reasoning' || event.channel === 'content')
      && typeof event.delta === 'string'
  }
  if (event.type === 'message.completed') {
    return typeof event.sessionId === 'string'
      && typeof event.content === 'string'
      && typeof event.reasoning === 'string'
  }
  if (event.type === 'tool.approval.requested') {
    // input 本身允许任意 JSON 形状，其余关联字段必须完整，避免渲染无法提交的卡片。
    const validTimeout = event.approvalTimeoutMs === -1
      ? event.expiresAt === null
      : Number.isSafeInteger(event.approvalTimeoutMs)
        && Number(event.approvalTimeoutMs) > 0
        && typeof event.expiresAt === 'string'
    return typeof event.sessionId === 'string'
      && typeof event.runId === 'string'
      && typeof event.approvalId === 'string'
      && typeof event.callId === 'string'
      && typeof event.toolName === 'string'
      && typeof event.reason === 'string'
      && (event.title === undefined || typeof event.title === 'string')
      && (event.details === undefined
        || (typeof event.details === 'object'
          && event.details !== null
          && !Array.isArray(event.details)))
        && validTimeout
        && typeof event.requestedAt === 'string'
        && typeof event.toolMetadata === 'object'
        && event.toolMetadata !== null
        && !Array.isArray(event.toolMetadata)
  }
  if (event.type === 'tool.approval.resolved') {
    return typeof event.sessionId === 'string'
      && typeof event.runId === 'string'
      && typeof event.approvalId === 'string'
      && typeof event.callId === 'string'
      && typeof event.toolName === 'string'
      && typeof event.resolvedAt === 'string'
      && (event.outcome === 'allowed'
        || event.outcome === 'denied'
        || event.outcome === 'expired'
        || event.outcome === 'aborted')
  }
  if (event.type === 'tool.guard.denied') {
    return typeof event.sessionId === 'string'
      && typeof event.runId === 'string'
      && typeof event.callId === 'string'
      && typeof event.toolName === 'string'
      && typeof event.reason === 'string'
  }
  if (event.type === 'error') {
    return typeof event.sessionId === 'string'
      && typeof event.message === 'string'
      && typeof event.code === 'string'
      && typeof event.stopReason === 'string'
  }
  if (event.type === 'server.error')
    return typeof event.message === 'string'
  return false
}

/** 把未知工具参数安全格式化为只读预览，序列化失败时不影响用户作出决定。 */
function formatToolInput(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  }
  catch {
    return '[参数无法序列化]'
  }
}

/** 把协议状态转换为用户可理解的短文本。 */
function getToolInteractionStatus(status: ToolInteraction['status']): string {
  const labels: Record<ToolInteraction['status'], string> = {
    'pending': '等待你的决定',
    'submitting': '正在提交决定…',
    'allowed': '已仅本次允许，正在执行工具…',
    'denied': '你已拒绝，Agent 正在调整回答…',
    'expired': '审批已超时，Agent 正在调整回答…',
    'aborted': '本次审批已取消',
    'policy-denied': '安全策略已自动拒绝，Agent 正在调整回答…',
  }
  const remaining = approvalRemainingSeconds.value
  if ((status === 'pending' || status === 'submitting')
    && toolInteraction.value?.expiresAt === null) {
    return `${labels[status]} · 无过期时间`
  }
  if ((status === 'pending' || status === 'submitting') && remaining !== undefined)
    return `${labels[status]} · 剩余 ${formatRemainingTime(remaining)}`
  return labels[status]
}

/** 向 Server 提交一次性审批决定，最终状态仍以 SSE resolved 事件为准。 */
async function decideToolApproval(decision: 'allow' | 'deny'): Promise<void> {
  const interaction = toolInteraction.value
  // 只允许 pending 状态提交；这同时防止双击和 resolved 后重复使用 approvalId。
  if (!interaction?.approvalId || interaction.status !== 'pending')
    return

  approvalError.value = ''
  interaction.status = 'submitting'
  try {
    const response = await fetch(
      `/api/tool-approvals/${encodeURIComponent(interaction.approvalId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      },
    )
    if (!response.ok)
      throw new Error(`审批提交失败（${response.status}）`)
    // HTTP 成功只表示 Agent 接受决定；保持 submitting，等待 SSE resolved 成为页面事实。
  }
  catch (error) {
    interaction.status = 'pending'
    approvalError.value = error instanceof Error ? error.message : '审批提交失败'
  }
}

/** 根据 Agent 给出的绝对过期时间启动倒计时，避免网络延迟导致本地计时偏晚。 */
function startApprovalCountdown(expiresAt: string | null): void {
  stopApprovalCountdown()
  if (expiresAt === null)
    return
  const expiresAtMs = Date.parse(expiresAt)
  if (!Number.isFinite(expiresAtMs))
    return

  /** 以秒为单位刷新；真正是否过期仍由 Agent ApprovalManager 决定。 */
  const update = (): void => {
    approvalRemainingSeconds.value = Math.max(
      0,
      Math.ceil((expiresAtMs - Date.now()) / 1_000),
    )
  }
  update()
  approvalCountdown = setInterval(update, 1_000)
}

/** 清理当前审批倒计时，避免切换 Run 后旧定时器继续更新页面。 */
function stopApprovalCountdown(): void {
  if (approvalCountdown)
    clearInterval(approvalCountdown)
  approvalCountdown = undefined
  approvalRemainingSeconds.value = undefined
}

/** 把剩余秒数格式化为 mm:ss。 */
function formatRemainingTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * 持续读取 POST 请求返回的 SSE。网络 chunk 与 SSE 事件边界并不一致，
 * 因此必须保留最后一个不完整帧，与下一次读取的数据拼接后再解析。
 */
async function readEventStream(
  response: Response,
  onEvent: (event: ChatStreamEvent) => void,
) {
  if (!response.body)
    throw new Error('当前浏览器不支持流式响应')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  /** 合并一个 SSE 帧内可能存在的多行 data 字段，并解析为业务事件。 */
  function processFrame(frame: string) {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data)
      return

    const event: unknown = JSON.parse(data)
    if (!isChatStreamEvent(event))
      throw new Error('服务端返回了无法识别的流事件')
    onEvent(event)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      // stream 模式会保留被 chunk 截断的多字节 UTF-8 字符，避免中文乱码。
      buffer += decoder.decode(value, { stream: !done })

      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() ?? ''
      for (const frame of frames)
        processFrame(frame)

      if (done)
        break
    }

    if (buffer.trim())
      processFrame(buffer)
  }
  catch (error) {
    await reader.cancel()
    throw error
  }
  finally {
    reader.releaseLock()
  }
}

/**
 * 发送消息并把不同频道的增量追加到同一条助手消息；重试时可选择不重复插入用户消息。
 * 新会话请求刻意省略 conversationId，收到 session.started 后再保存 Agent 生成的 ID。
 */
async function send(prompt = input.value, appendUserMessage = true) {
  const message = prompt.trim()
  if (!message || isSending.value)
    return

  errorMessage.value = ''
  failedPrompt.value = ''
  toolInteraction.value = undefined
  approvalError.value = ''
  stopApprovalCountdown()

  if (appendUserMessage) {
    messages.value.push({ id: nextMessageId++, role: 'user', content: message })
    input.value = ''
    await scrollToLatest()
  }

  isSending.value = true
  isAwaitingFirstToken.value = true
  // 锁定本次请求设置；即使以后允许发送期间操作 UI，也不能改变正在执行的 Run。
  const requestUsesStreaming = useStreaming.value
  const requestReasoningEffort = reasoningEffort.value.trim()
  let assistantMessageId: number | undefined
  let receivedDone = false

  /** 思考或回答任一增量首次到达时创建同一条助手消息。 */
  function ensureAssistantMessage(): Message {
    let assistantMessage = messages.value.find(item => item.id === assistantMessageId)
    if (assistantMessage)
      return assistantMessage

    assistantMessageId = nextMessageId++
    assistantMessage = {
      id: assistantMessageId,
      role: 'agent',
      content: '',
      reasoning: '',
      isReasoningOpen: true,
      isStreaming: requestUsesStreaming,
    }
    messages.value.push(assistantMessage)
    return assistantMessage
  }

  try {
    // 推理等级是单个顶层字符串：'off' 表示显式关闭，其余值原样透传给服务端。
    // 空串表示页面没有具体选择，此时必须整个省略字段，让服务端使用部署默认。
    const requestBody: {
      message: string
      conversationId?: string
      stream: boolean
      reasoningEffort?: string
    } = {
      message,
      stream: requestUsesStreaming,
    }
    if (conversationId.value)
      requestBody.conversationId = conversationId.value
    if (requestReasoningEffort)
      requestBody.reasoningEffort = requestReasoningEffort

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok)
      throw new Error(`请求失败（${response.status}）`)

    if (!requestUsesStreaming) {
      const payload: unknown = await response.json()
      if (!isChatJsonResponse(payload))
        throw new Error('服务端返回了无法识别的非流式结果')

      const result = payload.data
      conversationId.value = result.sessionId
      if (result.status !== 'completed')
        throw new Error(result.error.message)

      receivedDone = true
      const assistantMessage = ensureAssistantMessage()
      assistantMessage.content = result.content
      assistantMessage.reasoning = result.reasoning
      assistantMessage.isStreaming = false
      assistantMessage.isReasoningOpen = false
      isAwaitingFirstToken.value = false
    }
    else {
      await readEventStream(response, (event) => {
        if (event.type === 'session.started') {
          conversationId.value = event.sessionId
          return
        }

        if (event.type === 'error' || event.type === 'server.error')
          throw new Error(event.message)

        if (event.type === 'tool.approval.requested') {
          // Agent Run 仍在原 SSE 中等待；这里只替换 Composer，不能结束 readEventStream。
          toolInteraction.value = {
            kind: 'approval',
            approvalId: event.approvalId,
            callId: event.callId,
            toolName: event.toolName,
            reason: event.reason,
            ...(event.title ? { title: event.title } : {}),
            ...(event.details ? { details: event.details } : {}),
            input: event.input,
            ...(event.toolMetadata.risk === 'safe'
              || event.toolMetadata.risk === 'read'
              || event.toolMetadata.risk === 'write'
              || event.toolMetadata.risk === 'destructive'
              ? { risk: event.toolMetadata.risk }
              : {}),
            expiresAt: event.expiresAt,
            status: 'pending',
          }
          startApprovalCountdown(event.expiresAt)
          isAwaitingFirstToken.value = false
          return
        }

        if (event.type === 'tool.approval.resolved') {
          // approvalId 必须匹配当前卡片，迟到的旧事件不能覆盖新审批状态。
          if (toolInteraction.value?.approvalId === event.approvalId) {
            toolInteraction.value.status = event.outcome
            stopApprovalCountdown()
          }
          return
        }

        if (event.type === 'tool.guard.denied') {
          // deny 没有人工审批和 approvalId，因此卡片只展示原因，不渲染操作按钮。
          toolInteraction.value = {
            kind: 'denied',
            callId: event.callId,
            toolName: event.toolName,
            reason: event.reason,
            status: 'policy-denied',
          }
          stopApprovalCountdown()
          isAwaitingFirstToken.value = false
          return
        }

        if (event.type === 'message.delta') {
          // 两个频道共用一个助手消息，但分别追加到 reasoning 和 content。
          const assistantMessage = ensureAssistantMessage()
          if (event.channel === 'reasoning') {
            assistantMessage.reasoning += event.delta
            assistantMessage.isReasoningOpen = true
          }
          else {
            assistantMessage.content += event.delta
          }
          isAwaitingFirstToken.value = false
          void scrollToLatest('auto')
          return
        }

        conversationId.value = event.sessionId
        receivedDone = true
        if (assistantMessageId === undefined && (event.content || event.reasoning)) {
          const assistantMessage = ensureAssistantMessage()
          assistantMessage.content = event.content
          assistantMessage.reasoning = event.reasoning ?? ''
        }

        const assistantMessage = messages.value.find(item => item.id === assistantMessageId)
        if (assistantMessage) {
          // done 携带完整值作为无增量场景的兜底；正常流式路径不重复追加。
          assistantMessage.content ||= event.content
          assistantMessage.reasoning ||= event.reasoning ?? ''
          assistantMessage.isStreaming = false
          assistantMessage.isReasoningOpen = false
        }
      })
    }

    if (!receivedDone)
      throw new Error('流式响应意外中断')

    await loadConversations()
  }
  catch (error) {
    if (assistantMessageId !== undefined) {
      const index = messages.value.findIndex(item => item.id === assistantMessageId)
      if (index >= 0)
        messages.value.splice(index, 1)
    }
    failedPrompt.value = message
    errorMessage.value = error instanceof Error ? error.message : '发送失败，请稍后重试'
  }
  finally {
    stopApprovalCountdown()
    isSending.value = false
    isAwaitingFirstToken.value = false
    await scrollToLatest()
  }
}

/** 只验证页面实际消费的 AgentRunResult 字段，详细协议仍由 CraftAgent 类型定义。 */
function isChatJsonResponse(value: unknown): value is ChatJsonResponse {
  if (typeof value !== 'object' || value === null || !('data' in value))
    return false
  const data = (value as { data?: unknown }).data
  if (typeof data !== 'object' || data === null)
    return false
  const result = data as Partial<AgentRunResult>
  return (result.status === 'completed' || result.status === 'stopped' || result.status === 'failed')
    && typeof result.sessionId === 'string'
    && typeof result.content === 'string'
    && typeof result.reasoning === 'string'
}

/** 使用上一次失败的原始提示词重试，避免聊天区出现重复的用户气泡。 */
function retry() {
  if (failedPrompt.value)
    void send(failedPrompt.value, false)
}

onMounted(() => {
  void loadConversations(true)
  void loadModelVocabulary()
})

onBeforeUnmount(() => {
  stopApprovalCountdown()
})
</script>

<template>
  <div class="chat-page">
    <div class="ambient ambient-left" />
    <div class="ambient ambient-right" />

    <section class="workspace-shell">
      <button
        v-if="isSidebarOpen"
        class="sidebar-backdrop"
        type="button"
        aria-label="关闭会话列表"
        @click="isSidebarOpen = false"
      />

      <aside class="conversation-sidebar" :class="{ open: isSidebarOpen }">
        <div class="sidebar-header">
          <div class="flex gap-3 min-w-0 items-center">
            <div class="brand-mark" aria-hidden="true">
              <div i-carbon-bot />
            </div>
            <div class="min-w-0">
              <div class="text-3.75 text-slate-900 font-700 truncate dark:text-white">
                Hand-crafted
              </div>
              <div class="text-2.75 text-slate-500 mt-0.5 dark:text-slate-400">
                Agent Workspace
              </div>
            </div>
          </div>
          <button
            class="sidebar-close"
            type="button"
            aria-label="关闭会话列表"
            @click="isSidebarOpen = false"
          >
            <div i-carbon-close />
          </button>
        </div>

        <button
          class="new-chat-button"
          type="button"
          :disabled="isSending"
          @click="startNewConversation"
        >
          <div i-carbon-add />
          <span>新对话</span>
        </button>

        <div class="conversation-heading">
          <span>最近对话</span>
          <button
            class="refresh-button"
            type="button"
            :disabled="isLoadingConversations"
            aria-label="刷新会话列表"
            @click="loadConversations()"
          >
            <div i-carbon-renew :class="{ 'animate-spin': isLoadingConversations }" />
          </button>
        </div>

        <nav class="conversation-list" aria-label="会话列表">
          <template v-if="isLoadingConversations && conversations.length === 0">
            <div v-for="index in 3" :key="index" class="conversation-skeleton">
              <span />
              <span />
            </div>
          </template>

          <div v-else-if="conversationError && conversations.length === 0" class="sidebar-state error">
            <div i-carbon-warning-alt />
            <span>{{ conversationError }}</span>
            <button type="button" @click="loadConversations(true)">
              重新加载
            </button>
          </div>

          <div v-else-if="displayedConversations.length === 0" class="sidebar-state">
            <div i-carbon-chat text-6 />
            <span>还没有历史对话</span>
          </div>

          <button
            v-for="conversation in displayedConversations"
            v-else
            :key="conversation.id"
            class="conversation-item"
            :class="{ active: conversation.id === conversationId }"
            type="button"
            :disabled="isSending"
            :aria-current="conversation.id === conversationId ? 'page' : undefined"
            @click="selectConversation(conversation)"
          >
            <div class="conversation-icon" aria-hidden="true">
              <div i-carbon-chat />
            </div>
            <div class="text-left flex-1 min-w-0">
              <div class="conversation-name">
                {{ conversation.name || '未命名对话' }}
              </div>
              <div class="conversation-date">
                {{ formatConversationDate(conversation.createAt) }}
              </div>
            </div>
          </button>
        </nav>

        <div class="sidebar-footer">
          <span class="status-dot" />
          <span>服务已连接</span>
        </div>
      </aside>

      <section class="chat-panel">
        <header class="chat-header">
          <button
            class="menu-button"
            type="button"
            aria-label="打开会话列表"
            @click="isSidebarOpen = true"
          >
            <div i-carbon-menu />
          </button>
          <div class="text-left flex-1 min-w-0">
            <h1 class="text-4.5 text-slate-900 font-700 m-0 truncate dark:text-white">
              {{ pageTitle }}
            </h1>
            <!-- <div class="text-3 text-slate-500 mt-1 flex gap-1.5 items-center dark:text-slate-400">
              <span class="status-dot" />
              <span>{{ conversationId ? '对话上下文已连接' : '发送第一条消息以创建对话' }}</span>
            </div> -->
          </div>
          <div v-if="messages.length" class="message-count">
            {{ messages.length }} 条消息
          </div>
        </header>

        <main ref="messageList" class="message-list" aria-live="polite">
          <div v-if="messages.length === 0" class="empty-state">
            <div class="empty-icon" aria-hidden="true">
              <div i-carbon-chat-bot text-8 />
            </div>
            <h2 class="text-6 text-slate-900 tracking-tight font-700 mb-0 mt-5 dark:text-white">
              开始一段新对话
            </h2>
            <p class="text-3.5 text-slate-500 leading-6 mb-0 mt-2 max-w-110 dark:text-slate-400">
              第一条消息不会携带 conversationId，服务端返回后会自动关联后续上下文。
            </p>
          </div>

          <div v-else class="message-content">
            <article
              v-for="message in messages"
              :key="message.id"
              class="message-row"
              :class="message.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div v-if="message.role === 'agent'" class="avatar" aria-hidden="true">
                <div i-carbon-bot />
              </div>
              <div
                class="message-bubble"
                :class="[
                  message.role,
                  { 'has-reasoning': message.role === 'agent' && message.reasoning },
                ]"
              >
                <template v-if="message.role === 'agent'">
                  <section v-if="message.reasoning" class="reasoning-panel">
                    <button
                      type="button"
                      class="reasoning-toggle"
                      :aria-expanded="Boolean(message.isReasoningOpen)"
                      @click="message.isReasoningOpen = !message.isReasoningOpen"
                    >
                      <span class="reasoning-title">
                        <span class="reasoning-status" :class="{ streaming: message.isStreaming }">
                          <span v-if="message.isStreaming" class="reasoning-pulse" />
                          <span v-else i-carbon-checkmark-filled aria-hidden="true" />
                        </span>
                        {{ message.isStreaming ? '正在思考' : '已思考' }}
                      </span>
                      <span
                        i-carbon-chevron-down
                        class="reasoning-chevron"
                        :class="{ open: message.isReasoningOpen }"
                        aria-hidden="true"
                      />
                    </button>
                    <div v-if="message.isReasoningOpen" class="reasoning-content">
                      {{ message.reasoning }}
                    </div>
                  </section>

                  <!-- markdown-it 已禁用原始 HTML；v-html 只挂载解析器生成的受控标签。 -->
                  <div
                    v-if="message.content"
                    class="answer-content markdown-body"
                    v-html="renderMarkdown(message.content)"
                  />
                  <div v-else-if="message.isStreaming" class="answer-pending">
                    正在组织回答…
                  </div>
                </template>
                <template v-else>
                  {{ message.content }}
                </template>
              </div>
            </article>

            <div v-if="isSending && isAwaitingFirstToken" class="message-row justify-start">
              <div class="avatar" aria-hidden="true">
                <div i-carbon-bot />
              </div>
              <div class="typing-indicator" aria-label="Agent 正在思考">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        </main>

        <footer class="composer-area">
          <div class="composer-content">
            <div class="model-controls" aria-label="模型运行设置">
              <label class="model-toggle">
                <input v-model="useStreaming" type="checkbox" :disabled="isSending">
                <span>流式输出</span>
              </label>
              <label class="reasoning-effort-control">
                <span>推理等级</span>
                <!--
                  等级名来自 GET /api/model：不同部署的词汇表不同，
                  因此页面不再硬编码任何一家的等级集合。
                -->
                <select
                  v-if="reasoningEfforts.length"
                  v-model="reasoningEffort"
                  :disabled="isSending"
                  aria-label="推理等级"
                >
                  <option v-for="level in reasoningEfforts" :key="level" :value="level">
                    {{ formatReasoningEffort(level) }}
                  </option>
                </select>
                <!-- 词汇表不可用时退化为自由文本，保证任何等级都不会因此无法选择。 -->
                <input
                  v-else
                  v-model="reasoningEffort"
                  :disabled="isSending"
                  aria-label="推理等级"
                >
              </label>
              <span v-if="!useStreaming" class="transport-hint">
                普通 JSON · 不支持交互式审批
              </span>
            </div>
            <div v-if="errorMessage" class="error-banner" role="alert">
              <div class="flex gap-2 items-center">
                <div i-carbon-warning-alt-filled shrink-0 />
                <span>{{ errorMessage }}</span>
              </div>
              <button type="button" class="retry-button" :disabled="isSending" @click="retry">
                重试
              </button>
            </div>

            <!-- Agent 等待审批时，用卡片替换输入框；用户作出决定后仍继续消费同一条 SSE。 -->
            <section
              v-if="isSending && toolInteraction"
              class="tool-confirm-card"
              :class="{ denied: toolInteraction.kind === 'denied' }"
              aria-live="assertive"
            >
              <div class="tool-confirm-heading">
                <div class="tool-confirm-icon" aria-hidden="true">
                  <div i-carbon-warning-alt-filled />
                </div>
                <div class="min-w-0">
                  <strong>{{ toolInteraction.title ?? (toolInteraction.kind === 'approval' ? '工具需要确认' : '工具已被策略拒绝') }}</strong>
                  <div class="tool-confirm-name">
                    {{ toolInteraction.toolName }}
                  </div>
                </div>
                <span v-if="toolInteraction.risk" class="risk-badge">{{ toolInteraction.risk }}</span>
              </div>
              <p class="tool-confirm-reason">
                {{ toolInteraction.reason }}
              </p>
              <details v-if="toolInteraction.input !== undefined" class="tool-input-details">
                <summary>查看调用参数</summary>
                <pre>{{ formatToolInput(toolInteraction.input) }}</pre>
              </details>
              <details v-if="toolInteraction.details" class="tool-input-details">
                <summary>查看评估详情</summary>
                <pre>{{ formatToolInput(toolInteraction.details) }}</pre>
              </details>
              <div class="tool-confirm-footer">
                <span class="tool-confirm-status">{{ getToolInteractionStatus(toolInteraction.status) }}</span>
                <!-- 自动 deny 和已提交状态都没有按钮，避免绕过策略或重复提交。 -->
                <div v-if="toolInteraction.status === 'pending'" class="tool-confirm-actions">
                  <button type="button" class="tool-reject-button" @click="decideToolApproval('deny')">
                    拒绝
                  </button>
                  <button type="button" class="tool-approve-button" @click="decideToolApproval('allow')">
                    仅本次允许
                  </button>
                </div>
              </div>
              <div v-if="approvalError" class="tool-confirm-error" role="alert">
                {{ approvalError }}
              </div>
            </section>

            <form v-else class="composer" @submit.prevent="send()">
              <textarea
                v-model="input"
                rows="1"
                maxlength="2000"
                aria-label="消息内容"
                placeholder="输入消息，按 Enter 发送…"
                :disabled="isSending"
                @keydown.enter.exact.prevent="send()"
              />
              <button
                class="send-button"
                type="submit"
                :disabled="!input.trim() || isSending"
                aria-label="发送消息"
              >
                <div v-if="isSending" i-carbon-circle-dash class="animate-spin" />
                <div v-else i-carbon-send-filled />
              </button>
            </form>
            <p v-if="!isSending || !toolInteraction" class="text-2.75 text-slate-400 m-0 mt-2 text-center dark:text-slate-500">
              Shift + Enter 换行 · AI 生成内容可能存在错误，请注意核实
            </p>
          </div>
        </footer>
      </section>
    </section>
  </div>
</template>

<style scoped>
.chat-page {
  --panel-border: rgb(226 232 240 / 80%);
  position: relative;
  min-height: 100%;
  overflow: hidden;
  display: grid;
  place-items: center;
  padding: 28px;
  background:
    radial-gradient(circle at 50% -10%, rgb(219 234 254 / 75%), transparent 36%),
    linear-gradient(145deg, #f8fafc 0%, #f1f5f9 100%);
}

.ambient {
  position: absolute;
  width: 320px;
  height: 320px;
  border-radius: 9999px;
  filter: blur(90px);
  opacity: 0.28;
  pointer-events: none;
}

.ambient-left {
  top: 8%;
  left: -100px;
  background: #38bdf8;
}

.ambient-right {
  right: -80px;
  bottom: 4%;
  background: #818cf8;
}

.workspace-shell {
  position: relative;
  width: min(100%, 1180px);
  height: min(840px, calc(100vh - 56px));
  min-height: 580px;
  overflow: hidden;
  display: grid;
  grid-template-columns: 278px minmax(0, 1fr);
  border: 1px solid var(--panel-border);
  border-radius: 24px;
  background: rgb(255 255 255 / 82%);
  box-shadow: 0 24px 70px rgb(15 23 42 / 12%);
  backdrop-filter: blur(22px);
}

.conversation-sidebar {
  z-index: 3;
  min-width: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  padding: 18px 14px 14px;
  border-right: 1px solid var(--panel-border);
  background: rgb(248 250 252 / 76%);
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 18px;
}

.brand-mark,
.empty-icon {
  display: grid;
  place-items: center;
  color: white;
  background: linear-gradient(145deg, #2563eb, #4f46e5);
  box-shadow: 0 8px 20px rgb(37 99 235 / 25%);
}

.brand-mark {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 13px;
  font-size: 20px;
}

.new-chat-button {
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 0;
  border-radius: 13px;
  color: white;
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  box-shadow: 0 7px 18px rgb(37 99 235 / 18%);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  transition:
    transform 150ms ease,
    box-shadow 150ms ease,
    opacity 150ms ease;
}

.new-chat-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 9px 22px rgb(37 99 235 / 24%);
}

.new-chat-button:disabled,
.conversation-item:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.conversation-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 7px 8px;
  color: #94a3b8;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.refresh-button,
.sidebar-close,
.menu-button {
  display: grid;
  place-items: center;
  border: 0;
  color: #64748b;
  background: transparent;
  cursor: pointer;
}

.refresh-button {
  width: 26px;
  height: 26px;
  border-radius: 8px;
}

.refresh-button:hover,
.sidebar-close:hover,
.menu-button:hover {
  color: #2563eb;
  background: #eff6ff;
}

.conversation-list {
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
  scrollbar-color: #cbd5e1 transparent;
  scrollbar-width: thin;
}

.conversation-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 10px;
  color: #475569;
  background: transparent;
  cursor: pointer;
  font: inherit;
  transition:
    border-color 140ms ease,
    color 140ms ease,
    background 140ms ease;
}

.conversation-item:hover:not(:disabled) {
  color: #1e293b;
  background: rgb(255 255 255 / 75%);
}

.conversation-item.active {
  border-color: #bfdbfe;
  color: #1e3a8a;
  background: #eff6ff;
}

.conversation-icon {
  width: 31px;
  height: 31px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 9px;
  color: #64748b;
  background: #e2e8f0;
}

.conversation-item.active .conversation-icon {
  color: #2563eb;
  background: #dbeafe;
}

.conversation-name {
  overflow: hidden;
  color: inherit;
  font-size: 12.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conversation-date {
  overflow: hidden;
  margin-top: 3px;
  color: #94a3b8;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-state {
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 16px;
  color: #94a3b8;
  text-align: center;
  font-size: 12px;
}

.sidebar-state.error {
  color: #b91c1c;
}

.sidebar-state button {
  border: 0;
  padding: 4px 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font-weight: 700;
}

.conversation-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 10px;
}

.conversation-skeleton span {
  height: 9px;
  border-radius: 999px;
  background: #e2e8f0;
  animation: pulse 1.5s ease-in-out infinite;
}

.conversation-skeleton span:last-child {
  width: 58%;
}

.sidebar-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 11px 8px 2px;
  border-top: 1px solid var(--panel-border);
  color: #64748b;
  font-size: 11px;
}

.status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 3px rgb(34 197 94 / 14%);
}

.chat-panel {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
}

.chat-header {
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--panel-border);
  background: rgb(255 255 255 / 72%);
}

.menu-button,
.sidebar-close {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 11px;
  font-size: 20px;
}

.menu-button,
.sidebar-close,
.sidebar-backdrop {
  display: none;
}

.message-count {
  flex: 0 0 auto;
  border: 1px solid #e2e8f0;
  border-radius: 999px;
  padding: 5px 10px;
  color: #64748b;
  background: #f8fafc;
  font-size: 11px;
}

.message-list {
  min-height: 0;
  overflow-y: auto;
  padding: 28px 32px;
  scroll-behavior: smooth;
  scrollbar-color: #cbd5e1 transparent;
  scrollbar-width: thin;
}

.message-content,
.composer-content {
  width: min(100%, 840px);
  margin-inline: auto;
}

.message-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.empty-icon {
  width: 72px;
  height: 72px;
  border-radius: 22px;
}

.message-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.avatar {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid #dbeafe;
  border-radius: 11px;
  color: #2563eb;
  background: #eff6ff;
}

.message-bubble {
  max-width: min(76%, 620px);
  padding: 11px 15px;
  border-radius: 18px;
  text-align: left;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 14px;
  line-height: 1.65;
}

.message-bubble.user {
  border-bottom-right-radius: 5px;
  color: white;
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  box-shadow: 0 7px 18px rgb(37 99 235 / 18%);
}

.message-bubble.agent {
  border: 1px solid #e2e8f0;
  border-bottom-left-radius: 5px;
  color: #334155;
  background: white;
  box-shadow: 0 5px 15px rgb(15 23 42 / 5%);
}

.message-bubble.agent.has-reasoning {
  min-width: min(100%, 300px);
  overflow: hidden;
  padding: 0;
}

.reasoning-panel {
  border-bottom: 1px solid #e2e8f0;
  color: #64748b;
  background: linear-gradient(135deg, #f8fafc, #f1f5f9);
}

.reasoning-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border: 0;
  padding: 10px 13px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
  text-align: left;
}

.reasoning-toggle:hover {
  color: #2563eb;
  background: rgb(219 234 254 / 45%);
}

.reasoning-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.reasoning-status {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: #2563eb;
  background: #dbeafe;
  font-size: 11px;
}

.reasoning-status.streaming {
  background: #e0e7ff;
}

.reasoning-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #6366f1;
  box-shadow: 0 0 0 0 rgb(99 102 241 / 35%);
  animation: reasoning-pulse 1.4s ease-out infinite;
}

.reasoning-chevron {
  flex: 0 0 auto;
  transition: transform 160ms ease;
}

.reasoning-chevron.open {
  transform: rotate(180deg);
}

.reasoning-content {
  max-height: 260px;
  overflow-y: auto;
  padding: 0 14px 12px 36px;
  color: #64748b;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.65;
  scrollbar-color: #cbd5e1 transparent;
  scrollbar-width: thin;
}

.answer-content,
.answer-pending {
  padding: 11px 15px;
}

.markdown-body {
  white-space: normal;
}

.markdown-body :deep(> :first-child) {
  margin-top: 0;
}

.markdown-body :deep(> :last-child) {
  margin-bottom: 0;
}

.markdown-body :deep(p),
.markdown-body :deep(ul),
.markdown-body :deep(ol),
.markdown-body :deep(pre),
.markdown-body :deep(blockquote),
.markdown-body :deep(table) {
  margin: 0.7em 0;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 1em 0 0.45em;
  color: #0f172a;
  font-weight: 700;
  line-height: 1.3;
}

.markdown-body :deep(h1) {
  font-size: 1.35em;
}

.markdown-body :deep(h2) {
  font-size: 1.2em;
}

.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-size: 1.05em;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  padding-left: 1.5em;
}

.markdown-body :deep(li + li) {
  margin-top: 0.25em;
}

.markdown-body :deep(a) {
  color: #2563eb;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown-body :deep(code) {
  border-radius: 5px;
  padding: 0.15em 0.38em;
  background: #f1f5f9;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.9em;
}

.markdown-body :deep(pre) {
  max-width: 100%;
  overflow-x: auto;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 12px 14px;
  background: #0f172a;
  color: #e2e8f0;
  white-space: pre;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
  font-size: 0.88em;
}

.markdown-body :deep(blockquote) {
  border-left: 3px solid #93c5fd;
  padding-left: 12px;
  color: #64748b;
}

.markdown-body :deep(table) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  border: 1px solid #cbd5e1;
  padding: 6px 10px;
  text-align: left;
}

.markdown-body :deep(th) {
  background: #f8fafc;
}

.answer-pending {
  color: #94a3b8;
  font-size: 12px;
}

.typing-indicator {
  display: flex;
  gap: 5px;
  padding: 14px 16px;
  border: 1px solid #e2e8f0;
  border-radius: 18px 18px 18px 5px;
  background: white;
}

.typing-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
  animation: typing 1.2s infinite ease-in-out;
}

.typing-indicator span:nth-child(2) {
  animation-delay: 0.15s;
}

.typing-indicator span:nth-child(3) {
  animation-delay: 0.3s;
}

.composer-area {
  z-index: 1;
  padding: 16px 24px 18px;
  border-top: 1px solid var(--panel-border);
  background: rgb(248 250 252 / 82%);
}

.model-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin-bottom: 9px;
  color: #64748b;
  font-size: 11px;
}

.model-toggle,
.reasoning-effort-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.model-toggle input {
  accent-color: #2563eb;
}

.reasoning-effort-control input,
.reasoning-effort-control select {
  width: 82px;
  border: 1px solid #cbd5e1;
  border-radius: 7px;
  padding: 3px 6px;
  color: #475569;
  background: white;
  font: inherit;
}

/* 等级名长度由部署决定，下拉框按内容自适应，避免“不推理（off）”被截断。 */
.reasoning-effort-control select {
  width: auto;
  min-width: 96px;
}

.reasoning-effort-control input:disabled,
.reasoning-effort-control select:disabled {
  opacity: 0.5;
}

.transport-hint {
  color: #b45309;
}

.tool-confirm-card {
  padding: 14px 16px;
  border: 1px solid #fdba74;
  border-radius: 17px;
  color: #7c2d12;
  background: #fff7ed;
  box-shadow: 0 4px 14px rgb(124 45 18 / 8%);
}

.tool-confirm-card.denied {
  border-color: #fca5a5;
  color: #991b1b;
  background: #fef2f2;
}

.tool-confirm-heading,
.tool-confirm-footer,
.tool-confirm-actions {
  display: flex;
  align-items: center;
}

.tool-confirm-heading {
  gap: 10px;
}

.tool-confirm-heading strong {
  display: block;
  font-size: 14px;
}

.tool-confirm-icon {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #c2410c;
  background: rgb(255 237 213 / 90%);
}

.tool-confirm-card.denied .tool-confirm-icon {
  color: #dc2626;
  background: #fee2e2;
}

.tool-confirm-name {
  margin-top: 2px;
  color: #9a3412;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 11px;
  overflow-wrap: anywhere;
}

.risk-badge {
  margin-left: auto;
  padding: 3px 7px;
  border: 1px solid currentcolor;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}

.tool-confirm-reason {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
}

.tool-input-details {
  margin-top: 8px;
  font-size: 12px;
}

.tool-input-details summary {
  cursor: pointer;
  font-weight: 600;
}

.tool-input-details pre {
  max-height: 150px;
  margin: 8px 0 0;
  padding: 9px 10px;
  overflow: auto;
  border-radius: 9px;
  color: #431407;
  background: rgb(255 255 255 / 72%);
  font-size: 11px;
  line-height: 1.45;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tool-confirm-footer {
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
}

.tool-confirm-status {
  font-size: 11px;
}

.tool-confirm-actions {
  flex: 0 0 auto;
  gap: 8px;
}

.tool-reject-button,
.tool-approve-button {
  border-radius: 9px;
  padding: 7px 11px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 650;
}

.tool-reject-button {
  border: 1px solid #fdba74;
  color: #9a3412;
  background: white;
}

.tool-approve-button {
  border: 1px solid #ea580c;
  color: white;
  background: #ea580c;
}

.tool-confirm-error {
  margin-top: 8px;
  color: #b91c1c;
  font-size: 11px;
}

.composer {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 7px 7px 7px 16px;
  border: 1px solid #cbd5e1;
  border-radius: 17px;
  background: white;
  box-shadow: 0 4px 14px rgb(15 23 42 / 5%);
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.composer:focus-within {
  border-color: #60a5fa;
  box-shadow: 0 0 0 4px rgb(59 130 246 / 10%);
}

.composer textarea {
  width: 100%;
  max-height: 150px;
  resize: vertical;
  border: 0;
  outline: 0;
  padding: 8px 0;
  color: #1e293b;
  background: transparent;
  font: inherit;
  font-size: 14px;
  line-height: 1.55;
}

.composer textarea::placeholder {
  color: #94a3b8;
}

.send-button {
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 13px;
  color: white;
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  cursor: pointer;
  font-size: 18px;
  transition:
    transform 150ms ease,
    box-shadow 150ms ease,
    opacity 150ms ease;
}

.send-button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 7px 16px rgb(37 99 235 / 24%);
}

.send-button:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  padding: 9px 12px;
  border: 1px solid #fecaca;
  border-radius: 12px;
  color: #b91c1c;
  background: #fef2f2;
  font-size: 12px;
}

.retry-button {
  flex: 0 0 auto;
  border: 0;
  padding: 3px 8px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font-weight: 600;
}

@keyframes typing {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.45;
  }

  30% {
    transform: translateY(-4px);
    opacity: 1;
  }
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.45;
  }

  50% {
    opacity: 1;
  }
}

@keyframes reasoning-pulse {
  70% {
    box-shadow: 0 0 0 6px rgb(99 102 241 / 0%);
  }

  100% {
    box-shadow: 0 0 0 0 rgb(99 102 241 / 0%);
  }
}

@media (max-width: 760px) {
  .chat-page {
    padding: 0;
  }

  .workspace-shell {
    width: 100%;
    height: 100dvh;
    min-height: 0;
    display: block;
    border: 0;
    border-radius: 0;
  }

  .conversation-sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    width: min(84vw, 310px);
    border-right: 1px solid var(--panel-border);
    transform: translateX(-102%);
    transition: transform 200ms ease;
  }

  .conversation-sidebar.open {
    transform: translateX(0);
  }

  .tool-confirm-footer {
    align-items: stretch;
    flex-direction: column;
  }

  .tool-confirm-actions > button {
    flex: 1;
  }

  .sidebar-close,
  .menu-button {
    display: grid;
  }

  .sidebar-backdrop {
    z-index: 2;
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    border: 0;
    background: rgb(15 23 42 / 42%);
    backdrop-filter: blur(2px);
  }

  .chat-panel {
    height: 100%;
  }

  .chat-header {
    padding: 14px 16px;
  }

  .message-count {
    display: none;
  }

  .message-list {
    padding: 20px 16px;
  }

  .message-bubble {
    max-width: 84%;
  }

  .composer-area {
    padding: 12px 16px max(12px, env(safe-area-inset-bottom));
  }
}

@media (prefers-reduced-motion: reduce) {
  .typing-indicator span,
  .conversation-skeleton span,
  .reasoning-pulse {
    animation: none;
  }

  .message-list {
    scroll-behavior: auto;
  }
}

:global(html.dark) .chat-page {
  --panel-border: rgb(51 65 85 / 70%);
  background:
    radial-gradient(circle at 50% -10%, rgb(30 64 175 / 22%), transparent 36%),
    linear-gradient(145deg, #020617 0%, #0f172a 100%);
}

:global(html.dark) .workspace-shell,
:global(html.dark) .chat-header {
  background: rgb(15 23 42 / 82%);
}

:global(html.dark) .conversation-sidebar,
:global(html.dark) .composer-area {
  background: rgb(15 23 42 / 92%);
}

:global(html.dark) .reasoning-effort-control input,
:global(html.dark) .reasoning-effort-control select {
  border-color: #475569;
  color: #cbd5e1;
  background: #1e293b;
}

:global(html.dark) .conversation-item:hover:not(:disabled) {
  color: #e2e8f0;
  background: #1e293b;
}

:global(html.dark) .conversation-item.active {
  border-color: #1d4ed8;
  color: #bfdbfe;
  background: #172554;
}

:global(html.dark) .conversation-icon,
:global(html.dark) .conversation-skeleton span {
  background: #334155;
}

:global(html.dark) .message-count {
  border-color: #334155;
  color: #94a3b8;
  background: #1e293b;
}

:global(html.dark) .message-bubble.agent,
:global(html.dark) .typing-indicator,
:global(html.dark) .composer {
  border-color: #334155;
  color: #e2e8f0;
  background: #1e293b;
}

:global(html.dark) .tool-confirm-card {
  border-color: #9a3412;
  color: #fed7aa;
  background: #431407;
}

:global(html.dark) .tool-confirm-card.denied {
  border-color: #991b1b;
  color: #fecaca;
  background: #450a0a;
}

:global(html.dark) .tool-confirm-name,
:global(html.dark) .tool-input-details pre {
  color: #fdba74;
}

:global(html.dark) .tool-input-details pre {
  background: rgb(15 23 42 / 64%);
}

:global(html.dark) .tool-reject-button {
  border-color: #c2410c;
  color: #fed7aa;
  background: #431407;
}

:global(html.dark) .reasoning-panel {
  border-color: #334155;
  color: #94a3b8;
  background: linear-gradient(135deg, #172033, #172554);
}

:global(html.dark) .reasoning-toggle:hover {
  color: #bfdbfe;
  background: rgb(30 64 175 / 22%);
}

:global(html.dark) .reasoning-content {
  color: #94a3b8;
}

:global(html.dark) .markdown-body :deep(h1),
:global(html.dark) .markdown-body :deep(h2),
:global(html.dark) .markdown-body :deep(h3),
:global(html.dark) .markdown-body :deep(h4) {
  color: #f8fafc;
}

:global(html.dark) .markdown-body :deep(a) {
  color: #93c5fd;
}

:global(html.dark) .markdown-body :deep(code) {
  background: #334155;
}

:global(html.dark) .markdown-body :deep(pre) {
  border-color: #475569;
  background: #020617;
}

:global(html.dark) .markdown-body :deep(blockquote) {
  border-color: #3b82f6;
  color: #94a3b8;
}

:global(html.dark) .markdown-body :deep(th),
:global(html.dark) .markdown-body :deep(td) {
  border-color: #475569;
}

:global(html.dark) .markdown-body :deep(th) {
  background: #334155;
}

:global(html.dark) .composer textarea {
  color: #e2e8f0;
}

:global(html.dark) .avatar {
  border-color: #1e40af;
  color: #93c5fd;
  background: #172554;
}
</style>
