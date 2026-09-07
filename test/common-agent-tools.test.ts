import type { ToolExecutionEvent } from '../src/common-agent'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createCalculatorTool,
  createCurrentTimeTool,
  defineTool,
  executeTool,
  ToolError,
} from '../src/common-agent'

describe('defineTool', () => {
  it('keeps model schema and executable implementation in one definition', () => {
    const tool = defineTool({
      name: 'echo',
      description: '返回输入文本',
      inputSchema: z.strictObject({ text: z.string() }),
      outputSchema: z.strictObject({ text: z.string() }),
      security: { risk: 'safe', idempotent: true },
      execute: input => input,
    })

    expect(tool.model).toMatchObject({
      name: 'echo',
      description: '返回输入文本',
      inputSchema: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
      },
    })
    expect(tool.model).not.toHaveProperty('execute')
    expect(tool.outputJsonSchema).toMatchObject({
      type: 'object',
      required: ['text'],
    })
  })

  it('rejects retry configuration for a non-idempotent tool', () => {
    expect(() => defineTool({
      name: 'create_record',
      description: '创建记录',
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ id: z.string() }),
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      security: { risk: 'write', idempotent: false },
      execute: () => ({ id: 'record-1' }),
    })).toThrow('只有声明为幂等后才能配置 retry')
  })

  it('requires strict nested input objects so wire and runtime validation agree', () => {
    expect(() => defineTool({
      name: 'loose_echo',
      description: '模拟会剥离未知字段的宽松对象',
      inputSchema: z.strictObject({
        nested: z.object({ text: z.string() }),
      }),
      outputSchema: z.string(),
      security: { risk: 'safe', idempotent: true },
      execute: input => input.nested.text,
    })).toThrow('请使用 z.strictObject()')
  })
})

describe('executeTool', () => {
  it('validates model arguments before calling business code', async () => {
    const execute = vi.fn((input: { count: number }) => input.count)
    const tool = defineTool({
      name: 'count',
      description: '返回数量',
      inputSchema: z.strictObject({ count: z.number().int() }),
      outputSchema: z.number(),
      security: { risk: 'safe', idempotent: true },
      execute,
    })

    const result = await executeTool(tool, { count: 'three' }, { callId: 'call-1' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOOL_ARGUMENTS', retryable: false },
      attempts: 0,
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects a successful business value that violates outputSchema', async () => {
    const tool = defineTool({
      name: 'broken_count',
      description: '模拟上游返回错误字段类型',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ count: z.number() }),
      security: { risk: 'safe', idempotent: true },
      execute: () => JSON.parse('{"count":"wrong"}') as { count: number },
    })

    const result = await executeTool(tool, {}, { callId: 'call-2' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOOL_OUTPUT', retryable: false },
      attempts: 1,
    })
  })

  it('retries only explicitly retryable errors and records every attempt', async () => {
    const attempts: number[] = []
    const events: ToolExecutionEvent[] = []
    const tool = defineTool({
      name: 'unstable_read',
      description: '模拟临时上游错误',
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ value: z.string() }),
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
        jitterRatio: 0,
      },
      security: { risk: 'safe', idempotent: true },
      execute(_input, context) {
        attempts.push(context.attempt)
        if (context.attempt < 3) {
          throw new ToolError({
            code: 'UPSTREAM_TIMEOUT',
            message: '上游请求超时',
            retryable: true,
          })
        }
        return { value: 'ok' }
      },
    })

    const result = await executeTool(tool, {}, {
      callId: 'call-3',
      onEvent: event => events.push(event),
    })

    expect(result).toMatchObject({
      ok: true,
      value: { value: 'ok' },
      content: '{"value":"ok"}',
      attempts: 3,
    })
    expect(attempts).toEqual([1, 2, 3])
    expect(events.filter(event => event.type === 'tool.retry.scheduled')).toHaveLength(2)
    expect(events.at(-1)?.type).toBe('tool.call.completed')
  })

  it('fails closed when a capability-bearing tool has no runtime policy', async () => {
    const tool = defineTool({
      name: 'read_network',
      description: '读取网络资源',
      inputSchema: z.strictObject({ url: z.url() }),
      outputSchema: z.string(),
      security: {
        risk: 'read',
        capabilities: ['network:public'],
        idempotent: true,
      },
      execute: () => 'unreachable',
    })

    const result = await executeTool(tool, { url: 'https://example.com' }, {
      callId: 'call-4',
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'TOOL_PERMISSION_DENIED' },
      attempts: 0,
    })
  })

  it('treats a missing approval channel as denial', async () => {
    const events: ToolExecutionEvent[] = []
    const tool = defineTool({
      name: 'write_record',
      description: '写入记录',
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ saved: z.boolean() }),
      security: { risk: 'write', idempotent: false },
      execute: () => ({ saved: true }),
    })

    const result = await executeTool(tool, { value: 'hello' }, {
      callId: 'call-5',
      policy: {
        evaluate: () => ({ decision: 'ask', reason: '该操作会写入数据' }),
      },
      onEvent: event => events.push(event),
    })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'TOOL_PERMISSION_DENIED' },
    })
    expect(events.map(event => event.type)).toContain('tool.approval.requested')
    expect(events.find(event => event.type === 'tool.approval.decided')).toMatchObject({
      outcome: 'unavailable',
    })
  })

  it('turns a cooperative deadline into a retryable timeout error', async () => {
    const tool = defineTool({
      name: 'slow_tool',
      description: '等待到调用信号取消',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      timeoutMs: 5,
      security: { risk: 'safe', idempotent: true },
      execute(_input, context) {
        return new Promise((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(new Error('cancelled by signal'))
          }, { once: true })
        })
      },
    })

    const result = await executeTool(tool, {}, { callId: 'call-6' })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'TOOL_TIMEOUT', retryable: true },
      attempts: 1,
    })
  })

  it('contains trajectory listener failures', async () => {
    const tool = defineTool({
      name: 'observer_safe',
      description: '验证观察器不会改变业务结果',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      security: { risk: 'safe', idempotent: true },
      execute: () => 'ok',
    })

    const result = await executeTool(tool, {}, {
      callId: 'call-7',
      onEvent: () => {
        throw new Error('trace backend unavailable')
      },
    })

    expect(result).toMatchObject({ ok: true, value: 'ok' })
  })
})

describe('built-in tools', () => {
  it('returns deterministic current time through an injected clock', async () => {
    const tool = createCurrentTimeTool({
      clock: { now: () => new Date('2026-09-07T04:00:00Z') },
    })

    const result = await executeTool(tool, { timezone: 'Asia/Shanghai' }, {
      callId: 'time-1',
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        timezone: 'Asia/Shanghai',
        currentDatetime: '2026-09-07T12:00:00+08:00',
        date: '2026-09-07',
        time: '12:00:00',
      },
    })
  })

  it('performs structured arithmetic without evaluating code', async () => {
    const result = await executeTool(createCalculatorTool(), {
      operation: 'divide',
      values: [10, 4],
    }, { callId: 'calculator-1' })

    expect(result).toMatchObject({
      ok: true,
      value: {
        operation: 'divide',
        values: [10, 4],
        result: 2.5,
      },
    })
  })
})
