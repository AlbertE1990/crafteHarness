import type { ExecuteToolOptions } from '../src/common-agent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineTool } from '../src/common-agent'
import {
  createServerToolRegistration,
  findServerTool,
  serverTools,
  trustedServerToolPolicy,
} from '../src/server/agent-tools'
import { getTime, getUserLocation, getWeather } from '../src/server/func'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

/** 通过服务端注册表调用工具，验证真实 Agent 使用的 CommonAgent 执行链。 */
async function invokeServerTool(
  name: string,
  rawInput: unknown,
  options: Partial<ExecuteToolOptions> = {},
) {
  const tool = findServerTool(name)
  if (!tool)
    throw new Error(`测试工具 ${name} 未注册`)

  return await tool.invoke(rawInput, {
    callId: `test-${name}`,
    policy: trustedServerToolPolicy,
    ...options,
  })
}

describe('server tools through CommonAgent', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('derives every model tool schema from its registered definition', () => {
    expect(serverTools.map(tool => tool.model.name)).toEqual([
      'get_user_location',
      'get_weather',
      'get_current_time',
    ])

    for (const tool of serverTools) {
      expect(tool.model.inputSchema).toMatchObject({
        type: 'object',
        additionalProperties: false,
      })
      expect(tool.model).not.toHaveProperty('execute')
    }
  })

  it('wraps a custom defineTool definition without changing Agent branches', async () => {
    const customTool = createServerToolRegistration(defineTool({
      name: 'echo_for_test',
      description: '返回测试文本。',
      inputSchema: z.strictObject({ text: z.string() }),
      outputSchema: z.strictObject({ text: z.string() }),
      security: { risk: 'safe', capabilities: [], idempotent: true },
      execute: input => input,
    }))

    const result = await customTool.invoke({ text: 'hello' }, {
      callId: 'custom-tool-call',
      policy: trustedServerToolPolicy,
    })

    expect(customTool.model.name).toBe('echo_for_test')
    expect(result).toMatchObject({
      ok: true,
      value: { text: 'hello' },
      content: '{"text":"hello"}',
    })
  })

  it('executes the built-in time tool through the CommonAgent result contract', async () => {
    const result = await invokeServerTool('get_current_time', {
      timezone: 'Asia/Shanghai',
    })

    expect(result).toMatchObject({
      ok: true,
      attempts: 1,
      value: {
        timezone: 'Asia/Shanghai',
        currentDatetime: expect.stringContaining('+08:00'),
      },
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

  it('geocodes a city and returns validated current weather', async () => {
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
      },
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('geocoding-api.open-meteo.com')
    expect(String(fetchMock.mock.calls[1][0])).toContain('api.open-meteo.com')
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

  it('retries retryable network errors through CommonAgent', async () => {
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

  it('keeps raw business functions available for focused unit tests', async () => {
    expect(getTime({ amount: 0, unit: 'day', preset: null, timezone: 'Asia/Shanghai' }).label)
      .toContain('今天')
    await expect(getUserLocation({ unexpected: true })).rejects.toThrow('不接受参数')
    await expect(getWeather({ city: 123 })).rejects.toThrow('city 必须是字符串或 null')
  })
})
