import type { ToolExecutionEvent } from '../src/craft-agent'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createCalculatorTool,
  createCurrentTimeTool,
  defineTool,
  executeTool,
  ToolError,
} from '../src/craft-agent'

describe('defineTool', () => {
  it('keeps model schema and executable implementation in one definition', () => {
    const tool = defineTool({
      name: 'echo',
      description: '返回输入文本',
      inputSchema: z.strictObject({ text: z.string() }),
      outputSchema: z.strictObject({ text: z.string() }),
      metadata: { category: 'example' },
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

  it('treats retry configuration as the tool author explicit repeat-execution decision', () => {
    const tool = defineTool({
      name: 'create_record',
      description: '创建记录',
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ id: z.string() }),
      execution: {
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      },
      execute: () => ({ id: 'record-1' }),
    })

    expect(tool.execution?.retry?.maxAttempts).toBe(2)
  })

  it('rejects removed security and top-level execution fields instead of silently accepting them', () => {
    const base = {
      name: 'legacy_tool',
      description: '验证旧字段不会成为隐藏兼容输入',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      execute: () => 'ok',
    }

    expect(() => defineTool({
      ...base,
      security: { risk: 'safe' },
    } as unknown as Parameters<typeof defineTool>[0])).toThrow('未知字段：security')
    expect(() => defineTool({
      ...base,
      timeoutMs: 1_000,
    } as unknown as Parameters<typeof defineTool>[0])).toThrow('未知字段：timeoutMs')
  })

  it('copies, freezes and validates arbitrary tool metadata', () => {
    const metadata = { risk: 'custom-level', nested: { owner: 'orders' } }
    const tool = defineTool({
      name: 'metadata_tool',
      description: '验证业务 metadata 边界',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      metadata,
      execute: () => 'ok',
    })

    expect(tool.metadata).toEqual(metadata)
    expect(tool.metadata).not.toBe(metadata)
    expect(Object.isFrozen(tool.metadata)).toBe(true)
    expect(Object.isFrozen(tool.metadata.nested)).toBe(true)
    expect(() => defineTool({
      name: 'invalid_metadata_tool',
      description: '拒绝不能序列化的 metadata',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      metadata: { invalid: () => 'no' },
      execute: () => 'ok',
    } as unknown as Parameters<typeof defineTool>[0])).toThrow('metadata 必须是可序列化 JSON 对象')
  })

  it('requires strict nested input objects so wire and runtime validation agree', () => {
    expect(() => defineTool({
      name: 'loose_echo',
      description: '模拟会剥离未知字段的宽松对象',
      inputSchema: z.strictObject({
        nested: z.object({ text: z.string() }),
      }),
      outputSchema: z.string(),
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
      execution: {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 0,
          maxDelayMs: 0,
          jitterRatio: 0,
        },
      },
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

  it('allows a tool directly when neither tool-level nor global Guard is configured', async () => {
    const tool = defineTool({
      name: 'read_network',
      description: '读取网络资源',
      inputSchema: z.strictObject({ url: z.url() }),
      outputSchema: z.string(),
      metadata: {
        risk: 'read',
        capabilities: ['network:public'],
      },
      execute: () => 'reachable',
    })

    const result = await executeTool(tool, { url: 'https://example.com' }, {
      callId: 'call-4',
    })

    expect(result).toMatchObject({
      ok: true,
      value: 'reachable',
      attempts: 1,
    })
  })

  it('runs tool and global Guards with run context, then applies deny over ask', async () => {
    interface RunContext {
      readonly tenantId: string
      readonly environment: 'test'
    }
    const inputSchema = z.strictObject({ resource: z.string() })
    const outputSchema = z.string()
    const order: string[] = []
    const execute = vi.fn(() => 'unreachable')
    const tool = defineTool<
      typeof inputSchema,
      typeof outputSchema,
      RunContext
    >({
      name: 'context_guarded_write',
      description: '验证两层 Guard 和运行上下文',
      inputSchema,
      outputSchema,
      metadata: { risk: 'write' },
      guard(request) {
        order.push(`tool:${request.context.tenantId}`)
        return { decision: 'ask', reason: '工具需要确认' }
      },
      execute,
    })

    const result = await executeTool(tool, { resource: 'record/1' }, {
      callId: 'call-context-guard',
      context: { tenantId: 'tenant-a', environment: 'test' },
      globalGuard(request) {
        order.push(`global:${request.context.tenantId}`)
        return { decision: 'deny', reason: '测试环境禁止写入' }
      },
    })

    expect(order).toEqual(['tool:tenant-a', 'global:tenant-a'])
    expect(result).toMatchObject({
      ok: false,
      attempts: 0,
      error: { code: 'TOOL_PERMISSION_DENIED', message: '测试环境禁止写入' },
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('passes the same run context to the allowed tool implementation', async () => {
    interface RunContext { readonly userId: string }
    const inputSchema = z.strictObject({})
    const outputSchema = z.string()
    const tool = defineTool<typeof inputSchema, typeof outputSchema, RunContext>({
      name: 'read_context',
      description: '读取当前运行上下文',
      inputSchema,
      outputSchema,
      execute: (_input, context) => context.context.userId,
    })

    await expect(executeTool(tool, {}, {
      callId: 'call-context-execute',
      context: { userId: 'user-1' },
    })).resolves.toMatchObject({ ok: true, value: 'user-1' })
  })

  it('treats a missing approval channel as denial', async () => {
    const events: ToolExecutionEvent[] = []
    const tool = defineTool({
      name: 'write_record',
      description: '写入记录',
      inputSchema: z.strictObject({ value: z.string() }),
      outputSchema: z.strictObject({ saved: z.boolean() }),
      execute: () => ({ saved: true }),
    })

    const result = await executeTool(tool, { value: 'hello' }, {
      callId: 'call-5',
      globalGuard: () => ({ decision: 'ask', reason: '该操作会写入数据' }),
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
      execution: { timeoutMs: 5 },
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
