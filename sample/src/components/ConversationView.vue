<script lang="ts">
import type { ComponentPublicInstance } from 'vue'
import MarkdownIt from 'markdown-it'
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'

/**
 * 消息区渲染用的消息形状。
 *
 * 放在普通 <script> 块里导出，父页面直接 import 同一份类型：
 * 两处各写一份 interface 迟早会漂移，而消息对象本身是页面状态（含展开状态）。
 * 导入集中在这个块里，是为了让合并后的模块保持"import 在最前"。
 */
export interface ConversationMessage {
  id: number
  role: 'user' | 'agent'
  content: string
  reasoning?: string
  isReasoningOpen?: boolean
  isStreaming?: boolean
}

/** 对话导航里的一轮：一条用户消息开启一轮，其后的 agent 消息归入同一轮。 */
export interface ConversationTurn {
  /** 该轮第一条消息的 id；同时用作导航项的 :key 与定位锚点。 */
  id: number
  /** 悬浮提示用的标题（用户消息文本截断，或「开场」）。 */
  title: string
}

/** 导航标题的截断长度：够看清是哪一轮提问，又不至于把提示撑成一段正文。 */
export const TURN_TITLE_MAX_LENGTH = 28
/** 首条就是 agent 消息（历史边界情况）时，这一轮的标题。 */
export const OPENING_TURN_TITLE = '开场'
/** 用户消息为空（理论上不该发生）时的兜底标题。 */
export const EMPTY_TURN_TITLE = '（空消息）'

/**
 * 把一条用户消息压成导航标题：折叠空白、截断超长内容。
 *
 * 抽成纯函数是为了能被直接单测——标题规则跟 DOM 无关，没必要借组件去验证。
 */
export function summarizeTurnTitle(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!text)
    return EMPTY_TURN_TITLE

  return text.length > TURN_TITLE_MAX_LENGTH ? `${text.slice(0, TURN_TITLE_MAX_LENGTH)}…` : text
}

/**
 * 纯函数：给定每一轮首行的 offsetTop 与容器当前 scrollTop，判断哪一轮占据视口顶部。
 *
 * 取"最后一个 offsetTop 不超过 scrollTop 的轮次"；没有任何轮次时返回 0。
 * 单独抽出来是因为 jsdom 没有布局，端到端很难稳定构造真实 offsetTop。
 */
export function resolveActiveTurnIndex(offsets: number[], scrollTop: number): number {
  let activeIndex = 0
  for (let index = 0; index < offsets.length; index += 1) {
    if (offsets[index]! <= scrollTop)
      activeIndex = index
  }
  return activeIndex
}
</script>

<script setup lang="ts">
defineOptions({ name: 'ConversationView' })

const props = defineProps<{
  /** 当前会话的消息列表；内容增长时组件自己跟随到底部。 */
  messages: ConversationMessage[]
  /** 是否正在等待 Agent 回答，用于展示 typing 指示器。 */
  isSending: boolean
  /** 是否还没收到首个 token；为 true 时输入区上方显示“正在思考”。 */
  isAwaitingFirstToken: boolean
}>()

/**
 * 滚动容器由组件自己持有，页面组件只负责占位与裁剪。
 *
 * 它是组件里唯一的滚动容器；对话导航刻意放在它外面，否则导航会跟着内容一起滚走。
 */
const scrollContainer = ref<HTMLElement>()
/**
 * 实例是否处于激活状态。
 *
 * 初始为 true 是为了让组件在 KeepAlive 之外也能正常工作；被 KeepAlive 停用时置为 false，
 * 此时不要跟随滚动、也不要在停用实例上继续算导航高亮。
 */
let isActive = true
/**
 * 离开（deactivate）时记下的滚动位置。
 *
 * 元素被移出文档后浏览器会丢失它的滚动偏移，重新激活时 scrollTop 会回到 0，
 * 所以必须显式保存/恢复，光靠 KeepAlive 复用 DOM 是不够的。
 */
let savedScrollTop = 0
/** 恢复滚动位置期间不要跟随到底，否则恢复动作会立刻被"滚到最新"覆盖。 */
let isRestoring = false
/** 容器上的 scroll 监听是否已经挂上，避免 mounted + activated 重复注册。 */
let isListening = false

/**
 * 消息 id → 该消息对应的行元素。
 *
 * 用函数 ref 收集：点击导航时要精确定位到"该轮第一条消息行"，靠下标猜 DOM 顺序太脆。
 */
const rowElements = new Map<number, HTMLElement>()
/** 鼠标悬浮 / 聚焦中的导航项；标题只在此时渲染，避免常驻 N 个隐藏标签。 */
const hoveredTurnId = ref<number | null>(null)
/** 当前占据视口顶部的轮次下标，用于高亮对应的小条。 */
const activeTurnIndex = ref(0)

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

/**
 * 划分轮次：一条 user 消息开启一轮，其后的 agent 消息（含思考与工具过程）归入当前轮。
 *
 * 首条就是 agent 消息时单独成一轮（历史边界情况）。计算属性随流式增量实时更新，
 * 因此导航条数量与当前轮标题都跟着消息变化走。
 */
const turns = computed<ConversationTurn[]>(() => {
  const result: ConversationTurn[] = []
  for (const message of props.messages) {
    if (message.role === 'user') {
      result.push({ id: message.id, title: summarizeTurnTitle(message.content) })
      continue
    }
    if (result.length === 0)
      result.push({ id: message.id, title: OPENING_TURN_TITLE })
  }
  return result
})

/** 收集消息行元素；元素卸载时（回调收到 null）从表里移除。 */
function setRowElement(id: number, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement)
    rowElements.set(id, element)
  else
    rowElements.delete(id)
}

/** 把滚动位置写回容器：一次性设定，不做平滑动画。 */
function applyScrollTop(element: HTMLElement, top: number): void {
  // jsdom 等环境没有实现 scrollTo；缺少它时退化为直接赋值。
  if (typeof element.scrollTo === 'function')
    element.scrollTo({ top, behavior: 'auto' })
  else
    element.scrollTop = top
}

/**
 * 滚到最新一条消息。
 *
 * 只在内容增长时调用，并且一律用 instant（behavior: 'auto'）：平滑滚动会让"切回旧会话"
 * 看起来像从头滚到底，正是产品要去掉的观感。
 */
function scrollToLatest(): void {
  const element = scrollContainer.value
  if (!element)
    return

  applyScrollTop(element, element.scrollHeight)
}

/** 离开时补记一次位置：元素可能已经被移出文档，那时读到的 scrollTop 会变成 0。 */
function captureScrollPositionOnLeave(): void {
  const element = scrollContainer.value
  // 因此只在仍然挂在文档里时更新，否则保留 scroll 监听记下的值。
  if (element && element.isConnected)
    savedScrollTop = element.scrollTop
}

/** 重新计算当前轮次：以每轮首行的 offsetTop 为界。 */
function updateActiveTurn(): void {
  const element = scrollContainer.value
  if (!element)
    return

  const offsets = turns.value.map(turn => rowElements.get(turn.id)?.offsetTop ?? 0)
  activeTurnIndex.value = resolveActiveTurnIndex(offsets, element.scrollTop)
}

/** 滚动时同时更新两个状态：记住位置（供切回恢复）与当前轮次（供导航高亮）。 */
function handleScroll(): void {
  // scroll 事件只在元素可见时触发，读到的 scrollTop 可信，直接记下最新位置。
  const element = scrollContainer.value
  if (element)
    savedScrollTop = element.scrollTop

  updateActiveTurn()
}

/** 挂上容器滚动监听；停用/卸载时移除，避免在停用实例上继续算。 */
function attachScrollListener(): void {
  const element = scrollContainer.value
  if (isListening || !element)
    return

  element.addEventListener('scroll', handleScroll, { passive: true })
  isListening = true
}

/** 移除容器滚动监听。 */
function detachScrollListener(): void {
  const element = scrollContainer.value
  if (!isListening || !element)
    return

  element.removeEventListener('scroll', handleScroll)
  isListening = false
}

/** 滚动到某一轮的第一条消息行顶部（即时定位）。 */
function scrollToTurn(turn: ConversationTurn): void {
  const row = rowElements.get(turn.id)
  // scrollIntoView 是"行顶部对齐视口顶部"语义最明确的 API；缺少实现时静默跳过。
  if (!row || typeof row.scrollIntoView !== 'function')
    return

  row.scrollIntoView({ block: 'start', behavior: 'auto' })
  // 即时定位是同步生效的，立刻刷新高亮；真实浏览器还会补一个 scroll 事件，重复算一次无副作用。
  updateActiveTurn()
}

/** 恢复离开时记下的滚动位置，然后把跟随滚动交还给内容变化。 */
async function restoreScrollPosition(): Promise<void> {
  try {
    await nextTick()
    const element = scrollContainer.value
    if (element)
      applyScrollTop(element, savedScrollTop)
    // 位置已经写回，按新位置刷新高亮。
    updateActiveTurn()
  }
  finally {
    isRestoring = false
  }
}

/** 切换会话时父页面会替换 messages；同一批对象被复用，因此这里只在真正追加内容时触发。 */
watch(
  () => props.messages,
  () => {
    if (isActive && !isRestoring)
      scrollToLatest()
  },
  { deep: true, flush: 'post' },
)

onMounted(() => {
  attachScrollListener()
  // 只有首次挂载（新打开的会话）才直接落到最新一条；KeepAlive 的重新激活不会走到这里。
  if (props.messages.length > 0)
    scrollToLatest()
  updateActiveTurn()
})

onActivated(() => {
  isActive = true
  isRestoring = true
  attachScrollListener()
  // 重新激活时恢复位置，而不是跟到底：停在用户离开时看的地方。
  void restoreScrollPosition()
})

onDeactivated(() => {
  isActive = false
  captureScrollPositionOnLeave()
  detachScrollListener()
  hoveredTurnId.value = null
})

onBeforeUnmount(() => {
  detachScrollListener()
})
</script>

<template>
  <div class="conversation-view">
    <div ref="scrollContainer" class="message-list">
      <!-- 会话已建立但还没有任何消息：与页面级空状态保持同一套观感。 -->
      <div v-if="messages.length === 0" class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <div i-carbon-chat-bot text-8 />
        </div>
        <h2 class="text-6 text-slate-900 tracking-tight font-700 mb-0 mt-5 dark:text-white">
          开始一段新对话
        </h2>
        <p class="text-3.5 text-slate-500 leading-6 mb-0 mt-2 max-w-110 dark:text-slate-400">
          第一条消息不会携带 sessionId，服务端返回后会自动关联后续上下文。
        </p>
      </div>

      <div v-else class="message-content">
        <!--
          角色靠排版区分而不是头像与气泡：Agent 回复占满对话区宽度、无头像、无气泡，
          只保留与用户气泡相同的左右内边距，让正文左边缘对齐同一条基线。
        -->
        <article
          v-for="message in messages"
          :key="message.id"
          :ref="element => setRowElement(message.id, element)"
          class="message-row"
          :class="message.role === 'user' ? 'user-row' : 'agent-row'"
        >
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

        <div v-if="isSending && isAwaitingFirstToken" class="message-row agent-row">
          <div class="typing-indicator" aria-label="Agent 正在思考">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </div>

    <!--
      对话导航：在滚动容器之外，否则它会跟着内容滚走。
      横条只占左侧一条窄带，标题在悬浮/聚焦时才渲染成右侧的小卡片。
    -->
    <nav v-if="turns.length > 1" class="turn-nav" aria-label="对话导航">
      <button
        v-for="(turn, index) in turns"
        :key="turn.id"
        class="turn-nav-item"
        :class="{ active: index === activeTurnIndex }"
        type="button"
        :aria-label="turn.title"
        :aria-current="index === activeTurnIndex ? 'true' : undefined"
        @click="scrollToTurn(turn)"
        @mouseenter="hoveredTurnId = turn.id"
        @mouseleave="hoveredTurnId = null"
        @focus="hoveredTurnId = turn.id"
        @blur="hoveredTurnId = null"
      >
        <span class="turn-nav-bar" aria-hidden="true" />
        <span v-if="hoveredTurnId === turn.id" class="turn-nav-label">{{ turn.title }}</span>
      </button>
    </nav>
  </div>
</template>

<style scoped>
/*
  包裹层：滚动容器与对话导航的共同定位上下文。
  导航贴在包裹层左侧（因此在滚动容器之外），滚动容器是这一层里唯一的滚动来源。
*/
.conversation-view {
  position: relative;
  flex: 1 1 auto;
  height: 100%;
  min-height: 0;
}

/*
  消息区滚动容器。
  左侧比右侧多留一点内边距，给导航的小条腾出真正的空白。
*/
.message-list {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 28px 32px 28px 40px;
  scrollbar-color: #cbd5e1 transparent;
  scrollbar-width: thin;
}

/* 对话导航：垂直中点的一列横条，只占左侧一条窄带。 */
.turn-nav {
  z-index: 5;
  position: absolute;
  left: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.turn-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 14px;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.turn-nav-bar {
  width: 20px;
  height: 3px;
  border-radius: 999px;
  background: #cbd5e1;
  transition:
    width 140ms ease,
    height 140ms ease,
    background 140ms ease;
}

/* 悬浮 / 键盘聚焦 / 当前轮次：横条变长变深。 */
.turn-nav-item:hover .turn-nav-bar,
.turn-nav-item:focus-visible .turn-nav-bar {
  width: 28px;
  height: 4px;
  background: #94a3b8;
}

.turn-nav-item.active .turn-nav-bar {
  width: 28px;
  height: 4px;
  background: #2563eb;
}

/* 标题卡片：只在悬浮 / 聚焦时渲染，绝对定位在条的右侧，不参与布局也不吃点击。 */
.turn-nav-label {
  position: absolute;
  left: calc(100% + 6px);
  top: 50%;
  transform: translateY(-50%);
  max-width: 260px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 4px 8px;
  color: #334155;
  background: white;
  box-shadow: 0 6px 18px rgb(15 23 42 / 12%);
  font-size: 11.5px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}

.message-content {
  width: min(100%, 840px);
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  gap: 22px;
}

/*
  空状态样式在页面里也有一份：页面负责“还没有激活会话”，组件负责“会话里还没有消息”，
  scoped 样式不跨组件，所以两边各自保留一份同样观感的规则。
*/
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
  display: grid;
  place-items: center;
  color: white;
  background: linear-gradient(145deg, #2563eb, #4f46e5);
  box-shadow: 0 8px 20px rgb(37 99 235 / 25%);
}

.message-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

/* 用户消息靠右，Agent 回复靠左并占满整行；两者共用同一套左右内边距。 */
.message-row.user-row {
  justify-content: flex-end;
}

.message-row.agent-row {
  justify-content: flex-start;
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

/*
  Agent 回复不是气泡：没有边框、底色、阴影与头像，宽度占满对话区，
  只保留与用户气泡一致的左右内边距，让正文与其它消息对齐在同一条基线上。
*/
.message-bubble.agent {
  width: 100%;
  max-width: 100%;
  padding: 0 15px;
  border: 0;
  border-radius: 0;
  color: #334155;
  background: transparent;
  box-shadow: none;
}

.message-bubble.agent.has-reasoning {
  min-width: 0;
  padding: 0 15px;
}

.reasoning-panel {
  margin-bottom: 10px;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
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
  padding: 0 14px 12px 35px;
  color: #64748b;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.65;
  scrollbar-color: #cbd5e1 transparent;
  scrollbar-width: thin;
}

/* Agent 正文不再有气泡内边距，只有外层 Bubble 保留 15px，避免出现双重缩进。 */
.answer-content,
.answer-pending {
  padding: 0;
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

/* Agent 等待首个 token：与其它 Agent 内容一样无头像、无气泡，只保留同样的左右内边距。 */
.typing-indicator {
  display: flex;
  gap: 5px;
  padding: 6px 15px;
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

@keyframes reasoning-pulse {
  70% {
    box-shadow: 0 0 0 6px rgb(99 102 241 / 0%);
  }

  100% {
    box-shadow: 0 0 0 0 rgb(99 102 241 / 0%);
  }
}

/* 正文被挤窄之前先撤掉导航：导航只是辅助入口，正文字宽优先。 */
@media (max-width: 900px) {
  .turn-nav {
    display: none;
  }

  .message-list {
    padding-left: 20px;
  }
}

@media (max-width: 760px) {
  .message-list {
    padding: 20px 16px;
  }

  .message-bubble {
    max-width: 84%;
  }

  /* 无气泡的 Agent 回复在窄屏同样占满宽度，只有用户气泡受 84% 限制。 */
  .message-bubble.agent {
    max-width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .typing-indicator span,
  .reasoning-pulse {
    animation: none;
  }

  .turn-nav-bar {
    transition: none;
  }
}

:global(html.dark) .message-bubble.agent {
  color: #e2e8f0;
  background: transparent;
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

:global(html.dark) .turn-nav-bar {
  background: #475569;
}

:global(html.dark) .turn-nav-item:hover .turn-nav-bar,
:global(html.dark) .turn-nav-item:focus-visible .turn-nav-bar {
  background: #94a3b8;
}

:global(html.dark) .turn-nav-item.active .turn-nav-bar {
  background: #60a5fa;
}

:global(html.dark) .turn-nav-label {
  border-color: #334155;
  color: #e2e8f0;
  background: #1e293b;
  box-shadow: 0 6px 18px rgb(2 6 23 / 55%);
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
</style>
