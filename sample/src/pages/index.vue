<script setup lang="ts">
import type { AgentOutputEvent } from 'craft-harness'
import type { ConversationMessage } from '../components/ConversationView.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import ConversationView from '../components/ConversationView.vue'
import TrajectoryView from '../components/TrajectoryView.vue'

defineOptions({ name: 'IndexPage' })

/** 消息对象由消息区组件渲染，类型从它那里导入，页面只负责组装与缓存。 */
type Message = ConversationMessage

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

/**
 * 服务端按需返回的展示历史：只包含 user / assistant 两条可见角色。
 *
 * 它已经过滤掉 system / tool 等内部上下文，因此页面优先消费它，只有在服务端
 * 只返回原始 history 时才退回自行过滤。
 */
interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning_content?: string
}

interface ConversationDetail extends ConversationSummary {
  history: HistoryMessage[]
  displayHistory?: DisplayMessage[]
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

/** PATCH /api/conversation/:id 成功时返回的是修改后的会话摘要，不是完整详情。 */
interface ConversationSummaryResponse {
  data: ConversationSummary
}

/**
 * 单个模型的展示信息与推理能力，全部来自 GET /api/model。
 *
 * 模型与推理等级都由部署配置，页面不硬编码任何模型名或等级集合；不同模型的推理能力
 * 可以不同，因此等级列表挂在模型上，页面里不存在"全局推理等级"这种东西。
 */
interface ModelOption {
  /** 请求体里真正发送的模型标识。 */
  id: string
  /** 展示名；服务端没给 label 时退化为 id。 */
  label: string
  /** 该模型可选的推理等级；空数组表示它没有推理控制（chip 隐藏、请求不带该字段）。 */
  reasoningEfforts: string[]
  /** 该模型的默认推理等级；null 表示不表达偏好，请求里省略该字段。 */
  defaultReasoningEffort: string | null
}

/**
 * 页面真正消费的模型词汇表，来自 GET /api/model。
 *
 * 任一字段缺失或类型不符都退化为"不提供该能力"，而不是抛错：词汇表只是便利信息，
 * 服务端多返回或少返回字段都不应该让页面进入不可用状态。
 */
interface ModelVocabulary {
  /** 部署默认模型 id；空串表示服务端没给出模型信息。 */
  defaultModel: string
  /** 可切换模型列表；为空表示这次部署不提供模型选择，模型 chip 整体隐藏。 */
  models: ModelOption[]
}

/** 推理等级 chip 的一个选项；value 为空串表示"不指定"，此时请求里不带该字段。 */
interface ReasoningChoice {
  value: string
  label: string
}

/** 会话名称上限；与服务端 400 的约束保持一致，先在前端拦下再谈网络往返。 */
const MAX_CONVERSATION_NAME_LENGTH = 80

/**
 * 输入框高度区间。
 *
 * 拖动把手与内容自动增高共用同一对上下限：自动增高永远不低于 MIN，
 * 也不高过 MAX（超过后由输入框内部滚动接管）。
 */
const MIN_COMPOSER_HEIGHT = 56
const MAX_COMPOSER_HEIGHT = 320
/** 键盘调整把手时的单步高度（ArrowUp / ArrowDown 各 ±24px）。 */
const COMPOSER_HEIGHT_STEP = 24
/** public 目录中的产品标识；绑定变量可避免测试编译器解析根路径为本地文件。 */
const brandLogoPath = '/logo.png'
/** 匿名身份只保存在当前站点的浏览器存储中，不采集指纹，也不承担登录鉴权。 */
const BROWSER_SCOPE_STORAGE_KEY = 'craft-agent.browser-scope-id.v1'
const SCOPE_ID_HEADER = 'X-Craft-Scope-Id'
const BROWSER_SCOPE_PATTERN = /^browser-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const starterPrompts = [
  {
    kind: 'docs',
    title: '了解 Craft Harness',
    prompt: 'Craft Harness 能做什么？如何开发并注册一个自定义工具？',
  },
  {
    kind: 'weather',
    title: '查询 7 天天气',
    prompt: '查询未来 7 天天气，并告诉我每天的气温、降水概率和风力。',
  },
  {
    kind: 'write',
    title: '测试资源写入',
    prompt: '请将“你好，Hand-crafted Agent”写入演示资源 demo/greeting，然后读取它确认写入结果。',
  },
  {
    kind: 'read',
    title: '读取演示资源',
    prompt: '请读取演示资源 demo/greeting，并告诉我其中的内容。',
  },
  {
    kind: 'calculate',
    title: '计算与时间',
    prompt: '计算 (128 × 36) ÷ 9，并告诉我当前北京时间。',
  },

] as const

/**
 * 会话 kebab 菜单的估算尺寸。
 *
 * 菜单用 position: fixed 脱离滚动容器的裁剪，因此必须自己算坐标；这两个值只用于
 * 纵向翻转与横向夹取，尺寸不精确只会让翻转早一点或晚一点发生。
 */
const CONVERSATION_MENU_WIDTH = 168
const CONVERSATION_MENU_HEIGHT = 76
/** 菜单与 kebab 按钮、与视口边缘之间的留白。 */
const CONVERSATION_MENU_GAP = 6
const CONVERSATION_MENU_VIEWPORT_MARGIN = 8
/** 删除 Popconfirm 的估算尺寸；用于贴近触发项并限制在视口内。 */
const DELETE_CONFIRM_WIDTH = 276
const DELETE_CONFIRM_HEIGHT = 136
const DELETE_CONFIRM_GAP = 8

const messages = ref<Message[]>([])
const browserScopeId = getOrCreateBrowserScopeId()
const shortScopeId = browserScopeId.slice(-8)
const conversations = ref<ConversationSummary[]>([])
const input = ref('')
const sessionId = ref('')
const isSending = ref(false)
const isAwaitingFirstToken = ref(false)
const isRefreshingConversation = ref(false)
const isLoadingConversations = ref(false)
const isSidebarOpen = ref(false)
// 桌面端侧边栏收缩状态；收缩后仍保留展开按钮，不隐藏对话区。
const isSidebarCollapsed = ref(false)
const activeView = ref<'conversation' | 'trajectory'>('conversation')
const errorMessage = ref('')
const conversationError = ref('')
// 重命名 / 删除的失败提示；与首次加载失败分开展示，避免把列表整体替换成错误态。
const conversationActionError = ref('')
const failedPrompt = ref('')
// 推理等级是单个字符串，且**属于当前选中的模型**：'off' 表示显式关闭，其余值是部署定义的
// 等级；空串表示不表达偏好，请求体里整个省略该字段，由模型的默认等级决定。
const reasoningEffort = ref('')
// 可选模型来自 GET /api/model 的 models（对象数组）；空列表表示部署不提供模型选择，
// 此时模型 chip 不渲染，请求体也不携带 model 键。
const modelOptions = ref<ModelOption[]>([])
// 当前选中的模型 id；取值一定来自 modelOptions，空串表示页面不表达模型偏好。
const selectedModel = ref('')
// 就地重命名 / 删除二次确认的状态，同一时间只作用于一个会话。
const renamingId = ref('')
const renameDraft = ref('')
const renameError = ref('')
const pendingDeleteId = ref('')
const deletingId = ref('')
const deleteConfirmPosition = ref<{
  top: number
  left: number
  placement: 'left' | 'right'
} | null>(null)
const deleteConfirmButton = ref<HTMLButtonElement>()
// 打开 kebab 菜单的会话 ID；同一时间只允许一个会话的菜单展开。
const openMenuId = ref<string | null>(null)
// 菜单的视口坐标；菜单是 position: fixed，必须由页面按 kebab 的位置算出来。
const conversationMenuPosition = ref<{ top: number, left: number } | null>(null)
// undefined 表示普通 Composer；有值时由状态决定展示审批卡片或自动拒绝卡片。
const toolInteraction = ref<ToolInteraction>()
// 审批 POST 失败只影响卡片提交，可恢复 pending 后重试，不应中断原聊天 SSE。
const approvalError = ref('')
const approvalRemainingSeconds = ref<number>()
const composerInput = ref<HTMLTextAreaElement>()
/**
 * 用户拖动把手设定的高度，null 表示没有手动设定。
 *
 * 它是“下限”而不是固定值：内容比它高时输入框继续自动增高，内容变少时也不会低于它。
 */
const manualComposerHeight = ref<number | null>(null)
/** 最近一次生效的高度，键盘微调以它为基准（还没有内容测量结果时从 MIN 起算）。 */
const composerHeight = ref(MIN_COMPOSER_HEIGHT)
/**
 * 会话详情缓存：已加载过的会话再次切换时直接复用内存数据，不再请求网络。
 *
 * 键是会话 ID；发送新消息与重命名后会同步回填，避免切回来看到旧内容或旧标题。
 */
const conversationCache = new Map<string, ConversationDetail>()
/**
 * 会话消息缓存：与详情缓存同生共死，存的是页面自己的消息对象（含思考面板展开状态）。
 *
 * 切回旧会话时复用同一批对象，消息行的 :key 因此保持不变，DOM 只是打补丁而不是重建——
 * 这正是 KeepAlive 缓存消息区想要的效果。
 */
const messageCache = new Map<string, Message[]>()
/**
 * 菜单定位用的内联样式；没有打开菜单时返回 undefined，不写任何内联坐标。
 *
 * position 也放在这里而不是只写在样式表里：坐标本来就是脚本按 kebab 的矩形算出来的，
 * 两者是一个整体，一起内联才能保证"脱出 overflow 裁剪"这件事只依赖一处实现。
 */
const conversationMenuStyle = computed(() => conversationMenuPosition.value
  ? {
      position: 'fixed' as const,
      top: `${conversationMenuPosition.value.top}px`,
      left: `${conversationMenuPosition.value.left}px`,
    }
  : undefined)
const deleteConfirmStyle = computed(() => deleteConfirmPosition.value
  ? {
      position: 'fixed' as const,
      top: `${deleteConfirmPosition.value.top}px`,
      left: `${deleteConfirmPosition.value.left}px`,
    }
  : undefined)
const pendingDeleteConversation = computed(() => (
  conversations.value.find(conversation => conversation.id === pendingDeleteId.value)
))
let nextMessageId = 1
let approvalCountdown: ReturnType<typeof setInterval> | undefined
/** 正在进行的把手拖动；同一次拖动内用起始高度 + 指针位移计算新高度。 */
let composerResizeState: { pointerId: number, startY: number, startHeight: number } | undefined

/** 生成不依赖服务端状态的 UUID v4；老浏览器没有 Web Crypto 时仅退化匿名隔离强度。 */
function createBrowserScopeId(): string {
  const bytes = new Uint8Array(16)
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  }
  else {
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0F) | 0x40
  bytes[8] = (bytes[8]! & 0x3F) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `browser-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 同一浏览器与站点持续复用一个匿名 scope；清理站点数据后会获得新身份。 */
function getOrCreateBrowserScopeId(): string {
  try {
    const stored = window.localStorage.getItem(BROWSER_SCOPE_STORAGE_KEY)
    if (stored && BROWSER_SCOPE_PATTERN.test(stored))
      return stored

    const created = createBrowserScopeId()
    window.localStorage.setItem(BROWSER_SCOPE_STORAGE_KEY, created)
    return created
  }
  catch {
    // 隐私模式或存储策略可能禁用 localStorage；本次页面生命周期内仍保持同一 scope。
    return createBrowserScopeId()
  }
}

/** 所有访问用户数据的请求都带同一个匿名作用域，模型目录等公共接口不需要它。 */
function scopedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set(SCOPE_ID_HEADER, browserScopeId)
  return fetch(input, { ...init, headers })
}

const displayedConversations = computed(() => [...conversations.value].reverse())
const activeConversation = computed(() => (
  conversations.value.find(conversation => conversation.id === sessionId.value)
))
const pageTitle = computed(() => activeConversation.value?.name?.trim() || '新对话')
/** 当前选中的模型；没有可用模型时为 undefined，此时页面不表达模型偏好。 */
const activeModel = computed(() => (
  modelOptions.value.find(model => model.id === selectedModel.value)
))
/**
 * 推理等级 chip 的选项，随当前模型变化。
 *
 * 模型没有可选等级时为空数组，chip 整体不渲染（该模型没有推理控制，请求里也不带该字段）。
 * 模型声明了可选等级但默认等级为 null（服务端表示“不表达偏好”）时补一个空值选项，
 * 让“不指定”在下拉里有明确文案，而不是显示成空白项。
 */
const reasoningChoices = computed<ReasoningChoice[]>(() => {
  const model = activeModel.value
  if (!model || model.reasoningEfforts.length === 0)
    return []

  const choices = model.reasoningEfforts.map(level => ({
    value: level,
    label: formatReasoningEffort(level),
  }))
  return model.defaultReasoningEffort === null
    ? [{ value: '', label: '默认（不指定）' }, ...choices]
    : choices
})

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
 * 从 GET /api/model 的未知 JSON 中提取模型词汇表。
 *
 * 模型是对象数组：id 用于请求、label 用于展示、每个模型自带推理能力。
 * 任何字段缺失或类型不符都退化为"不提供该能力"，而不是抛错：词汇表只是便利信息，
 * 服务端多返回或少返回字段都不应该让页面进入不可用状态。
 */
function readModelVocabulary(value: unknown): ModelVocabulary {
  if (typeof value !== 'object' || value === null)
    return { defaultModel: '', models: [] }

  const data = value as { defaultModel?: unknown, models?: unknown }
  /** 只接受非空字符串，避免把 null / 数字 / 空串渲染成无法使用的选项。 */
  const readStringList = (input: unknown): string[] => Array.isArray(input)
    ? (input as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .map(item => item.trim())
    : []

  const models: ModelOption[] = []
  const seenIds = new Set<string>()
  if (Array.isArray(data.models)) {
    for (const item of data.models as unknown[]) {
      if (typeof item !== 'object' || item === null)
        continue

      const entry = item as {
        id?: unknown
        label?: unknown
        reasoningEfforts?: unknown
        defaultReasoningEffort?: unknown
      }
      const id = typeof entry.id === 'string' ? entry.id.trim() : ''
      // 没有 id 的条目无法用于请求，只能丢弃；重复 id 只保留第一条。
      if (!id || seenIds.has(id))
        continue

      seenIds.add(id)
      const label = typeof entry.label === 'string' ? entry.label.trim() : ''
      const efforts = readStringList(entry.reasoningEfforts)
      const defaultEffort = typeof entry.defaultReasoningEffort === 'string'
        ? entry.defaultReasoningEffort.trim()
        : ''
      // 服务端给出的默认等级必须始终可选，否则用户会被迫改选成别的等级。
      if (defaultEffort && !efforts.includes(defaultEffort))
        efforts.unshift(defaultEffort)

      models.push({
        id,
        label: label || id,
        reasoningEfforts: efforts,
        defaultReasoningEffort: defaultEffort || null,
      })
    }
  }

  const defaultModel = typeof data.defaultModel === 'string' ? data.defaultModel.trim() : ''
  // 部署默认模型必须可选：列表里没有它时补一条“没有声明推理能力”的条目，
  // 至少保证用户能回到部署默认模型，而不是被 silently 换到别的模型。
  if (defaultModel && !seenIds.has(defaultModel)) {
    models.unshift({
      id: defaultModel,
      label: defaultModel,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    })
  }

  return { defaultModel, models }
}

/** 'off' 是协议保留值，裸英文对用户不友好；其余等级名由部署定义，原样展示。 */
function formatReasoningEffort(level: string): string {
  return level === 'off' ? '不推理（off）' : level
}

/**
 * 让选中的推理等级与当前模型保持一致。
 *
 * 推理能力挂在模型上：换模型后如果原等级不在新模型的列表里，就回到新模型的默认等级；
 * 默认等级为 null（或该模型没有推理控制）时置空，请求体里不发送该字段。
 */
function syncReasoningEffortWithModel(): void {
  const model = activeModel.value
  if (model?.reasoningEfforts.includes(reasoningEffort.value))
    return

  reasoningEffort.value = model?.defaultReasoningEffort ?? ''
}

// 模型一变就重算等级，避免把一个模型不支持的等级发给另一个模型。
watch(selectedModel, syncReasoningEffortWithModel)

/** 把任意高度夹到 [MIN_COMPOSER_HEIGHT, MAX_COMPOSER_HEIGHT] 内。 */
function clampComposerHeight(height: number): number {
  return Math.min(MAX_COMPOSER_HEIGHT, Math.max(MIN_COMPOSER_HEIGHT, height))
}

/**
 * 重新计算并写入输入框高度。
 *
 * 高度有两种来源，手动优先：一旦用户拖动过把手（`manualComposerHeight` 非 null），
 * 该高度就是**权威值**——内容再多也不会把它顶高，只在内容超出时出现内部滚动；
 * 这与系统 textarea 的 resizing 语义一致，也是"能向下拖矮"的前提。
 * 没有手动高度时按内容自动增高，两者都被同一对上下限裁剪。
 * jsdom 等无布局环境里 scrollHeight 恒为 0，此时按“无内容”处理，高度由 MIN 或手动值决定。
 */
function resizeComposer(): void {
  const element = composerInput.value
  if (!element)
    return

  // 先把内联高度归零再读取：只有 height: auto 时 scrollHeight 才等于内容真实高度。
  element.style.height = 'auto'
  const measured = element.scrollHeight
  const contentHeight = Number.isFinite(measured) && measured > 0 ? measured : 0

  const effectiveHeight = clampComposerHeight(
    manualComposerHeight.value ?? contentHeight,
  )
  composerHeight.value = effectiveHeight
  element.style.height = `${effectiveHeight}px`
  element.style.overflowY = contentHeight > effectiveHeight ? 'auto' : 'hidden'
}

/**
 * 发送、切换会话、删除会话后重新测量输入框高度。
 *
 * 没有手动高度时回到内容驱动的高度；手动拖过的高度继续保留——
 * 用户显式设定的尺寸不应被一次发送重置。
 */
function resetComposerHeight(): void {
  void nextTick(resizeComposer)
}

/** 键盘微调把手：以当前生效高度为基准上下移动一步，并夹在上下限内。 */
function stepComposerHeight(delta: number): void {
  const base = manualComposerHeight.value ?? composerHeight.value
  manualComposerHeight.value = clampComposerHeight(base + delta)
  resizeComposer()
}

/**
 * 开始拖动输入框顶部把手。
 *
 * 用 Pointer Events + setPointerCapture：指针移出把手后仍能继续收到 pointermove，
 * 直到 pointerup / pointercancel 才结束。
 */
function beginComposerResize(event: PointerEvent): void {
  composerResizeState = {
    pointerId: event.pointerId,
    startY: event.clientY,
    startHeight: composerHeight.value,
  }

  const handle = event.currentTarget
  // jsdom 等环境可能没有 setPointerCapture，或没有活跃指针（合成事件），两种都直接跳过。
  if (handle instanceof HTMLElement && typeof handle.setPointerCapture === 'function') {
    try {
      handle.setPointerCapture(event.pointerId)
    }
    catch {
      // 捕获失败只影响“指针移出把手后继续跟踪”，不影响已记录的拖动起点。
    }
  }
}

/** 拖动中：向上拖变高，向下拖变矮；结果是手动高度下限。 */
function moveComposerResize(event: PointerEvent): void {
  const state = composerResizeState
  if (!state || state.pointerId !== event.pointerId)
    return

  event.preventDefault()
  manualComposerHeight.value = clampComposerHeight(
    state.startHeight - (event.clientY - state.startY),
  )
  resizeComposer()
}

/** 结束拖动（pointerup / pointercancel）：释放指针捕获并停止跟踪。 */
function endComposerResize(event: PointerEvent): void {
  const state = composerResizeState
  if (!state || state.pointerId !== event.pointerId)
    return

  composerResizeState = undefined
  const handle = event.currentTarget
  if (handle instanceof HTMLElement && typeof handle.releasePointerCapture === 'function') {
    try {
      handle.releasePointerCapture(event.pointerId)
    }
    catch {
      // 指针已经失效时释放会抛错，忽略即可：拖动状态已经清空。
    }
  }
}

/**
 * 把 kebab 按钮的视口矩形换算成菜单的 fixed 坐标。
 *
 * 纵向优先开在按钮下方；下方空间不够时向上翻转。横向右对齐到按钮右边缘，
 * 再夹进视口，保证菜单既不会被裁剪也不会跑出屏幕。
 */
function computeConversationMenuPosition(button: HTMLElement): { top: number, left: number } {
  const rect = button.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const { width: menuWidth, height: menuHeight } = {
    width: CONVERSATION_MENU_WIDTH,
    height: CONVERSATION_MENU_HEIGHT,
  }

  let top = rect.bottom + CONVERSATION_MENU_GAP
  if (top + menuHeight > viewportHeight - CONVERSATION_MENU_VIEWPORT_MARGIN)
    top = rect.top - menuHeight - CONVERSATION_MENU_GAP

  const left = Math.min(
    Math.max(rect.right - menuWidth, CONVERSATION_MENU_VIEWPORT_MARGIN),
    Math.max(
      CONVERSATION_MENU_VIEWPORT_MARGIN,
      viewportWidth - menuWidth - CONVERSATION_MENU_VIEWPORT_MARGIN,
    ),
  )

  return { top, left }
}

/** 打开 / 关闭某个会话的 kebab 菜单；同时只允许一个菜单展开，并用按钮位置算出坐标。 */
function toggleConversationMenu(conversation: ConversationSummary, event: MouseEvent): void {
  closeDeleteConfirmation()
  if (openMenuId.value === conversation.id) {
    closeConversationMenu()
    return
  }

  const button = event.currentTarget
  if (button instanceof HTMLElement)
    conversationMenuPosition.value = computeConversationMenuPosition(button)

  openMenuId.value = conversation.id
}

/** 关闭当前 kebab 菜单；坐标一并清空，避免下次打开时先闪一下旧位置。 */
function closeConversationMenu(): void {
  openMenuId.value = null
  conversationMenuPosition.value = null
}

/** Popconfirm 优先显示在菜单右侧，空间不足时翻到左侧，并始终夹在视口内。 */
function computeDeleteConfirmPosition(trigger: HTMLElement): {
  top: number
  left: number
  placement: 'left' | 'right'
} {
  const rect = trigger.getBoundingClientRect()
  const margin = CONVERSATION_MENU_VIEWPORT_MARGIN
  const maxLeft = Math.max(margin, window.innerWidth - DELETE_CONFIRM_WIDTH - margin)
  const rightSide = rect.right + DELETE_CONFIRM_GAP
  const leftSide = rect.left - DELETE_CONFIRM_WIDTH - DELETE_CONFIRM_GAP
  const placement = rightSide + DELETE_CONFIRM_WIDTH <= window.innerWidth - margin
    ? 'right'
    : 'left'
  const preferredLeft = placement === 'right' ? rightSide : leftSide
  const left = Math.min(Math.max(preferredLeft, margin), maxLeft)
  const top = Math.min(
    Math.max(rect.top, margin),
    Math.max(margin, window.innerHeight - DELETE_CONFIRM_HEIGHT - margin),
  )
  return { top, left, placement }
}

function closeDeleteConfirmation(): void {
  if (deletingId.value)
    return
  pendingDeleteId.value = ''
  deleteConfirmPosition.value = null
}

function closeConversationOverlays(): void {
  closeConversationMenu()
  closeDeleteConfirmation()
}

/**
 * 点击页面其它位置时关闭 kebab 菜单。
 *
 * 监听常驻在 document 上（挂载时注册、卸载时移除），因此菜单自身与 kebab 按钮上的点击
 * 必须被识别为“内部点击”，否则打开菜单的那一次点击会立刻把它关掉。
 */
function handleDocumentClick(event: MouseEvent): void {
  const target = event.target
  if (target instanceof Element) {
    if (target.closest('.conversation-delete-popconfirm'))
      return
    if (target.closest('.conversation-menu, .conversation-menu-button'))
      return
  }

  closeConversationOverlays()
}

/** 把当前消息列表转换成服务端的展示历史形状，用于回填会话详情缓存。 */
function messagesToDisplayHistory(): DisplayMessage[] {
  return messages.value.flatMap<DisplayMessage>((message) => {
    if (message.role === 'user')
      return [{ role: 'user', content: message.content }]
    // 还没有正文的助手消息（例如被中断）不进入历史，与服务端的过滤口径一致。
    if (!message.content)
      return []
    return [{
      role: 'assistant',
      content: message.content,
      ...(message.reasoning ? { reasoning_content: message.reasoning } : {}),
    }]
  })
}

/**
 * 用会话详情（来自内存缓存或网络）填充对话区。
 *
 * 消息对象同样走缓存：已加载过的会话复用同一批对象，消息行的 key 不变，
 * 于是消息区组件既不重建行 DOM，也保留用户展开过的思考面板。
 */
function applyConversationDetail(conversation: ConversationSummary, detail: ConversationDetail): void {
  const cachedMessages = messageCache.get(conversation.id)
  const nextMessages = cachedMessages ?? historyToMessages(detail.displayHistory ?? detail.history)
  if (!cachedMessages)
    messageCache.set(conversation.id, nextMessages)

  sessionId.value = conversation.id
  messages.value = nextMessages
  input.value = ''
  errorMessage.value = ''
  conversationError.value = ''
  failedPrompt.value = ''
  toolInteraction.value = undefined
  stopApprovalCountdown()
  isSidebarOpen.value = false
  resetComposerHeight()
  // 滚动交给消息区组件：首次挂载时它会落到最新一条，切回旧会话时保持原位置不动。
}

/** 发送完成后把内存消息回填进缓存，避免切回该会话时看到发送前的旧内容。 */
function syncConversationCache(): void {
  const id = sessionId.value
  if (!id)
    return

  const summary = conversations.value.find(conversation => conversation.id === id)
  const cached = conversationCache.get(id)
  conversationCache.set(id, {
    id,
    name: summary?.name ?? cached?.name ?? '新对话',
    createAt: summary?.createAt ?? cached?.createAt ?? new Date().toISOString(),
    // 页面只消费 displayHistory，缓存里让 history 保持为空即可，
    // 不需要把内存消息反推成 ModelMessage（那会重新引入 tool / system 上下文）。
    history: [],
    displayHistory: messagesToDisplayHistory(),
  })
  // 继续持有同一批消息对象：流式增量是原地追加的，缓存与页面看到的是同一份状态。
  messageCache.set(id, messages.value)
}

/**
 * 切换会话。
 *
 * 详情优先取内存缓存：已加载过的会话直接渲染，不再发出第二次网络请求；
 * 只有第一次打开某会话时才按 ID 请求详情，随后写入缓存。
 */
async function selectConversation(conversation: ConversationSummary) {
  if (isSending.value)
    return

  conversationActionError.value = ''
  closeConversationMenu()
  const cached = conversationCache.get(conversation.id)
  if (cached) {
    applyConversationDetail(conversation, cached)
    return
  }

  try {
    const response = await scopedFetch(`/api/conversation/${encodeURIComponent(conversation.id)}`)
    if (!response.ok)
      throw new Error(`会话详情加载失败（${response.status}）`)

    const result = await response.json() as Partial<ConversationDetailResponse>
    if (!isConversationDetail(result.data))
      throw new TypeError('会话详情返回格式不正确')

    conversationCache.set(conversation.id, result.data)
    applyConversationDetail(conversation, result.data)
  }
  catch (error) {
    conversationError.value = error instanceof Error ? error.message : '会话详情加载失败'
  }
}

/**
 * 绕过内存缓存重新读取当前会话，用服务端持久化事实替换页面消息。
 * 适合多标签页写入或流式连接意外中断后手动校准，不刷新整个会话目录。
 */
async function refreshCurrentConversation(): Promise<void> {
  const id = sessionId.value
  if (!id || isSending.value || isRefreshingConversation.value)
    return

  isRefreshingConversation.value = true
  errorMessage.value = ''
  try {
    const response = await scopedFetch(`/api/conversation/${encodeURIComponent(id)}`)
    if (!response.ok)
      throw new Error(`当前会话刷新失败（${response.status}）`)

    const result = await response.json() as Partial<ConversationDetailResponse>
    if (!isConversationDetail(result.data))
      throw new TypeError('当前会话返回格式不正确')

    const detail = result.data
    const nextMessages = historyToMessages(detail.displayHistory ?? detail.history)
    conversationCache.set(id, detail)
    messageCache.set(id, nextMessages)
    messages.value = nextMessages
    conversations.value = conversations.value.map(conversation => (
      conversation.id === id
        ? { id: detail.id, name: detail.name, createAt: detail.createAt }
        : conversation
    ))
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '当前会话刷新失败'
  }
  finally {
    isRefreshingConversation.value = false
  }
}

/** 清空当前上下文；下一次发送时不携带 ID，由后端创建新会话。 */
function startNewConversation() {
  if (isSending.value)
    return

  sessionId.value = ''
  activeView.value = 'conversation'
  // 换一个全新的数组：草稿会话的消息随后会作为新会话的缓存内容被接管，
  // 直接复用同一个数组会让两个会话共享状态。
  messages.value = []
  input.value = ''
  errorMessage.value = ''
  failedPrompt.value = ''
  isSidebarOpen.value = false
  renamingId.value = ''
  pendingDeleteId.value = ''
  deleteConfirmPosition.value = null
  closeConversationMenu()
  resetComposerHeight()
}

/** 进入就地重命名；同一时间只编辑一个会话，并收起该会话的 kebab 菜单。 */
function startRename(conversation: ConversationSummary): void {
  renamingId.value = conversation.id
  renameDraft.value = conversation.name
  renameError.value = ''
  pendingDeleteId.value = ''
  deleteConfirmPosition.value = null
  closeConversationMenu()
}

/** 放弃重命名，恢复列表项原状。 */
function cancelRename(): void {
  renamingId.value = ''
  renameDraft.value = ''
  renameError.value = ''
}

/**
 * 提交重命名。
 *
 * 空名与超过 80 字符都是服务端 400 的已知约束，前端先拦下，不发无意义的请求；
 * 其余失败（404 / 网络）由服务端返回的 message 决定提示文案。
 */
async function submitRename(conversation: ConversationSummary): Promise<void> {
  const name = renameDraft.value.trim()
  if (!name) {
    renameError.value = '会话名称不能为空'
    return
  }
  if (name.length > MAX_CONVERSATION_NAME_LENGTH) {
    renameError.value = `会话名称不能超过 ${MAX_CONVERSATION_NAME_LENGTH} 个字符`
    return
  }

  renameError.value = ''
  try {
    const response = await scopedFetch(`/api/conversation/${encodeURIComponent(conversation.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined)
      throw new Error(readServerMessage(payload) ?? `重命名失败（${response.status}）`)
    }

    const result = await response.json() as Partial<ConversationSummaryResponse>
    const updatedName = isConversationSummary(result.data) ? result.data.name : name
    conversations.value = conversations.value.map(item => (
      item.id === conversation.id ? { ...item, name: updatedName } : item
    ))

    // 缓存里的详情同步改名，否则切回该会话时页面标题会退回旧名字。
    const cached = conversationCache.get(conversation.id)
    if (cached)
      conversationCache.set(conversation.id, { ...cached, name: updatedName })

    cancelRename()
  }
  catch (error) {
    renameError.value = error instanceof Error ? error.message : '重命名失败'
  }
}

/** 请求删除；破坏性操作先进入二次确认，再由用户确认后发出 DELETE。 */
function askDeleteConversation(conversation: ConversationSummary, event: MouseEvent): void {
  const trigger = event.currentTarget
  if (trigger instanceof HTMLElement)
    deleteConfirmPosition.value = computeDeleteConfirmPosition(trigger)
  pendingDeleteId.value = conversation.id
  renamingId.value = ''
  renameError.value = ''
  conversationActionError.value = ''
  closeConversationMenu()
  void nextTick(() => deleteConfirmButton.value?.focus())
}

/**
 * 删除会话。
 *
 * 成功后就地更新列表与缓存，不再多拉一次列表；删除的是当前会话时回到“新对话”空态，
 * 避免留下一个已经在服务端消失的 sessionId 继续发送。
 */
async function deleteConversation(conversation: ConversationSummary): Promise<void> {
  if (isSending.value || deletingId.value)
    return

  conversationActionError.value = ''
  deletingId.value = conversation.id
  try {
    const response = await scopedFetch(`/api/conversation/${encodeURIComponent(conversation.id)}`, {
      method: 'DELETE',
    })
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined)
      throw new Error(readServerMessage(payload) ?? `删除失败（${response.status}）`)
    }

    conversations.value = conversations.value.filter(item => item.id !== conversation.id)
    // 详情与消息两份缓存一起失效，避免删掉的会话从缓存里“复活”。
    conversationCache.delete(conversation.id)
    messageCache.delete(conversation.id)
    pendingDeleteId.value = ''
    deleteConfirmPosition.value = null

    if (sessionId.value === conversation.id)
      startNewConversation()
  }
  catch (error) {
    conversationActionError.value = error instanceof Error ? error.message : '删除失败'
  }
  finally {
    deletingId.value = ''
  }
}

/** 读取服务端 `{ error, message }` 结构里的可展示文案，格式不符时返回 undefined。 */
function readServerMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('message' in payload))
    return undefined
  const message = (payload as { message?: unknown }).message
  return typeof message === 'string' && message.trim() ? message : undefined
}

/** 刷新会话列表；首次进入页面时默认打开最近一条会话。 */
async function loadConversations(selectInitial = false) {
  isLoadingConversations.value = true
  conversationError.value = ''

  try {
    const response = await scopedFetch('/api/conversation/list')
    if (!response.ok)
      throw new Error(`会话列表加载失败（${response.status}）`)

    const result = await response.json() as Partial<ConversationListResponse>
    if (!Array.isArray(result.data))
      throw new TypeError('会话列表返回格式不正确')

    conversations.value = result.data.filter(isConversationSummary)

    if (selectInitial && !sessionId.value && displayedConversations.value[0])
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
 * 读取部署的模型词汇表，用它渲染模型下拉与推理等级 chip。
 *
 * 模型名与等级名都因部署而异，所以选项只能来自服务端；加载失败时保持空列表，
 * 模型与等级 chip 都不渲染、请求里也不带这两个字段，不展示阻塞性错误——
 * 词汇表只是便利信息，不是发消息的前提。
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

    modelOptions.value = vocabulary.models
    // 默认选中部署默认模型；词汇表为空时不表达模型偏好。
    selectedModel.value = vocabulary.models.find(model => model.id === vocabulary.defaultModel)?.id
      ?? vocabulary.models[0]?.id
      ?? ''
    // 初始等级取该模型自己的默认等级：null 表示不带该字段（请求里整个省略）。
    reasoningEffort.value = vocabulary.models
      .find(model => model.id === selectedModel.value)
      ?.defaultReasoningEffort ?? ''
  }
  catch {
    // 词汇表请求失败：保持空列表，页面退化为“用部署默认模型 + 不指定推理等级”。
    modelOptions.value = []
    selectedModel.value = ''
    reasoningEffort.value = ''
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
    const response = await scopedFetch(
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
 * 新会话请求刻意省略 sessionId，收到 session.started 后再保存 Agent 生成的 ID。
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
    // 追加用户消息；跟随滚动由消息区组件按内容变化自己做，页面不再持有滚动容器。
    messages.value.push({ id: nextMessageId++, role: 'user', content: message })
    input.value = ''
    resetComposerHeight()
  }

  isSending.value = true
  isAwaitingFirstToken.value = true
  // 锁定本次请求设置；即使以后允许发送期间操作 UI，也不能改变正在执行的 Run。
  const requestReasoningEffort = reasoningEffort.value.trim()
  const requestModel = selectedModel.value.trim()
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
      isStreaming: true,
    }
    messages.value.push(assistantMessage)
    return assistantMessage
  }

  try {
    // 页面固定走流式：stream 恒为 true，SSE 是唯一的响应形态。
    // 推理等级与模型都是单个顶层字符串，且都挂在当前选中的模型上：空串表示这次不表达偏好，
    // 必须整个省略字段（服务端 schema 是 minLength: 1 + additionalProperties: false）。
    const requestBody: {
      message: string
      sessionId?: string
      stream: boolean
      reasoningEffort?: string
      model?: string
    } = {
      message,
      stream: true,
    }
    if (sessionId.value)
      requestBody.sessionId = sessionId.value
    if (requestReasoningEffort)
      requestBody.reasoningEffort = requestReasoningEffort
    if (requestModel)
      requestBody.model = requestModel

    const response = await scopedFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    })

    if (!response.ok)
      throw new Error(`请求失败（${response.status}）`)

    await readEventStream(response, (event) => {
      if (event.type === 'session.started') {
        sessionId.value = event.sessionId
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
        // 增量是原地追加，消息区组件的深度 watch 会把它跟随到底。
        return
      }

      sessionId.value = event.sessionId
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

    if (!receivedDone)
      throw new Error('流式响应意外中断')

    await loadConversations()
    // 列表刷新后再回填缓存：新会话的 name / createAt 以服务端摘要为准。
    syncConversationCache()
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
  }
}

/** 使用上一次失败的原始提示词重试，避免聊天区出现重复的用户气泡。 */
function retry() {
  if (failedPrompt.value)
    void send(failedPrompt.value, false)
}

onMounted(() => {
  void loadConversations(true)
  void loadModelVocabulary()
  // 首次测量输入框内容高度，让初始高度就走同一套 clamp 逻辑。
  resizeComposer()
  // 关闭 kebab 菜单依赖 document 上的点击监听；常驻一份，卸载时移除。
  document.addEventListener('click', handleDocumentClick)
  // 菜单是 fixed 定位，不会跟着列表滚动也不会跟着窗口变化，因此在两处都直接收起。
  window.addEventListener('resize', closeConversationOverlays)
})

onBeforeUnmount(() => {
  stopApprovalCountdown()
  document.removeEventListener('click', handleDocumentClick)
  window.removeEventListener('resize', closeConversationOverlays)
})
</script>

<template>
  <div class="chat-page">
    <!-- 整页布局：shell 与视口等高，滚动只发生在消息区内部，页面本身不产生滚动条。 -->
    <section class="workspace-shell" :class="{ 'sidebar-collapsed': isSidebarCollapsed }">
      <button
        v-if="isSidebarOpen"
        class="sidebar-backdrop"
        type="button"
        aria-label="关闭会话列表"
        @click="isSidebarOpen = false"
      />

      <aside
        class="conversation-sidebar"
        :class="{ open: isSidebarOpen, collapsed: isSidebarCollapsed }"
      >
        <div class="sidebar-header">
          <div class="flex gap-3 min-w-0 items-center">
            <img class="brand-mark" :src="brandLogoPath" alt="Hand-crafted Agent">
            <div class="min-w-0">
              <div class="brand-title text-3.75 text-slate-900 font-700 truncate dark:text-white">
                Craft Harness
              </div>
              <div class="text-2.75 text-slate-500 mt-0.5 dark:text-slate-400">
                Agent Workspace
              </div>
            </div>
          </div>
          <!-- 桌面端收缩：收起侧边栏后对话区仍完整保留，展开按钮在标题栏左侧。 -->
          <button
            class="sidebar-collapse-button"
            type="button"
            aria-label="收起会话列表"
            @click="isSidebarCollapsed = true"
          >
            <div i-carbon-side-panel-close />
          </button>
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

        <nav class="conversation-list" aria-label="会话列表" @scroll="closeConversationOverlays">
          <!-- 重命名 / 删除失败不影响已经加载好的列表，因此单独提示而不是替换整个列表。 -->
          <div v-if="conversationActionError" class="sidebar-notice error" role="alert">
            <div i-carbon-warning-alt />
            <span>{{ conversationActionError }}</span>
          </div>

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

          <div
            v-for="conversation in displayedConversations"
            v-else
            :key="conversation.id"
            class="conversation-item"
            :class="{
              'active': conversation.id === sessionId,
              'editing': renamingId === conversation.id,
              'menu-open': openMenuId === conversation.id,
            }"
            :aria-current="conversation.id === sessionId ? 'page' : undefined"
            @keydown.esc.stop.prevent="closeConversationOverlays"
          >
            <!-- 就地重命名：不再嵌套按钮，避免出现非法的按钮嵌套结构。 -->
            <div v-if="renamingId === conversation.id" class="conversation-rename">
              <input
                v-model="renameDraft"
                class="conversation-rename-input"
                type="text"
                :maxlength="MAX_CONVERSATION_NAME_LENGTH"
                aria-label="会话名称"
                @keydown.enter.prevent="submitRename(conversation)"
                @keydown.esc="cancelRename"
              >
              <button
                class="conversation-rename-confirm"
                type="button"
                aria-label="保存名称"
                @click="submitRename(conversation)"
              >
                <div i-carbon-checkmark />
              </button>
              <button
                class="conversation-rename-cancel"
                type="button"
                aria-label="取消重命名"
                @click="cancelRename"
              >
                <div i-carbon-close />
              </button>
            </div>

            <template v-else>
              <button
                class="conversation-select"
                type="button"
                :disabled="isSending"
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
            </template>
            <!--
              kebab 入口在列表项右侧，默认透明、hover / 激活 / 聚焦 / 菜单展开时才显形；
              它与会话按钮是兄弟节点，点击不会连带选中会话（另外也阻止冒泡）。
            -->
            <button
              class="conversation-menu-button"
              type="button"
              aria-label="会话操作"
              aria-haspopup="menu"
              :aria-expanded="openMenuId === conversation.id ? 'true' : 'false'"
              @click.stop="toggleConversationMenu(conversation, $event)"
            >
              <div i-carbon-overflow-menu-vertical />
            </button>
            <!--
              kebab 下拉菜单：两个入口都复用既有流程（就地重命名 / 二次确认删除）。
              它是 fixed 定位、坐标由 kebab 的矩形算出，因此不会被 .conversation-list /
              .conversation-sidebar 的 overflow 裁剪（前提：祖先链上没有 transform / filter /
              will-change，否则 fixed 会退化成相对那个祖先定位）。
            -->
            <div
              v-if="openMenuId === conversation.id"
              class="conversation-menu"
              role="menu"
              :style="conversationMenuStyle"
              :aria-label="`${conversation.name || '未命名对话'} 的操作`"
            >
              <button
                class="conversation-menu-rename"
                type="button"
                role="menuitem"
                @click="startRename(conversation)"
              >
                <div i-carbon-edit aria-hidden="true" />
                <span>重命名会话</span>
              </button>
              <button
                class="conversation-menu-delete"
                type="button"
                role="menuitem"
                @click="askDeleteConversation(conversation, $event)"
              >
                <div i-carbon-trash-can aria-hidden="true" />
                <span>删除会话</span>
              </button>
            </div>

            <div
              v-if="renamingId === conversation.id && renameError"
              class="conversation-rename-error"
              role="alert"
            >
              {{ renameError }}
            </div>
          </div>
        </nav>

        <div class="sidebar-footer">
          <span class="status-dot" />
          <span :title="browserScopeId">匿名访客 · {{ shortScopeId }}</span>
        </div>
      </aside>

      <!--
        Popconfirm 与侧边栏并列，避免被滚动容器或移动端抽屉裁剪；视觉位置仍锚定到
        “删除会话”菜单项。只有确认按钮会发出 DELETE，点击外部或 Esc 均安全取消。
      -->
      <section
        v-if="pendingDeleteConversation"
        class="conversation-delete-popconfirm"
        :class="`placement-${deleteConfirmPosition?.placement ?? 'right'}`"
        role="alertdialog"
        aria-labelledby="delete-confirm-title"
        aria-describedby="delete-confirm-description"
        :style="deleteConfirmStyle"
        @keydown.esc.stop.prevent="closeDeleteConfirmation"
      >
        <div class="delete-popconfirm-arrow" aria-hidden="true" />
        <div class="delete-popconfirm-content">
          <div class="delete-popconfirm-icon" aria-hidden="true">
            <div i-carbon-warning-alt-filled />
          </div>
          <div class="min-w-0">
            <strong id="delete-confirm-title">删除这个会话？</strong>
            <p id="delete-confirm-description">
              “{{ pendingDeleteConversation.name || '未命名对话' }}”的消息记录将永久删除，此操作无法撤销。
            </p>
          </div>
        </div>
        <div class="delete-popconfirm-actions">
          <button
            class="conversation-delete-cancel"
            type="button"
            :disabled="deletingId === pendingDeleteConversation.id"
            @click.stop="closeDeleteConfirmation"
          >
            取消
          </button>
          <button
            ref="deleteConfirmButton"
            class="conversation-delete-confirm"
            type="button"
            :disabled="isSending || deletingId === pendingDeleteConversation.id"
            @click.stop="deleteConversation(pendingDeleteConversation)"
          >
            {{ deletingId === pendingDeleteConversation.id ? '删除中…' : '确认删除' }}
          </button>
        </div>
      </section>

      <section class="chat-panel">
        <header class="chat-header">
          <div class="chat-title-row">
            <button
              class="menu-button"
              type="button"
              aria-label="打开会话列表"
              @click="isSidebarOpen = true"
            >
              <div i-carbon-menu />
            </button>
            <!-- 侧边栏收起后，对话区左上角始终保留一个展开入口。 -->
            <button
              v-if="isSidebarCollapsed"
              class="sidebar-expand-button"
              type="button"
              aria-label="展开会话列表"
              @click="isSidebarCollapsed = false"
            >
              <div i-carbon-side-panel-open />
            </button>
            <div class="text-left flex-1 min-w-0">
              <h1 class="chat-title text-4.5 text-slate-900 font-700 m-0 truncate dark:text-white">
                {{ pageTitle }}
              </h1>
            </div>
            <div v-if="sessionId && activeView === 'conversation'" class="conversation-header-actions">
              <div v-if="messages.length" class="message-count">
                {{ messages.length }} 条消息
              </div>
              <button
                class="conversation-refresh-button"
                type="button"
                :disabled="isSending || isRefreshingConversation"
                title="刷新当前会话"
                aria-label="刷新当前会话内容"
                @click="refreshCurrentConversation"
              >
                <div i-carbon-renew :class="{ 'animate-spin': isRefreshingConversation }" />
              </button>
            </div>
          </div>
          <div v-if="sessionId" class="conversation-view-tabs" role="tablist" aria-label="会话视图">
            <button
              type="button"
              role="tab"
              :aria-selected="activeView === 'conversation'"
              :class="{ active: activeView === 'conversation' }"
              @click="activeView = 'conversation'"
            >
              对话
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="activeView === 'trajectory'"
              :class="{ active: activeView === 'trajectory' }"
              @click="activeView = 'trajectory'"
            >
              轨迹
            </button>
          </div>
        </header>

        <main class="message-area" aria-live="polite">
          <TrajectoryView
            v-if="sessionId && activeView === 'trajectory'"
            :session-id="sessionId"
            :scope-id="browserScopeId"
          />
          <!--
            消息区交给 ConversationView，并按会话 ID 缓存实例：
            同一个会话来回切换时实例与 DOM 都被复用，滚动位置和思考面板展开状态自然保留；
            没有会话（含还没创建出 session 的草稿会话且尚无消息）时，空状态由页面自己渲染。
          -->
          <KeepAlive :max="8">
            <ConversationView
              v-if="activeView === 'conversation' && (sessionId || messages.length > 0)"
              :key="sessionId || 'draft'"
              :messages="messages"
              :is-sending="isSending"
              :is-awaiting-first-token="isAwaitingFirstToken"
            />
          </KeepAlive>

          <div v-if="activeView === 'conversation' && !sessionId && messages.length === 0" class="message-empty">
            <div class="empty-state">
              <div class="empty-icon" aria-hidden="true">
                <div i-carbon-chat-bot text-8 />
              </div>
              <h2 class="text-6 text-slate-900 tracking-tight font-700 mb-0 mt-5 dark:text-white">
                我可以帮你做什么？
              </h2>
              <p class="text-3.5 text-slate-500 leading-6 mb-0 mt-2 max-w-110 dark:text-slate-400">
                天气、计算、受控资源操作与 Craft Harness 开发问答
              </p>
              <div class="starter-grid" aria-label="对话示例">
                <button
                  v-for="starter in starterPrompts"
                  :key="starter.kind"
                  class="starter-prompt"
                  type="button"
                  :disabled="isSending"
                  @click="send(starter.prompt)"
                >
                  <div class="starter-icon" aria-hidden="true">
                    <div v-if="starter.kind === 'weather'" i-carbon-partly-cloudy />
                    <div v-else-if="starter.kind === 'write'" i-carbon-save />
                    <div v-else-if="starter.kind === 'read'" i-carbon-document-view />
                    <div v-else-if="starter.kind === 'calculate'" i-carbon-calculator />
                    <div v-else i-carbon-book />
                  </div>
                  <span class="starter-copy">
                    <strong>{{ starter.title }}</strong>
                    <span>{{ starter.prompt }}</span>
                  </span>
                  <div class="starter-arrow" i-carbon-arrow-right aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </main>

        <footer class="composer-area">
          <div class="composer-content">
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
              <!--
                输入框顶部把手：整行可拖，向上拖变高；键盘 ArrowUp / ArrowDown 各 ±24px。
                用 separator 语义而不是按钮，因为它调整的是相邻区域的高度。
              -->
              <div
                class="composer-resize-handle"
                role="separator"
                aria-orientation="horizontal"
                aria-label="调整输入框高度"
                tabindex="0"
                @pointerdown="beginComposerResize"
                @pointermove="moveComposerResize"
                @pointerup="endComposerResize"
                @pointercancel="endComposerResize"
                @keydown.up.prevent="stepComposerHeight(COMPOSER_HEIGHT_STEP)"
                @keydown.down.prevent="stepComposerHeight(-COMPOSER_HEIGHT_STEP)"
              >
                <span class="composer-resize-grip" aria-hidden="true" />
              </div>

              <!--
                自增高输入框：随内容向上增高，超过上限后由内部滚动接管。
                高度 = clamp(max(内容高度, 拖动设定的下限), MIN_COMPOSER_HEIGHT, MAX_COMPOSER_HEIGHT)，
                由 resizeComposer 计算，上限通过内联 max-height 与本组件常量单点声明。
              -->
              <textarea
                ref="composerInput"
                v-model="input"
                rows="1"
                maxlength="2000"
                aria-label="消息内容"
                placeholder="输入消息，按 Enter 发送…"
                :style="{ maxHeight: `${MAX_COMPOSER_HEIGHT}px` }"
                :disabled="isSending"
                @input="resizeComposer"
                @keydown.enter.exact.prevent="send()"
              />

              <!-- 输入内容下方一行：左侧模型 / 推理等级药丸，右侧圆形发送按钮。 -->
              <div class="composer-meta">
                <!--
                  两个 chip 都没有时整个容器不渲染，避免在控件行里留下一个空盒子；
                  发送按钮靠 space-between 始终贴右边，chip 数量变化不会让它跳动。
                -->
                <div v-if="modelOptions.length || reasoningChoices.length" class="composer-controls">
                  <label v-if="modelOptions.length" class="model-select-control">
                    <span class="control-label">模型</span>
                    <!--
                      模型列表来自 GET /api/model 的 models：为空时整个 chip 不渲染，
                      请求体也不携带 model，由部署默认模型决定；展示用 label，发送用 id。
                    -->
                    <select
                      v-model="selectedModel"
                      class="model-select"
                      :disabled="isSending"
                      aria-label="模型"
                    >
                      <option v-for="model in modelOptions" :key="model.id" :value="model.id">
                        {{ model.label }}
                      </option>
                    </select>
                    <!-- 原生箭头被药丸样式去掉，用一个小图标补回可下拉的暗示。 -->
                    <div i-carbon-chevron-down class="pill-caret" aria-hidden="true" />
                  </label>
                  <!--
                    推理能力挂在模型上：该模型没有可选等级时整个 chip 不渲染，
                    请求体也不携带 reasoningEffort；切换模型时选项与选中值都跟着重算。
                  -->
                  <label v-if="reasoningChoices.length" class="reasoning-effort-control">
                    <span class="control-label">推理等级</span>
                    <select
                      v-model="reasoningEffort"
                      :disabled="isSending"
                      aria-label="推理等级"
                    >
                      <option
                        v-for="choice in reasoningChoices"
                        :key="choice.value"
                        :value="choice.value"
                      >
                        {{ choice.label }}
                      </option>
                    </select>
                    <div i-carbon-chevron-down class="pill-caret" aria-hidden="true" />
                  </label>
                </div>
                <button
                  class="send-button"
                  type="submit"
                  :disabled="!input.trim() || isSending"
                  aria-label="发送消息"
                >
                  <div v-if="isSending" i-carbon-circle-dash class="animate-spin" aria-hidden="true" />
                  <div v-else i-carbon-arrow-up aria-hidden="true" />
                </button>
              </div>
            </form>
          </div>
        </footer>
      </section>
    </section>
  </div>
</template>

<style scoped>
/*
  整页布局：html / body / #app 已在 main.css 里撑满高度，这里让页面占满这份高度，
  并把所有滚动都收进消息区，页面自身不产生滚动条。
*/
.chat-page {
  --panel-border: rgb(226 232 240 / 80%);
  position: relative;
  height: 100%;
  overflow: hidden;
  background: #f8fafc;
}

.workspace-shell {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  display: grid;
  grid-template-columns: 278px minmax(0, 1fr);
  background: white;
  transition: grid-template-columns 220ms cubic-bezier(0.4, 0, 0.2, 1);
}

/* 列宽与侧边栏位移使用同一时长，对话区会跟随滑出过程平滑扩展。 */
.workspace-shell.sidebar-collapsed {
  grid-template-columns: 0 minmax(0, 1fr);
}

.conversation-sidebar {
  z-index: 3;
  min-width: 0;
  overflow: hidden;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  padding: 18px 14px 14px;
  border-right: 1px solid var(--panel-border);
  background: #f8fafc;
  transform: translateX(0);
  will-change: transform, opacity;
  transition:
    transform 220ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 160ms ease,
    visibility 0s linear 0s;
}

/* 向左滑出后再隐藏可见性；展开时移除该类会立即恢复可见并从左侧滑入。 */
.conversation-sidebar.collapsed {
  visibility: hidden;
  border-right-color: transparent;
  opacity: 0;
  transform: translateX(-100%);
  pointer-events: none;
  transition:
    transform 220ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 160ms ease,
    visibility 0s linear 220ms;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px 18px;
}

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
  border-radius: 8px;
  object-fit: contain;
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
.conversation-select:disabled {
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
.sidebar-collapse-button,
.sidebar-expand-button,
.menu-button {
  display: grid;
  place-items: center;
  border: 0;
  color: #64748b;
  background: transparent;
  cursor: pointer;
}

.refresh-button,
.sidebar-collapse-button,
.sidebar-expand-button {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  font-size: 16px;
}

.refresh-button:hover,
.sidebar-close:hover,
.sidebar-collapse-button:hover,
.sidebar-expand-button:hover,
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

/* 重命名 / 删除失败的行内提示；不替换列表，避免已加载的会话被错误态顶掉。 */
.sidebar-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 10px;
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.4;
}

.sidebar-notice.error {
  color: #b91c1c;
  background: #fef2f2;
}

.conversation-item {
  position: relative;
  width: 100%;
  display: flex;
  flex-wrap: no-wrap;
  align-items: center;
  gap: 4px 6px;
  border: 1px solid transparent;
  border-radius: 12px;
  padding: 6px 8px;
  color: #475569;
  background: transparent;
  transition:
    border-color 140ms ease,
    color 140ms ease,
    background 140ms ease;
}

.conversation-item:hover {
  color: #1e293b;
  background: rgb(255 255 255 / 75%);
}

.conversation-item.active {
  border-color: #bfdbfe;
  color: #1e3a8a;
  background: #eff6ff;
}

/* 会话本体是一个按钮；“重命名 / 删除”是并列的兄弟节点，不做按钮嵌套。 */
.conversation-select {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  border: 0;
  padding: 4px 2px;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.conversation-select:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/*
  kebab 入口：默认隐形，hover / 当前会话 / 键盘聚焦 / 菜单展开时显形。
  它是列表项里 .conversation-select 之后的操作入口（右侧）。
*/
.conversation-menu-button {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #94a3b8;
  background: transparent;
  cursor: pointer;
  font-size: 15px;
  opacity: 0;
  transition:
    opacity 140ms ease,
    color 140ms ease,
    background 140ms ease;
}

.conversation-item:hover .conversation-menu-button,
.conversation-item.active .conversation-menu-button,
.conversation-item:focus-within .conversation-menu-button,
.conversation-item.menu-open .conversation-menu-button {
  opacity: 1;
}

.conversation-menu-button:hover {
  color: #1e293b;
  background: #e2e8f0;
}

/*
  kebab 下拉菜单：坐标由页面算出（内联 position / top / left）。
  关键在于脱离滚动容器的裁剪：.conversation-list 的 overflow-y 与 .conversation-sidebar
  的 overflow 都裁不到 fixed 后代，菜单因此不会再被切一半（前提是祖先链上没有
  transform / filter / will-change —— 移动端抽屉用了 transform，那种情况下 fixed
  会相对抽屉定位，但抽屉本身就贴在视口左上角，观感一致）。
*/
.conversation-menu {
  z-index: 90;
  position: fixed;
  min-width: 148px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: white;
  box-shadow: 0 10px 28px rgb(15 23 42 / 14%);
}

.conversation-menu button {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  padding: 7px 9px;
  color: #475569;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12.5px;
  text-align: left;
}

.conversation-menu button:hover {
  background: #f1f5f9;
}

.conversation-menu-delete {
  color: #dc2626;
}

.conversation-menu-delete:hover {
  background: #fef2f2;
}

.conversation-rename-confirm,
.conversation-rename-cancel {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 8px;
  color: #94a3b8;
  background: transparent;
  cursor: pointer;
  font-size: 14px;
}

/* 就地编辑占据 kebab 右侧的剩余宽度，与 kebab 同处一行。 */
.conversation-rename {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
}

.conversation-rename-input {
  flex: 1 1 auto;
  min-width: 0;
  border: 1px solid #bfdbfe;
  border-radius: 9px;
  padding: 5px 8px;
  color: #1e293b;
  background: white;
  font: inherit;
  font-size: 12.5px;
}

.conversation-rename-confirm {
  color: #16a34a;
}

.conversation-rename-confirm:hover {
  background: #dcfce7;
}

.conversation-rename-error {
  flex: 1 1 100%;
  margin: 0;
  padding: 0 2px;
  color: #b91c1c;
  font-size: 11px;
}

.conversation-delete-confirm,
.conversation-delete-cancel {
  min-width: 64px;
  height: 30px;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 0 11px;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 650;
}

.conversation-delete-confirm {
  color: white;
  background: #dc2626;
}

.conversation-delete-confirm:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.conversation-delete-cancel {
  color: #475569;
  border-color: #cbd5e1;
  background: white;
}

.conversation-delete-cancel:hover:not(:disabled) {
  color: #1e293b;
  border-color: #94a3b8;
  background: #f8fafc;
}

.conversation-delete-popconfirm {
  z-index: 110;
  width: 276px;
  padding: 15px;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: white;
  box-shadow:
    0 12px 32px rgb(15 23 42 / 16%),
    0 2px 6px rgb(15 23 42 / 8%);
}

.delete-popconfirm-arrow {
  position: absolute;
  top: 15px;
  left: -6px;
  width: 11px;
  height: 11px;
  border-bottom: 1px solid #e2e8f0;
  border-left: 1px solid #e2e8f0;
  background: white;
  transform: rotate(45deg);
}

.conversation-delete-popconfirm.placement-left .delete-popconfirm-arrow {
  right: -6px;
  left: auto;
  border: 0;
  border-top: 1px solid #e2e8f0;
  border-right: 1px solid #e2e8f0;
}

.delete-popconfirm-content {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
}

.delete-popconfirm-icon {
  display: grid;
  place-items: center;
  padding-top: 1px;
  color: #f59e0b;
  font-size: 17px;
}

.delete-popconfirm-content strong {
  display: block;
  color: #0f172a;
  font-size: 13px;
  line-height: 20px;
}

.delete-popconfirm-content p {
  margin: 4px 0 0;
  color: #64748b;
  font-size: 11.5px;
  line-height: 1.55;
}

.delete-popconfirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 13px;
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
  min-height: 68px;
  display: flex;
  flex-direction: column;
  padding: 12px 24px 0;
  border-bottom: 1px solid var(--panel-border);
  background: rgb(255 255 255 / 72%);
}

.chat-title-row {
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 14px;
}

.brand-title,
.chat-title {
  color: #0f172a !important;
}

.conversation-view-tabs {
  height: 34px;
  display: flex;
  align-items: end;
  gap: 22px;
  padding-left: 0;
}

.conversation-view-tabs button {
  height: 34px;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 0 1px;
  color: #64748b;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.conversation-view-tabs button:hover {
  color: #334155;
}

.conversation-view-tabs button.active {
  border-bottom-color: #2563eb;
  color: #1d4ed8;
  font-weight: 700;
}

.menu-button,
.sidebar-close {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 11px;
  font-size: 20px;
}

/* 桌面端的收缩按钮常驻；移动端用遮罩 + 关闭按钮，因此这里隐藏桌面专用的两个入口。 */
.menu-button,
.sidebar-close,
.sidebar-backdrop {
  display: none;
}

/* 展开按钮只在侧边栏收起时出现，和标题同一条基线。 */
.sidebar-expand-button {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 11px;
  font-size: 19px;
}

.conversation-header-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
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

.conversation-refresh-button {
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 1px solid #e2e8f0;
  border-radius: 50%;
  color: #64748b;
  background: #f8fafc;
  cursor: pointer;
  font-size: 14px;
  transition:
    border-color 140ms ease,
    color 140ms ease,
    background 140ms ease;
}

.conversation-refresh-button:hover:not(:disabled) {
  border-color: #bfdbfe;
  color: #2563eb;
  background: #eff6ff;
}

.conversation-refresh-button:focus-visible {
  outline: 2px solid #60a5fa;
  outline-offset: 2px;
}

.conversation-refresh-button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

/*
  消息区的网格行外壳。
  滚动容器在 ConversationView 里（它需要自己持有 ref 才能只在自己的内容增长时滚到底），
  这里只负责占位与裁剪；没有会话时空状态直接铺满这一行。
*/
.message-area {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.composer-content {
  width: min(100%, 840px);
  margin-inline: auto;
}

.message-empty {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 28px 32px;
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

.starter-grid {
  width: min(100%, 720px);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 28px;
  text-align: left;
}

.starter-prompt {
  min-width: 0;
  min-height: 82px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 18px;
  align-items: center;
  gap: 11px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 13px 14px;
  color: #334155;
  background: rgb(255 255 255 / 78%);
  cursor: pointer;
  font: inherit;
  transition:
    border-color 150ms ease,
    box-shadow 150ms ease,
    transform 150ms ease;
}

.starter-prompt:hover:not(:disabled) {
  border-color: #94a3b8;
  box-shadow: 0 7px 18px rgb(15 23 42 / 8%);
  transform: translateY(-1px);
}

.starter-prompt:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}

.starter-prompt:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.starter-icon {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: #0369a1;
  background: #e0f2fe;
  font-size: 18px;
}

.starter-prompt:nth-child(2) .starter-icon {
  color: #b45309;
  background: #fef3c7;
}

.starter-prompt:nth-child(3) .starter-icon {
  color: #047857;
  background: #d1fae5;
}

.starter-prompt:nth-child(4) .starter-icon {
  color: #be123c;
  background: #ffe4e6;
}

.starter-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.starter-copy strong {
  color: #0f172a;
  font-size: 13px;
  font-weight: 700;
}

.starter-copy > span {
  overflow: hidden;
  display: -webkit-box;
  color: #64748b;
  font-size: 12px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.starter-arrow {
  color: #94a3b8;
  font-size: 16px;
}

.composer-area {
  z-index: 1;
  padding: 14px 24px 16px;
  border-top: 1px solid var(--panel-border);
  background: #f8fafc;
}

/*
  输入内容下方的一行：左侧模型 / 推理等级药丸，右侧圆形发送按钮。
  发送按钮用 margin-left: auto 贴右，而不是 justify-content: space-between：
  两个 chip 全部隐藏时它会是唯一子节点，只有 auto margin 才能把它留在右边。
*/
.composer-meta {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.composer-controls {
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 4px;
}

/* 药丸式 chip：自带 hover 浅底，内部的原生控件只负责取值，不再画自己的边框。 */
.model-select-control,
.reasoning-effort-control {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 3px 8px;
  color: #475569;
  background: transparent;
  cursor: pointer;
  font-size: 11.5px;
  white-space: nowrap;
  transition:
    color 140ms ease,
    border-color 140ms ease,
    background 140ms ease;
}

.model-select-control:hover,
.reasoning-effort-control:hover {
  background: #f1f5f9;
}

.model-select-control:focus-within,
.reasoning-effort-control:focus-within {
  border-color: #bfdbfe;
  background: #eff6ff;
}

.control-label {
  flex: 0 0 auto;
  color: #94a3b8;
}

/* 两个 chip 内部只保留文字：原生 select 的边框、底色与箭头都由外层药丸负责。 */
.model-select-control select,
.reasoning-effort-control select {
  appearance: none;
  max-width: 190px;
  border: 0;
  padding: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
}

.pill-caret {
  flex: 0 0 auto;
  color: #94a3b8;
  font-size: 12px;
}

.model-select-control select:disabled,
.reasoning-effort-control select:disabled {
  opacity: 0.5;
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

/*
  输入框容器：纵向堆叠，子元素顺序固定为
  .composer-resize-handle（顶部拖拽把手）→ textarea → .composer-meta（药丸控件 + 发送按钮）。
*/
.composer {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  padding: 2px 10px 8px;
  border: 1px solid #cbd5e1;
  border-radius: 18px;
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

/*
  顶部拖拽把手：整行都是命中区域（cursor: ns-resize），中间一条不显眼的短横条；
  touch-action: none 让触屏拖动不会被页面滚动手势抢走。
*/
.composer-resize-handle {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 12px;
  margin: 0 -6px;
  border-radius: 999px;
  cursor: ns-resize;
  user-select: none;
  touch-action: none;
}

.composer-resize-grip {
  width: 36px;
  height: 3px;
  border-radius: 999px;
  background: #e2e8f0;
  transition: background 140ms ease;
}

.composer-resize-handle:hover .composer-resize-grip,
.composer-resize-handle:focus-visible .composer-resize-grip {
  background: #94a3b8;
}

.composer-resize-handle:focus-visible {
  outline: 2px solid #60a5fa;
  outline-offset: -2px;
}

/*
  自增高输入框：高度与 overflow-y 由 resizeComposer 计算，
  上限来自组件常量 MAX_COMPOSER_HEIGHT（通过内联 max-height 单点声明）；
  关掉 textarea 自带的拖拽手柄，高度只由顶部把手与内容决定。
*/
.composer textarea {
  flex: 0 0 auto;
  width: 100%;
  min-width: 0;
  overflow-y: hidden;
  resize: none;
  border: 0;
  outline: 0;
  padding: 6px 0;
  color: #1e293b;
  background: transparent;
  font: inherit;
  font-size: 14px;
  line-height: 1.55;
}

.composer textarea::placeholder {
  color: #94a3b8;
}

/* 圆形图标发送按钮：无文字，只有一颗箭头图标；margin-left: auto 让它始终贴右。 */
.send-button {
  margin-left: auto;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 50%;
  color: white;
  background: linear-gradient(135deg, #2563eb, #4f46e5);
  cursor: pointer;
  font-size: 16px;
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

/* typing / reasoning-pulse 两条动画随消息区搬到了 ConversationView。 */
@keyframes pulse {
  0%,
  100% {
    opacity: 0.45;
  }

  50% {
    opacity: 1;
  }
}

@media (max-width: 760px) {
  /* 窄屏改用“抽屉 + 遮罩”，桌面端的收缩状态在这里不生效。 */
  .workspace-shell,
  .workspace-shell.sidebar-collapsed {
    width: 100%;
    height: 100%;
    display: block;
    grid-template-columns: none;
  }

  .conversation-sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    width: min(84vw, 310px);
    border-right: 1px solid var(--panel-border);
    transform: translateX(-102%);
    transition: transform 200ms ease;
  }

  .conversation-sidebar.collapsed {
    visibility: visible;
    padding-inline: 14px;
    border-right-color: var(--panel-border);
    opacity: 1;
    pointer-events: auto;
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

  .sidebar-collapse-button,
  .sidebar-expand-button {
    display: none;
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
    min-height: 64px;
    padding: 10px 16px 0;
  }

  .message-count {
    display: none;
  }

  /* 消息区（.message-list / .message-bubble）的窄屏规则已随组件迁移到 ConversationView。 */
  .message-empty {
    padding: 20px 16px;
  }

  .empty-state {
    justify-content: flex-start;
    padding-block: 24px;
  }

  .empty-icon {
    width: 58px;
    height: 58px;
    border-radius: 16px;
  }

  .starter-grid {
    grid-template-columns: minmax(0, 1fr);
    margin-top: 22px;
  }

  .starter-prompt {
    min-height: 72px;
  }

  .composer-area {
    padding: 12px 16px max(12px, env(safe-area-inset-bottom));
  }
}

@media (prefers-reduced-motion: reduce) {
  /* typing / reasoning-pulse 的动画关闭规则随消息区迁移到 ConversationView。 */
  .conversation-skeleton span {
    animation: none;
  }

  .workspace-shell,
  .conversation-sidebar,
  .conversation-sidebar.collapsed {
    transition: none;
  }
}

.starter-prompt:nth-child(5) .starter-icon {
  color: #6d28d9;
  background: #ede9fe;
}

:global(html.dark) .chat-page {
  --panel-border: rgb(51 65 85 / 70%);
  background: #0f172a;
}

:global(html.dark) .workspace-shell,
:global(html.dark) .chat-header {
  background: #0f172a;
}

:global(html.dark) .conversation-view-tabs button {
  color: #94a3b8;
}

:global(html.dark) .conversation-view-tabs button:hover {
  color: #e2e8f0;
}

:global(html.dark) .conversation-view-tabs button.active {
  color: #93c5fd;
  border-bottom-color: #60a5fa;
}

:global(html.dark) .conversation-sidebar,
:global(html.dark) .composer-area {
  background: #020617;
}

:global(html.dark) .model-select-control,
:global(html.dark) .reasoning-effort-control {
  color: #cbd5e1;
}

:global(html.dark) .model-select-control:hover,
:global(html.dark) .reasoning-effort-control:hover {
  background: #1e293b;
}

:global(html.dark) .model-select-control:focus-within,
:global(html.dark) .reasoning-effort-control:focus-within {
  border-color: #1d4ed8;
  background: #172554;
}

:global(html.dark) .model-select-control select,
:global(html.dark) .reasoning-effort-control select {
  color: #cbd5e1;
  background: transparent;
}

:global(html.dark) .composer-resize-grip {
  background: #334155;
}

:global(html.dark) .composer-resize-handle:hover .composer-resize-grip,
:global(html.dark) .composer-resize-handle:focus-visible .composer-resize-grip {
  background: #64748b;
}

:global(html.dark) .conversation-item:hover {
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

:global(html.dark) .conversation-menu-button:hover {
  color: #e2e8f0;
  background: #334155;
}

:global(html.dark) .conversation-menu {
  border-color: #334155;
  background: #1e293b;
  box-shadow: 0 10px 28px rgb(2 6 23 / 55%);
}

:global(html.dark) .conversation-menu button {
  color: #cbd5e1;
}

:global(html.dark) .conversation-menu button:hover {
  background: #334155;
}

:global(html.dark) .conversation-menu-delete {
  color: #fca5a5;
}

:global(html.dark) .conversation-menu-delete:hover {
  background: #450a0a;
}

:global(html.dark) .conversation-rename-input {
  border-color: #1d4ed8;
  color: #e2e8f0;
  background: #1e293b;
}

:global(html.dark) .conversation-delete-cancel {
  color: #cbd5e1;
  border-color: #475569;
  background: #1e293b;
}

:global(html.dark) .conversation-delete-cancel:hover:not(:disabled) {
  color: #f8fafc;
  border-color: #64748b;
  background: #334155;
}

:global(html.dark) .conversation-delete-popconfirm {
  border-color: #334155;
  background: #1e293b;
  box-shadow:
    0 12px 32px rgb(0 0 0 / 42%),
    0 2px 6px rgb(0 0 0 / 28%);
}

:global(html.dark) .delete-popconfirm-arrow {
  border-color: #334155;
  background: #1e293b;
}

:global(html.dark) .delete-popconfirm-content strong {
  color: #f8fafc;
}

:global(html.dark) .delete-popconfirm-content p {
  color: #94a3b8;
}

:global(html.dark) .conversation-rename-error,
:global(html.dark) .sidebar-notice.error {
  color: #fca5a5;
}

:global(html.dark) .sidebar-notice.error {
  background: #450a0a;
}

:global(html.dark) .message-count {
  border-color: #334155;
  color: #94a3b8;
  background: #1e293b;
}

:global(html.dark) .conversation-refresh-button {
  border-color: #334155;
  color: #94a3b8;
  background: #1e293b;
}

:global(html.dark) .conversation-refresh-button:hover:not(:disabled) {
  border-color: #1d4ed8;
  color: #bfdbfe;
  background: #172554;
}

:global(html.dark) .starter-prompt {
  border-color: #334155;
  color: #cbd5e1;
  background: rgb(30 41 59 / 76%);
}

:global(html.dark) .starter-prompt:hover:not(:disabled) {
  border-color: #64748b;
  box-shadow: 0 7px 18px rgb(0 0 0 / 22%);
}

:global(html.dark) .starter-copy strong {
  color: #f8fafc;
}

:global(html.dark) .starter-copy > span,
:global(html.dark) .starter-arrow {
  color: #94a3b8;
}

/* 消息气泡 / 思考面板 / markdown 的深色规则已随消息区迁移到 ConversationView。 */
:global(html.dark) .composer {
  border-color: #334155;
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

:global(html.dark) .composer textarea {
  color: #e2e8f0;
}
</style>
