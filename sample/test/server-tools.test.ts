import type { ExecuteToolOptions } from 'craft-harness'
import { defineAgentConfig, defineTool } from 'craft-harness'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ScriptedModelAdapter } from '../../test/support/scripted-model-adapter'
import {
  manageRuntimeResourceTool,
  serverToolGuard,
  serverTools,
} from '../src/server/agent-tools'
import { getTime, getUserLocation, getWeather } from '../src/server/func'

/** 通过真实 Agent 配置边界把服务端原始 DefinedTool 归一化为 Harness 注册项。 */
const registeredServerTools = defineAgentConfig({
  adapter: new ScriptedModelAdapter({ script: [] }),
  model: { id: 'scripted-model' },
  tools: { mode: 'replace', tools: serverTools },
}).tools.registered

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function dailyForecast(days: number) {
  return {
    time: Array.from({ length: days }, (_, index) => `2026-09-${String(index + 6).padStart(2, '0')}`),
    weather_code: Array.from({ length: days }, (_, index) => index === 0 ? 51 : 3),
    temperature_2m_max: Array.from({ length: days }, (_, index) => 30 - index),
    temperature_2m_min: Array.from({ length: days }, (_, index) => 22 - index),
    apparent_temperature_max: Array.from({ length: days }, (_, index) => 33 - index),
    apparent_temperature_min: Array.from({ length: days }, (_, index) => 24 - index),
    precipitation_probability_max: Array.from({ length: days }, (_, index) => 60 - index * 5),
    precipitation_sum: Array.from({ length: days }, (_, index) => 2.5 + index),
    wind_speed_10m_max: Array.from({ length: days }, (_, index) => 12 + index),
    wind_direction_10m_dominant: Array.from({ length: days }, (_, index) => index * 45),
    sunrise: Array.from({ length: days }, (_, index) => `2026-09-${String(index + 6).padStart(2, '0')}T05:40`),
    sunset: Array.from({ length: days }, (_, index) => `2026-09-${String(index + 6).padStart(2, '0')}T18:10`),
  }
}

/** 通过服务端注册表调用工具，验证真实 Agent 使用的 CraftAgent 执行链。 */
async function invokeServerTool(
  name: string,
  rawInput: unknown,
  options: Partial<ExecuteToolOptions> = {},
) {
  const tool = registeredServerTools.find(item => item.name === name)
  if (!tool)
    throw new Error(`测试工具 ${name} 未注册`)

  return await tool.execute(rawInput, {
    callId: `test-${name}`,
    // 本辅助函数只测试工具业务边界；参数级 Guard 决定由下面的独立测试覆盖。
    globalGuard: () => ({ decision: 'allow' }),
    ...options,
  })
}

describe('server tools through CraftAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('derives every model tool schema from its registered definition', () => {
    expect(registeredServerTools.map(tool => tool.model.name)).toEqual([
      'get_user_location',
      'get_weather',
      'search_craft_harness_docs',
      'manage_runtime_resource',
    ])

    for (const tool of registeredServerTools) {
      expect(tool.model.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      })
      expect(tool.model).not.toHaveProperty('execute')
    }
  })

  it('wraps a custom defineTool definition without changing Agent branches', async () => {
    const definition = defineTool({
      name: 'echo_for_test',
      description: '返回测试文本。',
      inputSchema: z.strictObject({ text: z.string() }),
      outputSchema: z.strictObject({ text: z.string() }),
      execute: input => input,
    })
    const [customTool] = defineAgentConfig({
      adapter: new ScriptedModelAdapter({ script: [] }),
      model: { id: 'scripted-model' },
      tools: { mode: 'replace', tools: [definition] },
    }).tools.registered
    if (!customTool)
      throw new Error('测试工具注册失败')

    const result = await customTool.execute({ text: 'hello' }, {
      callId: 'custom-tool-call',
      globalGuard: () => ({ decision: 'allow' }),
    })

    expect(customTool.model.name).toBe('echo_for_test')
    expect(result).toMatchObject({
      ok: true,
      value: { text: 'hello' },
      content: '{"text":"hello"}',
    })
  })

  it('gets an approximate user location from the IP service', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      ip: '203.0.113.42',
      country: '中国',
      region: '浙江省',
      city: '杭州市',
      latitude: 30.2741,
      longitude: 120.1551,
      timezone: { id: 'Asia/Shanghai' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeServerTool('get_user_location', {})

    expect(result).toMatchObject({
      ok: true,
      value: {
        city: '杭州市',
        accuracy: 'approximate_ip',
      },
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://ipwho.is/')
  })

  it('geocodes a city and defaults to one day of validated weather', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        results: [{
          name: '杭州',
          admin1: '浙江',
          country: '中国',
          latitude: 30.29365,
          longitude: 120.16142,
          timezone: 'Asia/Shanghai',
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        timezone: 'Asia/Shanghai',
        current: {
          time: '2026-09-06T20:30',
          temperature_2m: 25,
          apparent_temperature: 28.4,
          relative_humidity_2m: 81,
          weather_code: 51,
          wind_speed_10m: 8.5,
          wind_direction_10m: 5,
        },
        daily: dailyForecast(1),
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeServerTool('get_weather', { city: '杭州' })

    expect(result).toMatchObject({
      ok: true,
      value: {
        city: '杭州',
        weather: '毛毛雨',
        temperature_c: 25,
        humidity_percent: 81,
        wind_direction: '北风',
        wind_scale: 2,
        forecast_days: 1,
        forecast: [{
          date: '2026-09-06',
          weather: '毛毛雨',
          temperature_max_c: 30,
          temperature_min_c: 22,
          precipitation_probability_percent: 60,
        }],
      },
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('geocoding-api.open-meteo.com')
    expect(String(fetchMock.mock.calls[1][0])).toContain('api.open-meteo.com')
    expect(new URL(String(fetchMock.mock.calls[1][0])).searchParams.get('forecast_days')).toBe('1')
  })

  it('requests and returns the user-selected seven-day forecast', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        results: [{
          name: '杭州',
          admin1: '浙江',
          country: '中国',
          latitude: 30.29365,
          longitude: 120.16142,
          timezone: 'Asia/Shanghai',
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        timezone: 'Asia/Shanghai',
        current: {
          time: '2026-09-06T20:30',
          temperature_2m: 25,
          apparent_temperature: 28.4,
          relative_humidity_2m: 81,
          weather_code: 51,
          wind_speed_10m: 8.5,
          wind_direction_10m: 5,
        },
        daily: dailyForecast(7),
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeServerTool('get_weather', { city: '杭州', days: 7 })
    const weatherUrl = new URL(String(fetchMock.mock.calls[1][0]))

    expect(weatherUrl.searchParams.get('forecast_days')).toBe('7')
    expect(weatherUrl.searchParams.get('daily')).toContain('temperature_2m_max')
    expect(result).toMatchObject({
      ok: true,
      value: {
        forecast_days: 7,
      },
    })
    if (!result.ok)
      throw new Error('天气工具调用失败')
    const { forecast } = result.value as { forecast: Array<{ date: string, weather: string }> }
    expect(forecast).toHaveLength(7)
    expect(forecast.slice(0, 2)).toMatchObject([
      { date: '2026-09-06', weather: '毛毛雨' },
      { date: '2026-09-07', weather: '阴' },
    ])
  })

  it('rejects invalid model arguments before starting a tool attempt', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeServerTool('get_weather', { city: 123 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOOL_ARGUMENTS' },
      attempts: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects forecast days outside the supported range', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeServerTool('get_weather', { city: '杭州', days: 8 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'INVALID_TOOL_ARGUMENTS' },
      attempts: 0,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries retryable network errors through CraftAgent', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        ip: '203.0.113.42',
        country: '中国',
        region: '浙江省',
        city: '杭州市',
        latitude: 30.2741,
        longitude: 120.1551,
        timezone: { id: 'Asia/Shanghai' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeServerTool('get_user_location', {}, {
      random: () => 0,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      ok: true,
      attempts: 2,
      value: { city: '杭州市' },
    })
  })

  it('uses validated arguments to allow reads, ask for writes and deny protected deletes', async () => {
    // 直接调用工具自己的参数级 Guard，并补齐 Agent 正常提供的关联上下文。
    // 参数类型从 Guard 签名推导，避免把工具的真实输入契约退化成 unknown。
    type GuardInput = Parameters<NonNullable<typeof manageRuntimeResourceTool.guard>>[0]['input']
    const evaluate = async (input: GuardInput) => await manageRuntimeResourceTool.guard!({
      runId: 'run-server-tool',
      sessionId: 'session-server-tool',
      callId: 'call-server-tool',
      tool: {
        name: manageRuntimeResourceTool.name,
        description: manageRuntimeResourceTool.description,
        inputSchema: manageRuntimeResourceTool.model.inputSchema,
        metadata: manageRuntimeResourceTool.metadata,
      },
      input,
      context: undefined,
      signal: new AbortController().signal,
    })

    await expect(evaluate({
      operation: 'read',
      resource: 'demo/approval-test',
      content: null,
    })).resolves.toEqual({ decision: 'allow' })
    await expect(evaluate({
      operation: 'write',
      resource: 'demo/approval-test',
      content: 'approved value',
    })).resolves.toMatchObject({
      decision: 'ask',
      reason: expect.stringContaining('写入'),
      approvalTimeoutMs: 45_000,
    })
    await expect(evaluate({
      operation: 'delete',
      resource: 'protected/system',
      content: null,
    })).resolves.toEqual({
      decision: 'deny',
      reason: '受保护资源 protected/system 禁止删除',
    })

    // 当前服务的全局 Guard 只约束部署允许的工具集合，不重复实现参数级规则。
    expect(serverToolGuard({
      runId: 'run-server-tool',
      sessionId: 'session-server-tool',
      callId: 'call-server-tool',
      tool: {
        name: manageRuntimeResourceTool.name,
        description: manageRuntimeResourceTool.description,
        inputSchema: manageRuntimeResourceTool.model.inputSchema,
        metadata: manageRuntimeResourceTool.metadata,
      },
      input: { operation: 'write' },
      context: undefined,
      signal: new AbortController().signal,
    })).toEqual({ decision: 'allow' })
  })

  it('retrieves official Craft Harness development documentation without arbitrary paths', async () => {
    const result = await invokeServerTool('search_craft_harness_docs', {
      query: '如何使用 defineTool 开发自定义工具',
      limit: 4,
    })

    expect(result).toMatchObject({ ok: true })
    if (!result.ok)
      throw new Error(result.error.message)
    const value = result.value as { matches: Array<{ source: string }> }
    expect(value.matches).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'docs/learning/custom-tool-development.md',
      }),
    ]))
    expect(value.matches.every(match => (
      match.source === 'README.md'
      || match.source.startsWith('docs/learning/')
      || match.source.startsWith('docs/standards/')
    ))).toBe(true)
  })

  it('shares runtime resources across sessions in one scope but isolates other scopes', async () => {
    const resource = 'demo/scope-isolation-test'
    const createContext = (scopeId: string, sessionId: string) => ({
      callId: `call-${scopeId}-${sessionId}`,
      scopeId,
      sessionId,
      attempt: 1,
      context: undefined,
      signal: new AbortController().signal,
    })

    await manageRuntimeResourceTool.execute({
      operation: 'write',
      resource,
      content: 'session A value',
    }, createContext('scope-a', 'session-a'))

    expect(manageRuntimeResourceTool.execute({
      operation: 'read',
      resource,
      content: null,
    }, createContext('scope-b', 'session-b'))).toMatchObject({ existed: false, value: null })
    expect(manageRuntimeResourceTool.execute({
      operation: 'read',
      resource,
      content: null,
    }, createContext('scope-a', 'session-c'))).toMatchObject({
      existed: true,
      value: 'session A value',
    })
  })

  it('keeps raw business functions available for focused unit tests', async () => {
    expect(getTime({ amount: 0, unit: 'day', preset: null, timezone: 'Asia/Shanghai' }).label)
      .toContain('今天')
    await expect(getUserLocation({ unexpected: true })).rejects.toThrow('不接受参数')
    await expect(getWeather({ city: 123 })).rejects.toThrow('city 必须是字符串或 null')
  })
})
