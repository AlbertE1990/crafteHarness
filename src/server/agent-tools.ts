import type {
  ToolPolicy,
} from '../craft-agent'
import { z } from 'zod'
import {
  defineTool,
  defineTools,
} from '../craft-agent'
import { getUserLocation, getWeather } from './func'

/** 只读网络工具共用的自动重试策略。 */
const NETWORK_RETRY_POLICY = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  backoff: 'exponential' as const,
  jitterRatio: 0.2,
})

/** 通过服务器出口 IP 查询近似位置。 */
export const getUserLocationTool = defineTool({
  name: 'get_user_location',
  description: '通过服务器出口 IP 查询用户的近似位置，适用于本地运行或服务器与用户位于同一网络区域的场景；它不是浏览器 GPS 精确定位。',
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({
    ip: z.string(),
    country: z.string(),
    province: z.string(),
    city: z.string(),
    district: z.string().nullable(),
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    timezone: z.string().nullable(),
    accuracy: z.literal('approximate_ip'),
  }),
  timeoutMs: 10_000,
  retry: NETWORK_RETRY_POLICY,
  security: {
    risk: 'read',
    capabilities: ['network:public'],
    idempotent: true,
  },
  async execute(input, context) {
    return await getUserLocation(input, context)
  },
})

/** 查询指定城市或服务器近似所在地的当前天气。 */
export const getWeatherTool = defineTool({
  name: 'get_weather',
  description: '查询当前天气。用户指定城市时传入 city；未指定时传 null，工具会在内部通过 IP 近似定位，无需先调用 get_user_location。',
  inputSchema: z.strictObject({
    city: z.string()
      .min(1)
      .nullable()
      .describe('要查询的城市；用户未指定城市时传 null。'),
  }),
  outputSchema: z.strictObject({
    city: z.string(),
    province: z.string().nullable(),
    country: z.string(),
    latitude: z.number().finite(),
    longitude: z.number().finite(),
    timezone: z.string().nullable(),
    weather: z.string(),
    weather_code: z.number().finite(),
    temperature_c: z.number().finite(),
    feels_like_c: z.number().finite(),
    humidity_percent: z.number().finite(),
    wind_direction: z.string(),
    wind_speed_kmh: z.number().finite(),
    wind_scale: z.number().finite(),
    observed_at: z.string(),
  }),
  timeoutMs: 20_000,
  retry: NETWORK_RETRY_POLICY,
  security: {
    risk: 'read',
    capabilities: ['network:public'],
    idempotent: true,
  },
  async execute(input, context) {
    return await getWeather(input, context)
  },
})

/**
 * 当前服务明确注册的第一方工具。
 *
 * 开发自定义工具时先使用 defineTool() 创建定义，再把定义加入此列表；AgentLoop 会自动把
 * `tool.model` 发送给模型，并通过 CraftAgent Harness 执行对应实现。
 */
export const serverTools = defineTools(
  getUserLocationTool,
  getWeatherTool,
)

/**
 * 当前 Runtime 对静态注册第一方工具使用的许可策略。
 *
 * 该策略只服务当前开发验证，不代表第三方插件安全模型；工具注册来源由服务端代码控制。
 */
export const trustedServerToolPolicy: ToolPolicy = Object.freeze({
  evaluate: () => ({ decision: 'allow' as const }),
})
