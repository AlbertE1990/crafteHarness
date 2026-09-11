// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import Agent, {
  createCurrentTimeTool,
  defineTool,
  executeTool,
  MemorySessionStore,
  SUPPORTED_LOCALES,
} from '../src'
import { OpenAICompatibleAdapter } from '../src/adapters'
import { ScriptedModelAdapter } from './support/scripted-model-adapter'

const MODEL = Object.freeze({ id: 'scripted-model' })

describe('localized diagnostics', () => {
  it('keeps Chinese as the default and isolates locale per Agent instance', async () => {
    const adapter = new ScriptedModelAdapter({ script: [] })
    const chinese = new Agent({ adapter, model: MODEL })
    const english = new Agent({ adapter, model: MODEL, locale: 'en-US' })

    await expect(chinese.invoke({ input: '', scopeId: 'scope' }))
      .rejects
      .toThrow('Agent request.input 不能为空')
    await expect(english.invoke({ input: '', scopeId: 'scope' }))
      .rejects
      .toThrow('Agent request.input cannot be empty')
    expect(SUPPORTED_LOCALES).toEqual(['zh-CN', 'en-US'])
  })

  it('propagates the Agent locale through model and tool call options', async () => {
    const adapter = new ScriptedModelAdapter({
      script: [{
        method: 'complete',
        result: {
          id: 'completion-localized',
          choices: [{
            finish_reason: 'stop',
            index: 0,
            logprobs: null,
            message: { role: 'assistant', content: 'ok' },
          }],
          created: 1,
          model: 'scripted-model',
          object: 'chat.completion',
        },
      }],
    })
    const agent = new Agent({ adapter, model: MODEL, locale: 'en-US' })
    await agent.invoke({ input: 'hello', scopeId: 'scope' })
    expect(adapter.calls[0]?.options.locale).toBe('en-US')

    const localeTool = defineTool({
      name: 'read_locale',
      description: 'read locale',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      execute: (_input, context) => context.locale,
    })
    const result = await executeTool(localeTool, {}, { callId: 'call-locale', locale: 'en-US' })
    expect(result).toMatchObject({ ok: true, value: 'en-US' })
  })

  it('localizes standalone tool registration and execution failures', async () => {
    const invalidDefinition = {
      name: 'echo',
      description: 'echo',
      inputSchema: z.strictObject({}),
      outputSchema: z.string(),
      execute: () => 'ok',
      removedField: true,
    }
    expect(() => defineTool(
      invalidDefinition as unknown as Parameters<typeof defineTool>[0],
      { locale: 'en-US' },
    )).toThrow('Tool definition contains unknown field: removedField')

    const tool = defineTool({
      name: 'echo',
      description: 'echo',
      inputSchema: z.strictObject({ text: z.string() }),
      outputSchema: z.string(),
      execute: input => input.text,
    })
    const result = await executeTool(tool, {}, { callId: 'call-1', locale: 'en-US' })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_TOOL_ARGUMENTS',
        message: 'Tool echo arguments failed validation',
      },
    })
  })

  it('localizes built-in tool, session store, and adapter diagnostics', async () => {
    const timeResult = await executeTool(
      createCurrentTimeTool({ locale: 'en-US' }),
      { timezone: 'Invalid/Timezone' },
      { callId: 'call-time', locale: 'en-US' },
    )
    expect(timeResult).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TIMEZONE' },
    })
    expect(timeResult.ok ? '' : timeResult.error.message)
      .toContain('Unsupported IANA timezone')

    const store = new MemorySessionStore({ locale: 'en-US' })
    await expect(store.append({
      scopeId: 'scope',
      sessionId: 'session',
      expectedVersion: 0,
      events: [],
    })).rejects.toThrow('events must contain at least one Session Event')

    expect(() => new OpenAICompatibleAdapter({
      apiKey: '',
      locale: 'en-US',
    })).toThrow('openai apiKey cannot be empty')
  })

  it('rejects unsupported locales without silently selecting a language', () => {
    expect(() => new Agent({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: MODEL,
      locale: 'fr-FR',
    } as unknown as ConstructorParameters<typeof Agent>[0])).toThrow('Unsupported locale: fr-FR')
  })
})
