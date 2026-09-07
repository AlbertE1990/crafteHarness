import type {
  ModelAdapter,
  ModelFunctionToolCall,
  ModelMessage,
  ToolErrorInfo,
  ToolExecutionFailure,
} from '../common-agent'
import { randomUUID } from 'node:crypto'
import { ModelError } from '../common-agent'
import { AgentConfig } from './agent-config'
import {
  findServerTool,
  serverTools,
  trustedServerToolPolicy,
} from './agent-tools'

interface Conversation {
  id: string
  name: string
  createAt: string
  /** 发送给模型的完整上下文，包含 tool_calls 和 tool 结果。 */
  history: ModelMessage[]
  /** 仅供前端展示的精简历史，保留每轮最终回答及其思考内容。 */
  displayHistory: DisplayMessage[]
}

interface DisplayMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning_content?: string
}

interface PendingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

interface AgentTurnResult {
  content: string
  reasoning: string
}

/** 当前 Fastify Runtime 暴露给前端的流事件。 */
export type AgentStreamEvent
  = | { type: 'conversation', conversationId: string }
    | {
      type: 'message.delta'
      channel: 'reasoning' | 'content'
      delta: string
    }
    | {
      type: 'message.completed'
      conversationId: string
      content: string
      reasoning: string
    }

const conversations: Conversation[] = []

/** 返回当前进程内的会话快照；服务重启后内存数据会被清空。 */
export function getConversations() {
  return conversations
}

/** 根据会话 ID 查找上下文，未命中时由调用方按新会话处理。 */
function getConversation(conversationId: string) {
  return conversations.find(item => item.id === conversationId)
}

/** 使用第一条用户消息生成简短标题，避免额外调用一次模型。 */
function getConversationName(history: ModelMessage[]): string {
  const firstUserMessage = history.find(message => message.role === 'user')
  const content = firstUserMessage?.content
  return typeof content === 'string' && content.trim()
    ? content.trim().slice(0, 40)
    : '新对话'
}

/** 更新模型上下文和前端展示历史，或在首次完成回答后创建会话记录。 */
function storeMessages(
  conversationId: string,
  history: ModelMessage[],
  userContent: string,
  result: AgentTurnResult,
) {
  const conversation = getConversation(conversationId)
  if (conversation) {
    conversation.history = history
    conversation.displayHistory.push(
      { role: 'user', content: userContent },
      {
        role: 'assistant',
        content: result.content,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      },
    )
    return
  }

  conversations.push({
    id: conversationId,
    name: getConversationName(history),
    createAt: new Date().toISOString(),
    history,
    displayHistory: [
      { role: 'user', content: userContent },
      {
        role: 'assistant',
        content: result.content,
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
      },
    ],
  })
}

/** 将未知异常统一转换为可写入工具结果或 SSE 错误事件的文本。 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 模型工具参数必须先从 JSON 文本解析为 CommonAgent 接收的 unknown 输入。 */
function parseToolArguments(argumentsText: string):
  | { readonly ok: true, readonly value: unknown }
  | { readonly ok: false, readonly error: ToolErrorInfo } {
  try {
    return {
      ok: true,
      value: JSON.parse(argumentsText || '{}'),
    }
  }
  catch (error) {
    return {
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: getErrorMessage(error),
        retryable: false,
      },
    }
  }
}

/** 为工具查找或 JSON 解析等调用前错误构造统一失败结果。 */
function createToolFailure(error: ToolErrorInfo): ToolExecutionFailure {
  return {
    ok: false,
    error,
    content: `Error: ${error.message}`,
    attempts: 0,
    durationMs: 0,
  }
}

/** 使用标准 ModelAdapter 与 CommonAgent Tool Harness 驱动当前过渡执行循环。 */
export class Agent {
  private readonly config: AgentConfig
  private readonly modelAdapter: ModelAdapter
  private readonly messages: ModelMessage[]

  /**
   * 每个请求使用独立 Agent，历史消息会在 chatStream 中按会话 ID 恢复。
   * 内置或自定义 ModelAdapter 都由统一配置创建，不提供平行构造入口。
   */
  constructor(config: AgentConfig = AgentConfig.fromEnv()) {
    this.config = config
    this.modelAdapter = config.createModelAdapter()
    this.messages = [
      { role: 'system', content: config.systemPrompt },
    ]
  }

  /**
   * 启动一次对话流：先告知前端会话 ID，再持续输出增量文本和完成事件。
   * 未传 conversationId 时会生成新 ID，这也是前端创建新会话的入口。
   */
  async* chatStream(
    input: string,
    conversationId?: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent> {
    const message = input.trim()
    if (!message)
      throw new Error('消息不能为空')

    const id = conversationId || `chat-${randomUUID()}`
    const history = getConversation(id)?.history ?? []
    this.messages.push(...history, { role: 'user', content: message })

    yield { type: 'conversation', conversationId: id }

    const result = yield* this.runStream(id, signal)
    storeMessages(id, this.messages.slice(1), message, result)

    yield {
      type: 'message.completed',
      conversationId: id,
      content: result.content,
      reasoning: result.reasoning,
    }
  }

  /** 通过供应商无关 Adapter 创建标准模型流，并透传客户端中断信号。 */
  private createStream(signal?: AbortSignal) {
    return this.modelAdapter.stream({
      // Adapter 获得调用开始时的快照，不能观察后续工具或助手消息对数组的修改。
      messages: [...this.messages],
      tools: serverTools.map(tool => tool.model),
    }, { signal })
  }

  /**
   * 执行一个完整工具调用。业务工具只返回原始值或抛出异常，Harness 在这里统一
   * 完成输入输出校验、权限、重试、内容投影及错误归一化，再以 role=tool 写回模型上下文。
   */
  private async executeToolCall(
    toolCall: ModelFunctionToolCall,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    const tool = findServerTool(toolCall.function.name)
    let execution

    if (!tool) {
      execution = createToolFailure({
        code: 'TOOL_NOT_FOUND',
        message: `工具 ${toolCall.function.name} 不存在`,
        retryable: false,
      })
    }
    else {
      const parsedArguments = parseToolArguments(toolCall.function.arguments)
      if (!parsedArguments.ok) {
        execution = createToolFailure(parsedArguments.error)
      }
      else {
        execution = await tool.invoke(parsedArguments.value, {
          callId: toolCall.id,
          sessionId,
          ...(signal ? { signal } : {}),
          policy: trustedServerToolPolicy,
          ...(this.config.onToolEvent ? { onEvent: this.config.onToolEvent } : {}),
        })
      }
    }

    this.messages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      // Chat Completions 的工具结果必须是字符串；内部诊断外壳不暴露给模型。
      content: execution.content,
    })
  }

  /**
   * 消费模型流并驱动多轮工具调用，直到得到最终文本或达到最大轮数。
   * 返回值供 done 事件兜底使用，yield 的 delta 则用于前端实时渲染。
   */
  private async* runStream(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<AgentStreamEvent, AgentTurnResult> {
    let accumulatedReasoning = ''

    for (let step = 1; step <= this.config.maxModelSteps; step++) {
      const stream = await this.createStream(signal)
      const pendingToolCalls = new Map<number, PendingToolCall>()
      let assistantContent = ''
      let turnReasoning = ''

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta
        if (!delta)
          continue

        const reasoningDelta = delta.reasoning_content ?? ''
        if (reasoningDelta) {
          // 多次工具调用会产生多段独立思考，用空行分隔后统一展示给前端。
          const separator = !turnReasoning && accumulatedReasoning ? '\n\n' : ''
          turnReasoning += reasoningDelta
          accumulatedReasoning += separator + reasoningDelta
          yield {
            type: 'message.delta',
            channel: 'reasoning',
            delta: separator + reasoningDelta,
          }
        }

        if (delta.content) {
          assistantContent += delta.content
          yield { type: 'message.delta', channel: 'content', delta: delta.content }
        }

        // 流式响应会把同一次工具调用的名称和 JSON 参数拆到多个 chunk 中。
        for (const fragment of delta.tool_calls ?? []) {
          if (!('function' in fragment)) {
            throw new ModelError({
              code: 'MODEL_PROTOCOL_ERROR',
              message: '当前 Agent 尚不支持自定义文本工具调用',
              provider: this.modelAdapter.provider,
            })
          }
          if (!fragment.function)
            continue

          const pending = pendingToolCalls.get(fragment.index) ?? {
            index: fragment.index,
            id: '',
            name: '',
            arguments: '',
          }
          pending.id ||= fragment.id ?? ''
          pending.name += fragment.function.name ?? ''
          pending.arguments += fragment.function.arguments ?? ''
          pendingToolCalls.set(fragment.index, pending)
        }
      }

      const toolCalls: ModelFunctionToolCall[] = [...pendingToolCalls.values()]
        .sort((left, right) => left.index - right.index)
        .map((tool) => {
          if (!tool.id || !tool.name) {
            throw new ModelError({
              code: 'MODEL_PROTOCOL_ERROR',
              message: '模型返回了不完整的工具调用',
              provider: this.modelAdapter.provider,
            })
          }

          return {
            id: tool.id,
            type: 'function',
            function: {
              name: tool.name,
              arguments: tool.arguments,
            },
          }
        })

      if (toolCalls.length > 0) {
        // OpenAI 协议要求先写入包含 tool_calls 的 assistant 消息，再追加对应 tool 结果。
        this.messages.push({
          role: 'assistant',
          content: assistantContent || '',
          reasoning_content: turnReasoning,
          tool_calls: toolCalls,
        })

        for (const toolCall of toolCalls)
          await this.executeToolCall(toolCall, sessionId, signal)

        continue
      }

      if (assistantContent) {
        this.messages.push({
          role: 'assistant',
          content: assistantContent,
          reasoning_content: turnReasoning,
        })
        return { content: assistantContent, reasoning: accumulatedReasoning }
      }
    }

    const fallback = '达到最大循环数，未能生成最终回答'
    this.messages.push({ role: 'assistant', content: fallback })
    yield { type: 'message.delta', channel: 'content', delta: fallback }
    return { content: fallback, reasoning: accumulatedReasoning }
  }
}
