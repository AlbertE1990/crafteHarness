import { afterEach, describe, expect, it, vi } from 'vitest'
import { getTime, getUserLocation, getWeather } from '../src/server/func'
import { executeToolDefinition, ToolCallError } from '../src/server/tool-result'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

describe('server tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lets a tool return its raw business value', () => {
    const result = getTime({ amount: 0, unit: 'day', preset: null, timezone: 'Asia/Shanghai' })

    expect(result.timezone).toBe('Asia/Shanghai')
    expect(result.label).toContain('今天')
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

    const result = await getUserLocation({})

    expect(result).toMatchObject({
      city: '杭州市',
      accuracy: 'approximate_ip',
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('https://ipwho.is/')
  })

  it('geocodes a city and returns current weather', async () => {
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

    const result = await getWeather({ city: '杭州' })

    expect(result).toMatchObject({
      city: '杭州',
      weather: '毛毛雨',
      temperature_c: 25,
      humidity_percent: 81,
      wind_direction: '北风',
      wind_scale: 2,
    })
    expect(String(fetchMock.mock.calls[0][0])).toContain('geocoding-api.open-meteo.com')
    expect(String(fetchMock.mock.calls[1][0])).toContain('api.open-meteo.com')
  })

  it('throws invalid arguments for the Harness to normalize', async () => {
    await expect(getWeather({ city: 123 })).rejects.toThrow('city 必须是字符串或 null')
  })

  it('retries only when both the tool policy and error allow it', async () => {
    const execute = vi.fn()
      .mockRejectedValueOnce(new ToolCallError('UPSTREAM_TIMEOUT', '请求超时', true))
      .mockRejectedValueOnce(new ToolCallError('UPSTREAM_HTTP_ERROR', 'HTTP 503', true))
      .mockResolvedValue({ temperature_c: 25 })

    const result = await executeToolDefinition({
      execute,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    }, {})

    expect(execute).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({
      isError: false,
      value: { temperature_c: 25 },
      content: '{"temperature_c":25}',
      attempts: 3,
    })
  })

  it('renders a non-JSON tool value instead of rejecting a successful call', async () => {
    const circular: Record<string, unknown> = { temperature_c: 25n }
    circular.self = circular

    const result = await executeToolDefinition({ execute: () => circular }, {})

    expect(result.isError).toBe(false)
    expect(result.content).toContain('temperature_c: 25n')
    expect(result.content).toContain('[Circular')
  })

  it('does not retry parameter errors even when a tool has retry policy', async () => {
    const execute = vi.fn().mockRejectedValue(new TypeError('city 参数无效'))

    const result = await executeToolDefinition({
      execute,
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
    }, {})

    expect(execute).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      isError: true,
      error: { code: 'TOOL_EXECUTION_FAILED', retryable: false },
      attempts: 1,
    })
  })
})
