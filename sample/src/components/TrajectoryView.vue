<script setup lang="ts">
import type { AgentEvent } from 'craft-harness'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

interface TrajectoryRecord {
  sequence: number
  event: AgentEvent
}

interface ToolDefinitionView {
  name: string
  description: string
  inputSchema: unknown
}

interface TrajectoryResponse {
  data: {
    sessionId: string
    events: TrajectoryRecord[]
    hasEarlier: boolean
    nextBeforeSequence?: number
    systemPrompt: string
    tools: Record<string, ToolDefinitionView>
    userInputs: TrajectoryUserInput[]
    sessionMessages?: TrajectorySessionMessage[]
  }
}

interface TrajectoryUserInput {
  eventId: string
  sequence: number
  timestamp: string
  runId?: string
  turnId?: string
  content: string
}

interface TrajectoryToolCall {
  id: string
  type: string
  function?: {
    name: string
    arguments: string
  }
  custom?: {
    name: string
    input: string
  }
}

interface TrajectorySessionMessage {
  eventId: string
  sequence: number
  timestamp: string
  runId?: string
  turnId?: string
  message: {
    role: 'user' | 'assistant'
    content?: string | null
    reasoning_content?: string | null
    tool_calls?: TrajectoryToolCall[]
  }
}

type TraceKind = 'system' | 'user' | 'assistant' | 'tool'
type DetailTab = 'systemPrompt' | 'tools' | 'overview' | 'input' | 'output' | 'schema' | 'timing'

interface TraceItem {
  id: string
  sequence: number
  runId: string
  turnId: string
  step?: number
  kind: TraceKind
  title: string
  summary: string
  status: 'completed' | 'failed' | 'stopped' | 'running'
  startedAt: string
  endedAt?: string
  durationMs?: number
  input?: unknown
  output?: unknown
  schema?: unknown
  raw: unknown
}

interface TraceTurn {
  id: string
  index: number
  status: TraceItem['status']
  startedAt: string
  endedAt?: string
  items: TraceItem[]
}

const props = defineProps<{
  sessionId: string
  scopeId: string
}>()

const records = ref<TrajectoryRecord[]>([])
const systemPrompt = ref('')
const tools = ref<Record<string, ToolDefinitionView>>({})
const userInputs = ref<TrajectoryUserInput[]>([])
const sessionMessages = ref<TrajectorySessionMessage[]>([])
const isLoading = ref(false)
const isLoadingEarlier = ref(false)
const errorMessage = ref('')
const hasEarlier = ref(false)
const nextBeforeSequence = ref<number>()
const search = ref('')
const useActualDuration = ref(false)
const collapsedTurns = ref(new Set<string>())
const compactToolCalls = ref(false)
const selectedItemId = ref('')
const detailTab = ref<DetailTab>('overview')
const detailWidth = ref(390)
const eventDetailTabs: readonly { id: DetailTab, label: string }[] = [
  { id: 'overview', label: '概述' },
  { id: 'input', label: '参数' },
  { id: 'output', label: '结果' },
  { id: 'schema', label: 'Schema' },
  { id: 'timing', label: '计时' },
]
const systemDetailTabs: readonly { id: DetailTab, label: string }[] = [
  { id: 'systemPrompt', label: '系统提示词' },
  { id: 'tools', label: '工具' },
]
let detailResize: { startX: number, startWidth: number } | undefined

const turns = computed<TraceTurn[]>(() => buildTurns(
  records.value,
  tools.value,
  userInputs.value,
  sessionMessages.value,
))
const systemItem = computed<TraceItem>(() => ({
  id: 'trajectory-system-bootstrap',
  sequence: 0,
  runId: 'trajectory-system-bootstrap',
  turnId: 'trajectory-system-bootstrap',
  kind: 'system',
  title: '初始系统提示词',
  summary: systemPrompt.value || `已注册 ${Object.keys(tools.value).length} 个工具`,
  status: 'completed',
  startedAt: userInputs.value[0]?.timestamp ?? records.value[0]?.event.timestamp ?? '',
  input: systemPrompt.value,
  output: tools.value,
  raw: { systemPrompt: systemPrompt.value, tools: tools.value },
}))
const visibleSystemItem = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return !query || itemSearchText(systemItem.value).includes(query)
})
const visibleTurns = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  if (!query)
    return turns.value
  return turns.value.flatMap((turn) => {
    const items = turn.items.filter(item => itemSearchText(item).includes(query))
    return items.length ? [{ ...turn, items }] : []
  })
})
const selectedItem = computed(() => (
  selectedItemId.value === systemItem.value.id
    ? systemItem.value
    : turns.value.flatMap(turn => turn.items).find(item => item.id === selectedItemId.value)
))
const detailTabs = computed(() => selectedItem.value?.kind === 'system'
  ? systemDetailTabs
  : eventDetailTabs)
const metrics = computed(() => buildMetrics(records.value, turns.value))
const timelineItems = computed(() => visibleTurns.value.flatMap(turn => turn.items))
const timelineBounds = computed(() => {
  const timestamps = timelineItems.value.flatMap((item) => {
    const values = [Date.parse(item.startedAt)]
    if (item.endedAt)
      values.push(Date.parse(item.endedAt))
    return values.filter(Number.isFinite)
  })
  const start = timestamps.length ? Math.min(...timestamps) : 0
  const end = timestamps.length ? Math.max(...timestamps) : start + 1
  return { start, span: Math.max(1, end - start) }
})

watch(() => props.sessionId, () => {
  void loadTrajectory(true)
}, { immediate: true })

async function loadTrajectory(reset: boolean): Promise<void> {
  if (!props.sessionId)
    return
  const loading = reset ? isLoading : isLoadingEarlier
  loading.value = true
  errorMessage.value = ''
  try {
    const cursor = reset ? undefined : nextBeforeSequence.value
    const query = new URLSearchParams({ limit: '240' })
    if (cursor !== undefined)
      query.set('beforeSequence', String(cursor))
    const response = await fetch(
      `/api/conversation/${encodeURIComponent(props.sessionId)}/trajectory?${query}`,
      { headers: { 'X-Craft-Scope-Id': props.scopeId } },
    )
    const payload = await response.json() as TrajectoryResponse | { message?: string }
    if (!response.ok)
      throw new Error('message' in payload && payload.message ? payload.message : '轨迹加载失败')
    const page = (payload as TrajectoryResponse).data
    records.value = reset
      ? page.events
      : mergeRecords(page.events, records.value)
    systemPrompt.value = page.systemPrompt
    tools.value = page.tools
    userInputs.value = page.userInputs
    sessionMessages.value = page.sessionMessages ?? []
    hasEarlier.value = page.hasEarlier
    nextBeforeSequence.value = page.nextBeforeSequence
    if (reset) {
      selectedItemId.value = ''
      collapsedTurns.value = new Set()
    }
  }
  catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '轨迹加载失败'
  }
  finally {
    loading.value = false
  }
}

function mergeRecords(earlier: TrajectoryRecord[], current: TrajectoryRecord[]): TrajectoryRecord[] {
  const bySequence = new Map<number, TrajectoryRecord>()
  for (const record of [...earlier, ...current])
    bySequence.set(record.sequence, record)
  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence)
}

function buildTurns(
  source: TrajectoryRecord[],
  definitions: Record<string, ToolDefinitionView>,
  inputs: TrajectoryUserInput[],
  messages: TrajectorySessionMessage[],
): TraceTurn[] {
  const recordsByRun = new Map<string, TrajectoryRecord[]>()
  for (const record of source) {
    const runId = record.event.runId
    if (!recordsByRun.has(runId))
      recordsByRun.set(runId, [])
    recordsByRun.get(runId)!.push(record)
  }

  const inputsByRun = new Map<string, TrajectoryUserInput[]>()
  for (const input of inputs) {
    const correlatedRun = input.runId
      ?? source.find(record => record.event.turnId === input.turnId)?.event.runId
    const runKey = correlatedRun ?? `input:${input.eventId}`
    const runInputs = inputsByRun.get(runKey) ?? []
    runInputs.push(input)
    inputsByRun.set(runKey, runInputs)
  }

  const assistantMessagesByRun = new Map<string, TrajectorySessionMessage[]>()
  for (const message of messages) {
    if (message.message.role !== 'assistant')
      continue
    const correlatedRun = message.runId
      ?? source.find(record => record.event.turnId === message.turnId)?.event.runId
    if (!correlatedRun)
      continue
    const runMessages = assistantMessagesByRun.get(correlatedRun) ?? []
    runMessages.push(message)
    assistantMessagesByRun.set(correlatedRun, runMessages)
  }

  const runOrder = [...new Set([...recordsByRun.keys(), ...inputsByRun.keys()])]
    .sort((left, right) => {
      const leftTime = inputsByRun.get(left)?.[0]?.timestamp
        ?? recordsByRun.get(left)?.[0]?.event.timestamp
        ?? ''
      const rightTime = inputsByRun.get(right)?.[0]?.timestamp
        ?? recordsByRun.get(right)?.[0]?.event.timestamp
        ?? ''
      return Date.parse(leftTime) - Date.parse(rightTime)
    })

  return runOrder.map((runId, index) => {
    const runRecords = recordsByRun.get(runId) ?? []
    const runInputs = inputsByRun.get(runId) ?? []
    const runAssistantMessages = assistantMessagesByRun.get(runId) ?? []
    const started = runRecords.find(record => record.event.type === 'agent.run.started')
    const terminal = [...runRecords].reverse().find(record => (
      record.event.type === 'agent.run.completed'
      || record.event.type === 'agent.run.stopped'
      || record.event.type === 'agent.run.failed'
    ))
    const turnId = runRecords[0]?.event.turnId ?? runInputs[0]?.turnId ?? runId
    const status = terminal?.event.type === 'agent.run.completed'
      ? 'completed'
      : terminal?.event.type === 'agent.run.failed'
        ? 'failed'
        : terminal?.event.type === 'agent.run.stopped'
          ? 'stopped'
          : runRecords.length ? 'running' : 'completed'
    const items: TraceItem[] = runInputs.map(input => ({
      id: `user:${input.eventId}`,
      sequence: input.sequence,
      runId,
      turnId,
      kind: 'user',
      title: '用户',
      summary: input.content,
      status: 'completed',
      startedAt: input.timestamp,
      endedAt: input.timestamp,
      durationMs: 0,
      input: input.content,
      raw: input,
    }))

    const stepStarts = new Map<number, TrajectoryRecord>()
    const stepEnds = new Map<number, TrajectoryRecord>()
    const callEnds = new Map<string, AgentEvent>()
    const callLifecycle = new Map<string, AgentEvent[]>()
    for (const record of runRecords) {
      const event = record.event
      if (event.type === 'agent.step.started')
        stepStarts.set(event.step, record)
      else if (event.type === 'agent.step.completed')
        stepEnds.set(event.step, record)
      else if (event.type === 'agent.tool.call.completed')
        callEnds.set(event.callId, event)
      if (event.type === 'agent.tool.event') {
        const lifecycle = callLifecycle.get(event.event.callId) ?? []
        lifecycle.push(event)
        callLifecycle.set(event.event.callId, lifecycle)
      }
    }

    const orderedSteps = [...stepStarts.keys()].sort((left, right) => left - right)
    const sessionAssistantSteps = new Set<number>()
    for (const [messageIndex, sessionMessage] of runAssistantMessages.entries()) {
      const step = orderedSteps[messageIndex] ?? messageIndex + 1
      const stepStart = stepStarts.get(step)
      const stepEnd = stepEnds.get(step)
      const content = sessionMessage.message.content?.trim() ?? ''
      const reasoning = sessionMessage.message.reasoning_content?.trim() ?? ''
      const toolCalls = sessionMessage.message.tool_calls ?? []
      const toolNames = toolCalls.map(toolCallName).filter(Boolean)
      if (!content && !reasoning && toolNames.length === 0)
        continue
      sessionAssistantSteps.add(step)
      const startedAt = stepStart?.event.timestamp ?? sessionMessage.timestamp
      const endedAt = stepEnd?.event.timestamp ?? sessionMessage.timestamp
      items.push({
        id: `${runId}:session-model:${sessionMessage.eventId}`,
        sequence: stepStart?.sequence ?? sessionMessage.sequence,
        runId,
        turnId,
        step,
        kind: 'assistant',
        title: `LLM #${step}`,
        summary: content || reasoning || `调用工具 ${toolNames.join('、')}`,
        status: stepEnd ? 'completed' : status,
        startedAt,
        endedAt,
        durationMs: durationBetween(startedAt, endedAt),
        input: started?.event.type === 'agent.run.started'
          ? {
              modelStep: step,
              provider: started.event.provider,
              model: started.event.model,
              modelExecution: started.event.modelExecution,
            }
          : { modelStep: step },
        output: {
          ...(reasoning ? { reasoning } : {}),
          ...(content ? { content } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(stepEnd?.event.type === 'agent.step.completed'
            ? {
                outcome: stepEnd.event.outcome,
                finishReason: stepEnd.event.finishReason,
                usage: stepEnd.event.usage,
              }
            : {}),
        },
        raw: sessionMessage,
      })
    }

    for (const record of runRecords) {
      const event = record.event
      if (event.type === 'agent.model.completed') {
        if (sessionAssistantSteps.has(event.step))
          continue
        const choice = event.completion.choices.find(item => item.index === 0)
          ?? event.completion.choices[0]
        if (!choice)
          continue
        const message = choice.message
        const content = typeof message.content === 'string' ? message.content.trim() : ''
        const reasoning = typeof message.reasoning_content === 'string'
          ? message.reasoning_content.trim()
          : ''
        if (!content && !reasoning)
          continue
        const stepStart = stepStarts.get(event.step)
        const stepEnd = stepEnds.get(event.step)
        items.push({
          id: `${runId}:model:${event.step}`,
          sequence: record.sequence,
          runId,
          turnId,
          step: event.step,
          kind: 'assistant',
          title: `LLM #${event.step}`,
          summary: content || reasoning,
          status: 'completed',
          startedAt: stepStart?.event.timestamp ?? event.timestamp,
          endedAt: stepEnd?.event.timestamp ?? event.timestamp,
          durationMs: durationBetween(stepStart?.event.timestamp ?? event.timestamp, stepEnd?.event.timestamp ?? event.timestamp),
          input: { modelStep: event.step },
          output: {
            ...(reasoning ? { reasoning } : {}),
            ...(content ? { content } : {}),
            finishReason: choice.finish_reason,
            usage: event.completion.usage,
          },
          raw: event,
        })
        continue
      }

      if (event.type !== 'agent.tool.call.started')
        continue
      const completed = callEnds.get(event.callId)
      const result = completed?.type === 'agent.tool.call.completed' ? completed.result : undefined
      const definition = definitions[event.toolName]
      items.push({
        id: `${runId}:tool:${event.callId}`,
        sequence: record.sequence,
        runId,
        turnId,
        step: event.step,
        kind: 'tool',
        title: event.toolName,
        summary: summarizeToolResult(event.arguments, result),
        status: result ? (result.ok ? 'completed' : 'failed') : 'running',
        startedAt: event.timestamp,
        endedAt: completed?.timestamp,
        durationMs: result?.durationMs,
        input: parseArguments(event.arguments),
        output: result?.ok ? result.value : result?.error,
        schema: definition
          ? {
              name: definition.name,
              description: definition.description,
              inputSchema: definition.inputSchema,
            }
          : undefined,
        raw: {
          call: event,
          lifecycle: callLifecycle.get(event.callId) ?? [],
          completed,
        },
      })
    }

    items.sort(compareTraceItems)

    return {
      id: runId,
      index: index + 1,
      status,
      startedAt: runInputs[0]?.timestamp ?? started?.event.timestamp ?? runRecords[0]?.event.timestamp ?? '',
      endedAt: terminal?.event.timestamp,
      items,
    }
  })
}

function toolCallName(call: TrajectoryToolCall): string {
  return call.function?.name ?? call.custom?.name ?? ''
}

function compareTraceItems(left: TraceItem, right: TraceItem): number {
  if (left.kind === 'user' || right.kind === 'user') {
    if (left.kind !== right.kind)
      return left.kind === 'user' ? -1 : 1
    return left.sequence - right.sequence
  }
  const leftStep = left.step ?? Number.MAX_SAFE_INTEGER
  const rightStep = right.step ?? Number.MAX_SAFE_INTEGER
  if (leftStep !== rightStep)
    return leftStep - rightStep
  if (left.kind !== right.kind)
    return left.kind === 'assistant' ? -1 : 1
  return Date.parse(left.startedAt) - Date.parse(right.startedAt)
}

function buildMetrics(source: TrajectoryRecord[], builtTurns: TraceTurn[]) {
  let steps = 0
  let toolCalls = 0
  let promptTokens = 0
  let completionTokens = 0
  const firstTokenDurations: number[] = []
  const stepStarts = new Map<string, string>()

  for (const record of source) {
    const event = record.event
    const stepKey = 'step' in event ? `${event.runId}:${event.step}` : ''
    if (event.type === 'agent.step.started') {
      stepStarts.set(stepKey, event.timestamp)
    }
    else if (event.type === 'agent.model.chunk') {
      const startedAt = stepStarts.get(stepKey)
      if (startedAt)
        firstTokenDurations.push(durationBetween(startedAt, event.timestamp))
    }
    else if (event.type === 'agent.run.completed'
      || event.type === 'agent.run.stopped'
      || event.type === 'agent.run.failed') {
      steps += event.result.steps
      toolCalls += event.result.toolCalls
      promptTokens += event.result.usage.prompt_tokens
      completionTokens += event.result.usage.completion_tokens
    }
  }
  const totalDuration = builtTurns.reduce((sum, turn) => (
    sum + (turn.endedAt ? durationBetween(turn.startedAt, turn.endedAt) : 0)
  ), 0)
  return {
    turns: builtTurns.length,
    steps,
    toolCalls,
    totalDuration,
    promptTokens,
    completionTokens,
    firstToken: firstTokenDurations.length
      ? Math.round(firstTokenDurations.reduce((sum, value) => sum + value, 0) / firstTokenDurations.length)
      : undefined,
  }
}

function parseArguments(value: string): unknown {
  try {
    return JSON.parse(value)
  }
  catch {
    return value
  }
}

function summarizeToolResult(argumentsText: string, result: unknown): string {
  const input = compactText(argumentsText)
  if (!result || typeof result !== 'object')
    return input
  const value = result as Record<string, unknown>
  const suffix = value.ok === true
    ? compactText(typeof value.content === 'string' ? value.content : formatJson(value.value))
    : compactText(formatJson(value.error))
  return suffix ? `${input} → ${suffix}` : input
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 260)
}

function itemSearchText(item: TraceItem): string {
  return [item.title, item.summary, formatJson(item.input), formatJson(item.output)]
    .join(' ')
    .toLocaleLowerCase()
}

function formatJson(value: unknown): string {
  if (value === undefined)
    return '无数据'
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value, null, 2)
  }
  catch {
    return String(value)
  }
}

function durationBetween(start: string, end: string): number {
  const value = Date.parse(end) - Date.parse(start)
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function formatDuration(value?: number): string {
  if (value === undefined)
    return '进行中'
  if (value < 1000)
    return `${Math.round(value)} 毫秒`
  if (value < 60_000)
    return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} 秒`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

function formatTokens(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}M`
    : value >= 1000
      ? `${(value / 1000).toFixed(1)}K`
      : String(value)
}

function formatTimestamp(value?: string): string {
  if (!value)
    return '未知'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function kindLabel(kind: TraceKind): string {
  if (kind === 'system')
    return '系统'
  if (kind === 'user')
    return '用户'
  if (kind === 'tool')
    return '工具'
  if (kind === 'assistant')
    return 'LLM'
  return '工具'
}

function statusLabel(status: TraceItem['status']): string {
  return {
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    running: '进行中',
  }[status]
}

function toggleTurn(turnId: string): void {
  const next = new Set(collapsedTurns.value)
  if (next.has(turnId))
    next.delete(turnId)
  else
    next.add(turnId)
  collapsedTurns.value = next
}

function toggleAllTurns(): void {
  collapsedTurns.value = collapsedTurns.value.size === turns.value.length
    ? new Set()
    : new Set(turns.value.map(turn => turn.id))
}

function selectItem(item: TraceItem): void {
  selectedItemId.value = item.id
  detailTab.value = item.kind === 'system' ? 'systemPrompt' : 'overview'
}

function closeDetails(): void {
  selectedItemId.value = ''
}

function timelineStyle(item: TraceItem, index: number): Record<string, string> {
  if (!useActualDuration.value) {
    const count = Math.max(1, timelineItems.value.length)
    return {
      left: `${(index / count) * 100}%`,
      width: `${Math.max(0.65, 82 / count)}%`,
    }
  }
  const start = Date.parse(item.startedAt)
  const left = Number.isFinite(start)
    ? ((start - timelineBounds.value.start) / timelineBounds.value.span) * 100
    : 0
  const width = Math.max(0.65, ((item.durationMs ?? 1) / timelineBounds.value.span) * 100)
  return { left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }
}

function beginDetailResize(event: PointerEvent): void {
  detailResize = { startX: event.clientX, startWidth: detailWidth.value }
  window.addEventListener('pointermove', moveDetailResize)
  window.addEventListener('pointerup', endDetailResize, { once: true })
}

function moveDetailResize(event: PointerEvent): void {
  if (!detailResize)
    return
  detailWidth.value = Math.min(620, Math.max(300, detailResize.startWidth - (event.clientX - detailResize.startX)))
}

function endDetailResize(): void {
  detailResize = undefined
  window.removeEventListener('pointermove', moveDetailResize)
}

onBeforeUnmount(() => {
  window.removeEventListener('pointermove', moveDetailResize)
  window.removeEventListener('pointerup', endDetailResize)
})
</script>

<template>
  <section class="trajectory-view" aria-label="会话轨迹">
    <div class="trajectory-toolbar" role="toolbar" aria-label="轨迹工具栏">
      <button
        class="toolbar-toggle"
        type="button"
        :aria-pressed="useActualDuration"
        title="使用实际时长"
        @click="useActualDuration = !useActualDuration"
      >
        <div i-carbon-time aria-hidden="true" />
        <span>时长</span>
      </button>
      <button class="toolbar-action" type="button" @click="toggleAllTurns">
        <div v-if="collapsedTurns.size === turns.length" i-carbon-expand-all aria-hidden="true" />
        <div v-else i-carbon-collapse-all aria-hidden="true" />
        <span>{{ collapsedTurns.size === turns.length ? '展开轮次' : '收起轮次' }}</span>
      </button>
      <button class="toolbar-action" type="button" @click="compactToolCalls = !compactToolCalls">
        <div v-if="compactToolCalls" i-carbon-row-expand aria-hidden="true" />
        <div v-else i-carbon-row-collapse aria-hidden="true" />
        <span>{{ compactToolCalls ? '展开调用' : '收起调用' }}</span>
      </button>
      <label class="trajectory-search">
        <div i-carbon-search aria-hidden="true" />
        <input v-model="search" type="search" placeholder="搜索" aria-label="搜索轨迹">
      </label>
      <button
        class="toolbar-icon"
        type="button"
        :disabled="isLoading"
        title="刷新轨迹"
        aria-label="刷新轨迹"
        @click="loadTrajectory(true)"
      >
        <div i-carbon-renew :class="{ 'animate-spin': isLoading }" />
      </button>
    </div>

    <div v-if="isLoading && records.length === 0" class="trajectory-state">
      <span class="trajectory-spinner" />
      <span>正在加载轨迹</span>
    </div>
    <div v-else-if="errorMessage && records.length === 0" class="trajectory-state error" role="alert">
      <div i-carbon-warning-alt />
      <span>{{ errorMessage }}</span>
      <button type="button" @click="loadTrajectory(true)">
        重新加载
      </button>
    </div>
    <template v-else>
      <div class="timeline-overview" aria-label="时间线概览">
        <button
          v-if="hasEarlier"
          class="load-earlier-dot"
          type="button"
          :disabled="isLoadingEarlier"
          title="加载更早的历史"
          aria-label="加载更早的历史"
          @click="loadTrajectory(false)"
        >
          {{ isLoadingEarlier ? '·' : '…' }}
        </button>
        <div class="timeline-track">
          <button
            v-for="(item, index) in timelineItems"
            :key="item.id"
            class="timeline-segment"
            :class="[`kind-${item.kind}`, { active: selectedItemId === item.id }]"
            :style="timelineStyle(item, index)"
            type="button"
            :title="`${item.title} · ${formatDuration(item.durationMs)}`"
            @click="selectItem(item)"
          />
        </div>
      </div>

      <div class="trajectory-workspace" :class="{ 'has-details': selectedItem }">
        <div class="event-pane">
          <button
            v-if="visibleSystemItem"
            class="event-row system-row kind-system"
            :class="{ selected: selectedItemId === systemItem.id }"
            type="button"
            @click="selectItem(systemItem)"
          >
            <span class="event-rail" />
            <span class="event-kind">系统</span>
            <span class="event-content">
              <strong>初始系统提示词</strong>
              <span>{{ systemItem.summary }}</span>
            </span>
            <span class="event-duration" />
            <div i-carbon-chevron-right class="event-chevron" aria-hidden="true" />
          </button>

          <button
            v-if="hasEarlier"
            class="load-earlier-button"
            type="button"
            :disabled="isLoadingEarlier"
            @click="loadTrajectory(false)"
          >
            <div i-carbon-time />
            {{ isLoadingEarlier ? '加载中…' : '加载更早的历史' }}
          </button>

          <section v-for="turn in visibleTurns" :key="turn.id" class="trace-turn">
            <button class="turn-boundary" type="button" @click="toggleTurn(turn.id)">
              <span class="turn-index">第 {{ turn.index }} 轮</span>
              <span class="turn-status" :class="`status-${turn.status}`">{{ statusLabel(turn.status) }}</span>
              <span>{{ formatTimestamp(turn.startedAt) }}</span>
              <div v-if="collapsedTurns.has(turn.id)" i-carbon-chevron-down aria-hidden="true" />
              <div v-else i-carbon-chevron-up aria-hidden="true" />
            </button>

            <div v-if="!collapsedTurns.has(turn.id)" class="event-list">
              <button
                v-for="item in turn.items"
                :key="item.id"
                class="event-row"
                :class="[
                  `kind-${item.kind}`,
                  { selected: selectedItemId === item.id, compact: compactToolCalls && item.kind === 'tool' },
                ]"
                type="button"
                @click="selectItem(item)"
              >
                <span class="event-rail" />
                <span class="event-kind">{{ kindLabel(item.kind) }}</span>
                <span class="event-content">
                  <strong v-if="item.kind !== 'user'">{{ item.title }}</strong>
                  <span v-if="!(compactToolCalls && item.kind === 'tool')">{{ item.summary }}</span>
                </span>
                <span class="event-duration">{{ item.kind === 'user' ? '' : formatDuration(item.durationMs) }}</span>
                <div i-carbon-chevron-right class="event-chevron" aria-hidden="true" />
              </button>
            </div>
          </section>

          <div v-if="visibleTurns.length === 0 && !visibleSystemItem" class="search-empty">
            没有匹配“{{ search }}”的轨迹事件
          </div>
          <div v-else-if="visibleTurns.length === 0" class="search-empty">
            尚无用户轮次
          </div>
        </div>

        <aside
          v-if="selectedItem"
          class="detail-pane"
          :style="{ width: `${detailWidth}px` }"
          aria-label="事件详情"
        >
          <div
            class="detail-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整事件详情宽度"
            @pointerdown="beginDetailResize"
          />
          <header class="detail-header">
            <div>
              <span :class="`kind-${selectedItem.kind}`">{{ kindLabel(selectedItem.kind) }}</span>
              <strong>{{ selectedItem.title }}</strong>
              <small v-if="selectedItem.kind === 'system'">会话启动快照</small>
              <small v-else>第 {{ turns.find(turn => turn.id === selectedItem?.runId)?.index }} 轮 · 步骤 {{ selectedItem.step ?? '运行' }}</small>
            </div>
            <button type="button" title="关闭详情" aria-label="关闭详情" @click="closeDetails">
              <div i-carbon-close />
            </button>
          </header>

          <div class="detail-tabs" role="tablist" aria-label="事件详情">
            <button
              v-for="tab in detailTabs"
              :key="tab.id"
              type="button"
              role="tab"
              :aria-selected="detailTab === tab.id"
              :class="{ active: detailTab === tab.id }"
              @click="detailTab = tab.id"
            >
              {{ tab.label }}
            </button>
          </div>

          <div class="detail-body" role="tabpanel">
            <pre v-if="detailTab === 'systemPrompt'" class="detail-code system-prompt">{{ systemPrompt || '未配置系统提示词' }}</pre>
            <div v-else-if="detailTab === 'tools'" class="system-tools">
              <details v-for="tool in tools" :key="tool.name">
                <summary>
                  <strong>{{ tool.name }}</strong>
                  <span>{{ tool.description }}</span>
                </summary>
                <pre>{{ formatJson(tool.inputSchema) }}</pre>
              </details>
              <div v-if="Object.keys(tools).length === 0" class="search-empty">
                未注册工具
              </div>
            </div>
            <template v-else-if="detailTab === 'overview'">
              <dl class="detail-definitions">
                <dt>层级</dt>
                <dd>第 {{ turns.find(turn => turn.id === selectedItem?.runId)?.index }} 轮 / {{ selectedItem.step ? `步骤 ${selectedItem.step}` : '运行' }}</dd>
                <dt>状态</dt>
                <dd :class="`status-${selectedItem.status}`">
                  {{ statusLabel(selectedItem.status) }}
                </dd>
                <dt>事件序号</dt>
                <dd>#{{ selectedItem.sequence }}</dd>
              </dl>
              <section class="overview-block">
                <h3>参数</h3>
                <pre>{{ formatJson(selectedItem.input) }}</pre>
              </section>
              <section class="overview-block">
                <h3>结果</h3>
                <pre>{{ formatJson(selectedItem.output) }}</pre>
              </section>
            </template>
            <pre v-else-if="detailTab === 'input'" class="detail-code">{{ formatJson(selectedItem.input) }}</pre>
            <pre v-else-if="detailTab === 'output'" class="detail-code">{{ formatJson(selectedItem.output) }}</pre>
            <pre v-else-if="detailTab === 'schema'" class="detail-code">{{ formatJson(selectedItem.schema) }}</pre>
            <dl v-else class="detail-definitions timing">
              <dt>开始时间</dt>
              <dd>{{ formatTimestamp(selectedItem.startedAt) }}</dd>
              <dt>结束时间</dt>
              <dd>{{ formatTimestamp(selectedItem.endedAt) }}</dd>
              <dt>时长</dt>
              <dd>{{ formatDuration(selectedItem.durationMs) }}</dd>
              <dt>计时来源</dt>
              <dd>Agent 轨迹时间戳</dd>
            </dl>
          </div>
        </aside>
      </div>

      <footer class="trajectory-metrics" aria-label="轨迹汇总">
        <span>{{ metrics.turns }} 轮 · {{ metrics.steps }} 步 · {{ metrics.toolCalls }} 次工具调用</span>
        <span>总时长 {{ formatDuration(metrics.totalDuration) }}</span>
        <span v-if="metrics.firstToken !== undefined">首 token 平均 {{ formatDuration(metrics.firstToken) }}</span>
        <span>输入 {{ formatTokens(metrics.promptTokens) }} tok · 输出 {{ formatTokens(metrics.completionTokens) }} tok</span>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.trajectory-view {
  --trace-border: #e2e8f0;
  --trace-muted: #64748b;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: #1e293b;
  background: #fff;
}

.trajectory-toolbar {
  min-height: 43px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--trace-border);
  background: #f8fafc;
}

.trajectory-toolbar button {
  height: 30px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 6px;
  padding: 0 8px;
  color: #475569;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.trajectory-toolbar button:hover,
.trajectory-toolbar button[aria-pressed='true'] {
  color: #0f172a;
  background: #e2e8f0;
}

.trajectory-toolbar button:disabled {
  cursor: default;
  opacity: 0.5;
}

.toolbar-icon {
  width: 30px;
  justify-content: center;
  padding: 0 !important;
}

.trajectory-search {
  min-width: 120px;
  max-width: 260px;
  height: 30px;
  flex: 1 1 180px;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 0 8px;
  color: #94a3b8;
  background: #fff;
}

.trajectory-search:focus-within {
  border-color: #60a5fa;
  box-shadow: 0 0 0 2px rgb(59 130 246 / 10%);
}

.trajectory-search input {
  width: 100%;
  min-width: 0;
  border: 0;
  outline: 0;
  color: #334155;
  background: transparent;
  font: inherit;
  font-size: 12px;
}

.timeline-overview {
  min-height: 47px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--trace-border);
  background: #f8fafc;
}

.timeline-track {
  position: relative;
  height: 20px;
  flex: 1;
  overflow: hidden;
  border-radius: 4px;
  background: repeating-linear-gradient(90deg, #e2e8f0 0 1px, transparent 1px 5%);
}

.timeline-segment {
  position: absolute;
  top: 5px;
  height: 10px;
  min-width: 3px;
  border: 0;
  border-radius: 2px;
  cursor: pointer;
  transition:
    top 120ms ease,
    height 120ms ease,
    filter 120ms ease;
}

.timeline-segment:hover,
.timeline-segment.active {
  top: 3px;
  height: 14px;
  filter: brightness(0.9);
}

.kind-request,
.timeline-segment.kind-request {
  color: #475569;
  background: #94a3b8;
}

.kind-system,
.timeline-segment.kind-system {
  color: #334155;
  background: #64748b;
}

.kind-user,
.timeline-segment.kind-user {
  color: #0369a1;
  background: #38bdf8;
}

.kind-assistant,
.timeline-segment.kind-assistant {
  color: #6d28d9;
  background: #a78bfa;
}

.kind-tool,
.timeline-segment.kind-tool {
  color: #b45309;
  background: #f59e0b;
}

.load-earlier-dot {
  width: 27px;
  height: 27px;
  flex: 0 0 auto;
  border: 1px solid #cbd5e1;
  border-radius: 50%;
  color: #64748b;
  background: #fff;
  cursor: pointer;
}

.trajectory-workspace {
  min-height: 0;
  flex: 1;
  display: flex;
  overflow: hidden;
}

.event-pane {
  min-width: 0;
  flex: 1;
  overflow: auto;
  background: #fff;
}

.load-earlier-button {
  width: calc(100% - 24px);
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 10px 12px 3px;
  border: 1px dashed #cbd5e1;
  border-radius: 6px;
  color: #64748b;
  background: #f8fafc;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.trace-turn {
  border-bottom: 1px solid var(--trace-border);
}

.turn-boundary {
  width: 100%;
  min-height: 34px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  padding: 6px 12px;
  color: #64748b;
  background: #f8fafc;
  cursor: pointer;
  font: inherit;
  font-size: 10.5px;
  text-align: left;
}

.turn-boundary > div:last-child {
  margin-left: auto;
}

.turn-index {
  color: #334155;
  font-weight: 700;
}

.turn-status {
  padding: 2px 5px;
  border-radius: 4px;
  background: #e2e8f0;
}

.status-completed {
  color: #047857 !important;
}

.status-failed {
  color: #be123c !important;
}

.status-stopped {
  color: #b45309 !important;
}

.status-running {
  color: #0369a1 !important;
}

.event-row {
  position: relative;
  width: 100%;
  min-height: 43px;
  display: grid;
  grid-template-columns: 4px 48px minmax(0, 1fr) auto 16px;
  align-items: center;
  gap: 9px;
  border: 0;
  border-top: 1px solid #f1f5f9;
  padding: 6px 11px 6px 0;
  color: #334155;
  background: #fff;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.event-row:hover,
.event-row.selected {
  background: #f8fafc;
}

.event-row.selected {
  box-shadow: inset 0 0 0 1px #bfdbfe;
}

.event-row.compact {
  min-height: 32px;
}

.event-row.kind-request .event-rail {
  background: #94a3b8;
}

.event-row.kind-system .event-rail {
  background: #475569;
}

.event-row.kind-user .event-rail {
  background: #0ea5e9;
}

.event-row.kind-assistant .event-rail {
  background: #8b5cf6;
}

.event-row.kind-tool .event-rail {
  background: #f59e0b;
}

.event-row.kind-request .event-kind {
  color: #64748b;
}

.event-row.kind-system .event-kind {
  color: #334155;
}

.event-row.kind-user .event-kind {
  color: #0369a1;
}

.system-row {
  border-top: 0;
  border-bottom: 1px solid var(--trace-border);
}

.event-row.kind-assistant .event-kind {
  color: #7c3aed;
}

.event-row.kind-tool .event-kind {
  color: #b45309;
}

.event-rail {
  align-self: stretch;
  background: currentcolor;
}

.event-kind {
  justify-self: end;
  color: currentcolor;
  font-size: 10px;
  font-weight: 700;
}

.event-content {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 9px;
  overflow: hidden;
}

.event-content strong {
  flex: 0 0 auto;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.event-content span {
  overflow: hidden;
  color: #64748b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.event-duration {
  color: #94a3b8;
  font-size: 10px;
  white-space: nowrap;
}

.event-chevron {
  color: #cbd5e1;
}

.detail-pane {
  position: relative;
  min-width: 300px;
  max-width: min(52vw, 620px);
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--trace-border);
  background: #f8fafc;
}

.detail-resize {
  position: absolute;
  z-index: 2;
  inset: 0 auto 0 -4px;
  width: 8px;
  cursor: ew-resize;
  touch-action: none;
}

.detail-resize:hover {
  background: rgb(59 130 246 / 20%);
}

.detail-header {
  min-height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px 8px 13px;
  border-bottom: 1px solid var(--trace-border);
}

.detail-header > div {
  min-width: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 2px 7px;
}

.detail-header span {
  border-radius: 4px;
  padding: 2px 5px;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
}

.detail-header strong {
  overflow: hidden;
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-header small {
  grid-column: 1 / -1;
  color: #64748b;
  font-size: 10px;
}

.detail-header button {
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: 5px;
  color: #64748b;
  background: transparent;
  cursor: pointer;
}

.detail-header button:hover {
  background: #e2e8f0;
}

.detail-tabs {
  min-height: 38px;
  display: flex;
  align-items: end;
  gap: 15px;
  padding: 0 13px;
  border-bottom: 1px solid var(--trace-border);
  overflow-x: auto;
}

.detail-tabs button {
  height: 38px;
  flex: 0 0 auto;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 0;
  color: #64748b;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}

.detail-tabs button.active {
  border-bottom-color: #2563eb;
  color: #1d4ed8;
  font-weight: 700;
}

.detail-body {
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 13px;
}

.detail-definitions {
  display: grid;
  grid-template-columns: 82px minmax(0, 1fr);
  gap: 10px;
  margin: 0;
  font-size: 11px;
}

.detail-definitions dt {
  color: #64748b;
}

.detail-definitions dd {
  min-width: 0;
  margin: 0;
  color: #334155;
  overflow-wrap: anywhere;
}

.overview-block {
  margin-top: 17px;
}

.overview-block h3 {
  margin: 0 0 7px;
  color: #334155;
  font-size: 11px;
}

.overview-block pre,
.detail-code {
  margin: 0;
  color: #334155;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.overview-block pre {
  max-height: 210px;
  overflow: auto;
  border-top: 1px solid var(--trace-border);
  padding-top: 8px;
}

.system-prompt {
  line-height: 1.65;
}

.system-tools {
  display: grid;
  gap: 8px;
}

.system-tools details {
  border: 1px solid var(--trace-border);
  border-radius: 6px;
  background: #fff;
}

.system-tools summary {
  display: grid;
  gap: 3px;
  padding: 9px 10px;
  cursor: pointer;
  list-style-position: inside;
}

.system-tools summary strong {
  color: #1e293b;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.system-tools summary span {
  color: #64748b;
  font-size: 10.5px;
  line-height: 1.45;
}

.system-tools pre {
  margin: 0;
  overflow: auto;
  border-top: 1px solid var(--trace-border);
  padding: 9px 10px;
  color: #334155;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.trajectory-metrics {
  min-height: 31px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px 15px;
  padding: 6px 12px;
  border-top: 1px solid var(--trace-border);
  color: #64748b;
  background: #f8fafc;
  font-size: 10px;
  white-space: nowrap;
}

.trajectory-state,
.search-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 24px;
  color: #64748b;
  text-align: center;
  font-size: 12px;
}

.trajectory-state strong {
  color: #334155;
  font-size: 13px;
}

.trajectory-state.error {
  color: #b91c1c;
}

.trajectory-state button {
  border: 1px solid #fecaca;
  border-radius: 6px;
  padding: 5px 9px;
  color: #b91c1c;
  background: #fff;
  cursor: pointer;
}

.trajectory-spinner {
  width: 18px;
  height: 18px;
  border: 2px solid #cbd5e1;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: trajectory-spin 800ms linear infinite;
}

@keyframes trajectory-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 900px) {
  .toolbar-action span,
  .toolbar-toggle span,
  .event-duration {
    display: none;
  }

  .event-row {
    grid-template-columns: 4px 42px minmax(0, 1fr) 16px;
  }

  .detail-pane {
    position: absolute;
    inset: 0;
    width: 100% !important;
    min-width: 0;
    max-width: none;
    border-left: 0;
  }

  .trajectory-workspace {
    position: relative;
  }

  .detail-resize {
    display: none;
  }
}

@media (max-width: 560px) {
  .trajectory-toolbar {
    flex-wrap: wrap;
  }

  .trajectory-search {
    order: 2;
    max-width: none;
    flex-basis: 100%;
    margin-left: 0;
  }

  .timeline-overview {
    min-height: 39px;
  }

  .trajectory-metrics {
    justify-content: flex-start;
    overflow-x: auto;
  }
}

:global(html.dark) .trajectory-view {
  --trace-border: #334155;
  color: #cbd5e1;
  background: #0f172a;
}

:global(html.dark) .trajectory-toolbar,
:global(html.dark) .timeline-overview,
:global(html.dark) .turn-boundary,
:global(html.dark) .detail-pane,
:global(html.dark) .trajectory-metrics {
  background: #020617;
}

:global(html.dark) .trajectory-search,
:global(html.dark) .event-pane,
:global(html.dark) .event-row,
:global(html.dark) .load-earlier-dot {
  color: #cbd5e1;
  background: #0f172a;
}

:global(html.dark) .event-row:hover,
:global(html.dark) .event-row.selected,
:global(html.dark) .trajectory-toolbar button:hover,
:global(html.dark) .trajectory-toolbar button[aria-pressed='true'] {
  background: #1e293b;
}

:global(html.dark) .event-content strong,
:global(html.dark) .detail-header strong,
:global(html.dark) .system-tools summary strong,
:global(html.dark) .system-tools pre,
:global(html.dark) .trajectory-state strong,
:global(html.dark) .overview-block h3,
:global(html.dark) .detail-definitions dd,
:global(html.dark) .overview-block pre,
:global(html.dark) .detail-code {
  color: #e2e8f0;
}

:global(html.dark) .system-tools details {
  background: #0f172a;
}

:global(html.dark) .trajectory-search input {
  color: #e2e8f0;
}

@media (prefers-reduced-motion: reduce) {
  .trajectory-spinner {
    animation: none;
  }
}
</style>
